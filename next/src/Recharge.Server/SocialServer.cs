using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace Recharge.Server
{
    /// <summary>The HTTP + WebSocket front of <see cref="SocialService"/> (HttpListener, no ASP.NET).</summary>
    public sealed class SocialServer : IDisposable
    {
        private static readonly JsonSerializerOptions ApiJson = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

        private sealed class Conn
        {
            public int Id;
            public string UserKey = "";
            public string Name = "";
            public Channel<string> Out = Channel.CreateBounded<string>(new BoundedChannelOptions(512) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
            public WebSocket? Socket;
            // Long-poll sessions: pushes are numbered and kept here until the client asks for them.
            public bool IsPoll;
            public string Sid = "";
            public readonly List<(long Seq, string Json)> Buffer = new List<(long, string)>();
            public long NextSeq = 1;
            public DateTimeOffset LastPoll;
            public TaskCompletionSource<bool> Signal = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        private const int MaxPollBuffer = 500;
        private static readonly TimeSpan PollIdle = TimeSpan.FromSeconds(45);

        private readonly SocialOptions _o;
        private readonly IHubDirectory _hub;
        private readonly HttpListener _listener = new HttpListener();
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private readonly object _connLock = new object();
        private readonly Dictionary<string, List<Conn>> _conns = new Dictionary<string, List<Conn>>(StringComparer.Ordinal);
        private readonly RateLimiter _apiLimit;
        private readonly RateLimiter _anonLimit;
        private Task _accept = Task.CompletedTask;
        private Timer? _reaper;
        private int _nextConn;

        public SocialService Service { get; }
        public int Port { get; private set; }

        public SocialServer(SocialOptions options, IHubDirectory hub, IShareSigner signer)
        {
            _o = options;
            _hub = hub;
            Service = new SocialService(options, signer);
            Service.Push += Deliver;
            _apiLimit = new RateLimiter(options.ApiPerMinute, TimeSpan.FromMinutes(1), options.Clock);
            _anonLimit = new RateLimiter(60, TimeSpan.FromMinutes(1), options.Clock);
        }

        public void Start()
        {
            int port = _o.Port;
            if (port == 0)
            {
                var probe = new TcpListener(IPAddress.Loopback, 0);
                probe.Start();
                port = ((IPEndPoint)probe.LocalEndpoint).Port;
                probe.Stop();
            }
            Port = port;
            _listener.Prefixes.Add("http://" + _o.Host + ":" + port + "/");
            _listener.Start();
            _accept = Task.Run(AcceptLoop);
            _reaper = new Timer(_ => ReapPolls(), null, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5));
        }

        /// <summary>Ends long-poll sessions whose client stopped asking (the app went away): they count as offline.</summary>
        private void ReapPolls()
        {
            DateTimeOffset now = _o.Clock();
            var dead = new List<Conn>();
            lock (_connLock)
            {
                foreach (var kv in _conns.ToList())
                {
                    foreach (Conn c in kv.Value.ToList())
                    {
                        if (c.IsPoll && now - c.LastPoll > PollIdle) { kv.Value.Remove(c); dead.Add(c); }
                    }
                    if (kv.Value.Count == 0) _conns.Remove(kv.Key);
                }
            }
            foreach (Conn c in dead) Service.Disconnect(c.Name, c.Id);
        }

        public void Dispose()
        {
            try { _cts.Cancel(); } catch (ObjectDisposedException) { }
            _reaper?.Dispose();
            try { _listener.Stop(); } catch (ObjectDisposedException) { }
            List<Conn> all;
            lock (_connLock) all = _conns.Values.SelectMany(x => x).ToList();
            foreach (Conn c in all) { try { c.Socket?.Abort(); } catch (ObjectDisposedException) { } }
            try { _accept.Wait(2000); } catch (AggregateException) { }
            Service.Dispose();
        }

        private async Task AcceptLoop()
        {
            while (!_cts.IsCancellationRequested)
            {
                HttpListenerContext ctx;
                try { ctx = await _listener.GetContextAsync().ConfigureAwait(false); }
                catch (HttpListenerException) { break; }
                catch (ObjectDisposedException) { break; }
                catch (InvalidOperationException) { break; }
                _ = Task.Run(() => Handle(ctx));
            }
        }

        // ---- pushes ----

        private void Deliver(string userKey, object payload)
        {
            string text = JsonSerializer.Serialize(payload, ApiJson);
            lock (_connLock)
            {
                if (!_conns.TryGetValue(userKey, out List<Conn>? list)) return;
                foreach (Conn c in list)
                {
                    if (!c.IsPoll) { c.Out.Writer.TryWrite(text); continue; }
                    lock (c.Buffer) AppendPoll(c, text);
                    c.Signal.TrySetResult(true);
                }
            }
        }

        /// <summary>Caller holds c.Buffer's lock.</summary>
        private static void AppendPoll(Conn c, string json)
        {
            c.Buffer.Add((c.NextSeq++, json));
            if (c.Buffer.Count > MaxPollBuffer) c.Buffer.RemoveRange(0, c.Buffer.Count - MaxPollBuffer);
        }

        // ---- HTTP ----

        private async Task Handle(HttpListenerContext ctx)
        {
            try
            {
                await Route(ctx).ConfigureAwait(false);
            }
            catch (SocialException e)
            {
                await Reply(ctx, e.Status, e.RetryAfter > 0 ? (object)new { error = e.Message, retry_after = e.RetryAfter } : new { error = e.Message }).ConfigureAwait(false);
            }
            catch (Exception e) when (e is HttpListenerException || e is ObjectDisposedException || e is IOException)
            {
                try { ctx.Response.Abort(); } catch (ObjectDisposedException) { }
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("social: " + e);
                await Reply(ctx, 500, new { error = "Something went wrong on the server." }).ConfigureAwait(false);
            }
        }

        private static async Task Reply(HttpListenerContext ctx, int status, object body)
        {
            try
            {
                byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(body, ApiJson);
                ctx.Response.StatusCode = status;
                ctx.Response.ContentType = "application/json; charset=utf-8";
                ctx.Response.ContentLength64 = bytes.Length;
                await ctx.Response.OutputStream.WriteAsync(bytes).ConfigureAwait(false);
                ctx.Response.Close();
            }
            catch (Exception e) when (e is HttpListenerException || e is ObjectDisposedException || e is IOException || e is InvalidOperationException)
            {
                try { ctx.Response.Abort(); } catch (ObjectDisposedException) { }
            }
        }

        /// <summary>The caller's address; behind the hub's proxy (a loopback peer) it is the first X-Forwarded-For entry.</summary>
        private static string ClientAddress(HttpListenerRequest req)
        {
            IPAddress? peer = req.RemoteEndPoint?.Address;
            if (peer is not null && IPAddress.IsLoopback(peer))
            {
                string? fwd = req.Headers["X-Forwarded-For"];
                if (!string.IsNullOrWhiteSpace(fwd)) return fwd.Split(',')[0].Trim();
            }
            return peer?.ToString() ?? "?";
        }

        private static string? BearerOf(HttpListenerRequest req)
        {
            string? h = req.Headers["Authorization"];
            if (h is not null && h.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return h.Substring(7).Trim();
            return req.QueryString["token"];
        }

        private async Task<JsonElement> ReadBody(HttpListenerRequest req)
        {
            if (!req.HasEntityBody) return default;
            if (req.ContentLength64 > _o.MaxBodyBytes) throw new SocialException(413, "That request is too large.");
            using var ms = new MemoryStream();
            var buf = new byte[4096];
            int n;
            while ((n = await req.InputStream.ReadAsync(buf).ConfigureAwait(false)) > 0)
            {
                ms.Write(buf, 0, n);
                if (ms.Length > _o.MaxBodyBytes) throw new SocialException(413, "That request is too large.");
            }
            if (ms.Length == 0) return default;
            try
            {
                using JsonDocument doc = JsonDocument.Parse(ms.ToArray());
                return doc.RootElement.Clone();
            }
            catch (JsonException) { throw new SocialException(400, "That request wasn't valid JSON."); }
        }

        private static string? Str(JsonElement body, string name) =>
            body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        private static bool? Flag(JsonElement body, string name) =>
            body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out JsonElement v) && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False) ? v.GetBoolean() : (bool?)null;

        private static long Num(JsonElement body, string name) =>
            body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out long l) ? l : 0;

        private static CardRec? CardOf(JsonElement body)
        {
            if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty("card", out JsonElement c) || c.ValueKind != JsonValueKind.Object) return null;
            return new CardRec { Type = Str(c, "type") ?? "", Id = Str(c, "id") ?? "", Name = Str(c, "name") ?? "" };
        }

        /// <summary>Checks a username and returns the hub's spelling of it (asking the hub when this server hasn't seen it).</summary>
        private async Task<string> Resolve(string? name)
        {
            if (!SocialService.ValidName(name)) throw new SocialException(404, "That user was not found.");
            string? known = Service.KnownName(name!);
            if (known is not null) return known;
            string? real = await _hub.LookupUser(name!.Trim()).ConfigureAwait(false);
            if (real is null) throw new SocialException(404, "That user was not found.");
            return Service.Remember(real);
        }

        private async Task Route(HttpListenerContext ctx)
        {
            HttpListenerRequest req = ctx.Request;
            string method = req.HttpMethod.ToUpperInvariant();
            string[] seg = (req.Url?.AbsolutePath ?? "/").Split('/', StringSplitOptions.RemoveEmptyEntries).Select(Uri.UnescapeDataString).ToArray();

            if (seg.Length == 2 && seg[0] == "api" && seg[1] == "health" && method == "GET")
            {
                await Reply(ctx, 200, new { ok = true }).ConfigureAwait(false);
                return;
            }
            if (seg.Length == 4 && seg[0] == "api" && seg[1] == "shares" && seg[2] == "link" && method == "GET")
            {
                _anonLimit.Hit(ClientAddress(req), "Too many requests.");
                await Reply(ctx, 200, Service.LinkDownload(seg[3])).ConfigureAwait(false);
                return;
            }

            if (seg.Length >= 2 && seg[0] == "api" && (seg[1] == "profile" || seg[1] == "profiles") && method == "GET")
            {
                // Public reads: a signed-in caller sees what their friendship allows; a signed-out one sees what is for everyone.
                string? visitorToken = BearerOf(req);
                HubUser? visitor = null;
                if (!string.IsNullOrEmpty(visitorToken))
                {
                    try { visitor = await _hub.Authenticate(visitorToken!).ConfigureAwait(false); }
                    catch (SocialException) { visitor = null; }
                }
                if (visitor is not null) { Service.Remember(visitor.Username); _apiLimit.Hit(SocialService.Norm(visitor.Username), "You are making requests too fast."); }
                else _anonLimit.Hit(ClientAddress(req), "Too many requests.");
                if (seg[1] == "profile" && seg.Length == 3)
                {
                    await Reply(ctx, 200, Service.GetProfile(visitor?.Username, await Resolve(seg[2]).ConfigureAwait(false))).ConfigureAwait(false);
                    return;
                }
                if (seg[1] == "profiles" && seg.Length == 2)
                {
                    string[] wanted = (req.QueryString["names"] ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                    await Reply(ctx, 200, Service.GetProfileStyles(wanted)).ConfigureAwait(false);
                    return;
                }
                throw new SocialException(404, "Not found.");
            }

            bool socket = seg.Length == 1 && seg[0] == "ws" && req.IsWebSocketRequest;
            string? token = BearerOf(req);
            HubUser? user = string.IsNullOrEmpty(token) ? null : await _hub.Authenticate(token!).ConfigureAwait(false);
            if (user is null) throw new SocialException(401, "You are not logged in.");
            Service.Remember(user.Username);
            string me = user.Username;

            if (socket)
            {
                await Socket(ctx, user).ConfigureAwait(false);
                return;
            }
            if (seg.Length < 2 || seg[0] != "api") throw new SocialException(404, "Not found.");
            _apiLimit.Hit(SocialService.Norm(me), "You are making requests too fast.");
            JsonElement body = method == "GET" || method == "DELETE" ? default : await ReadBody(req).ConfigureAwait(false);

            object result;
            string a = seg[1];
            switch (a)
            {
                case "me" when seg.Length == 2 && method == "GET":
                    result = new { username = me };
                    break;
                case "events" when seg.Length == 2 && method == "GET":
                    result = await Events(user, req).ConfigureAwait(false);
                    break;
                case "presence" when seg.Length == 2 && method == "POST":
                    result = Presence(user, req, body);
                    break;
                case "friends":
                    result = await Friends(method, seg, me, body).ConfigureAwait(false);
                    break;
                case "blocks" when seg.Length == 2 && method == "GET":
                    result = Service.Blocks(me);
                    break;
                case "blocks" when seg.Length == 2 && method == "POST":
                    result = Service.Block(me, await Resolve(Str(body, "username")).ConfigureAwait(false));
                    break;
                case "blocks" when seg.Length == 3 && method == "DELETE":
                    result = Service.Unblock(me, await Resolve(seg[2]).ConfigureAwait(false));
                    break;
                case "settings" when seg.Length == 2 && method == "GET":
                    result = Service.GetSettings(me);
                    break;
                case "settings" when seg.Length == 2 && (method == "PUT" || method == "POST"):
                    result = Service.PutSettings(me, Flag(body, "allowStrangers"), Flag(body, "invisible"));
                    break;
                case "conversations":
                    result = await Conversations(method, seg, me, body, req).ConfigureAwait(false);
                    break;
                case "profile" when seg.Length == 2 && method == "PUT":
                    result = Service.PutProfile(me, body);
                    break;
                case "profile" when seg.Length == 2 && method == "DELETE":
                    result = Service.DeleteProfile(me);
                    break;
                case "shares":
                    result = await Shares(method, seg, me, body).ConfigureAwait(false);
                    break;
                default:
                    throw new SocialException(404, "Not found.");
            }
            await Reply(ctx, 200, result).ConfigureAwait(false);
        }

        // ---- long polling (for clients behind a proxy that can't carry a WebSocket) ----

        private Conn PollSession(HubUser user, string sid)
        {
            string key = SocialService.Norm(user.Username);
            lock (_connLock)
            {
                if (_conns.TryGetValue(key, out List<Conn>? list))
                {
                    Conn? found = list.FirstOrDefault(c => c.IsPoll && c.Sid == sid);
                    if (found is not null) { found.LastPoll = _o.Clock(); return found; }
                }
            }
            var conn = new Conn { Id = Interlocked.Increment(ref _nextConn), UserKey = key, Name = user.Username, IsPoll = true, Sid = sid, LastPoll = _o.Clock() };
            object hello = Service.Connect(user.Username, conn.Id);   // 429 over the connection cap
            lock (conn.Buffer) AppendPoll(conn, JsonSerializer.Serialize(hello, ApiJson));
            lock (_connLock)
            {
                if (!_conns.TryGetValue(key, out List<Conn>? list)) _conns[key] = list = new List<Conn>();
                list.Add(conn);
            }
            return conn;
        }

        private static string SidOf(HttpListenerRequest req)
        {
            string sid = req.QueryString["sid"] ?? "";
            return sid.Length <= 40 && sid.All(ch => char.IsAsciiLetterOrDigit(ch) || ch == '-' || ch == '_') ? sid : "";
        }

        private async Task<object> Events(HubUser user, HttpListenerRequest req)
        {
            long.TryParse(req.QueryString["since"], NumberStyles.None, CultureInfo.InvariantCulture, out long since);
            int.TryParse(req.QueryString["wait"], NumberStyles.None, CultureInfo.InvariantCulture, out int wait);
            wait = Math.Clamp(wait, 0, 30);
            Conn conn = PollSession(user, SidOf(req));
            var deadline = DateTime.UtcNow.AddSeconds(wait);
            while (true)
            {
                Task<bool> signal;
                lock (conn.Buffer)
                {
                    bool reset = since >= conn.NextSeq;                         // the server restarted: the client's cursor is from an older session
                    if (reset) since = 0;
                    var fresh = conn.Buffer.Where(b => b.Seq > since).ToList();
                    if (fresh.Count > 0 || wait == 0 || DateTime.UtcNow >= deadline)
                    {
                        conn.LastPoll = _o.Clock();
                        var events = fresh.Select(b => { using JsonDocument d = JsonDocument.Parse(b.Json); return d.RootElement.Clone(); }).ToList();
                        return new { seq = conn.NextSeq - 1, reset, events };
                    }
                    signal = conn.Signal.Task;
                }
                TimeSpan left = deadline - DateTime.UtcNow;
                if (left <= TimeSpan.Zero) continue;
                conn.LastPoll = _o.Clock();
                using var wake = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
                wake.CancelAfter(left);
                try { await Task.WhenAny(signal, Task.Delay(Timeout.Infinite, wake.Token)).ConfigureAwait(false); }
                catch (OperationCanceledException) { }
                if (_cts.IsCancellationRequested) return new { seq = conn.NextSeq - 1, reset = false, events = new List<JsonElement>() };
                lock (conn.Buffer)
                {
                    if (conn.Signal.Task.IsCompleted) conn.Signal = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                }
            }
        }

        private object Presence(HubUser user, HttpListenerRequest req, JsonElement body)
        {
            Conn conn = PollSession(user, SidOf(req));
            Service.SetPresence(user.Username, conn.Id, Str(body, "state"), Str(body, "detail"), Str(body, "join"));
            return new { status = "ok" };
        }

        private async Task<object> Friends(string method, string[] seg, string me, JsonElement body)
        {
            if (seg.Length == 2 && method == "GET") return Service.Friends(me);
            if (seg.Length == 3 && method == "POST")
            {
                string other = await Resolve(Str(body, "username")).ConfigureAwait(false);
                switch (seg[2])
                {
                    case "request": return Service.RequestFriend(me, other);
                    case "accept": return Service.Accept(me, other);
                    case "decline": return Service.Decline(me, other);
                }
            }
            if (seg.Length == 3 && method == "DELETE") return Service.RemoveFriend(me, await Resolve(seg[2]).ConfigureAwait(false));
            throw new SocialException(404, "Not found.");
        }

        /// <summary>A conversation id as given, or the DM id for a username (the pre-groups route form).</summary>
        private async Task<string> ConvId(string me, string idOrUser)
        {
            if (SocialService.IsConversationId(idOrUser)) return idOrUser;
            return SocialService.DmId(me, await Resolve(idOrUser).ConfigureAwait(false));
        }

        private static List<string> StrList(JsonElement body, string name)
        {
            var list = new List<string>();
            if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.Array)
                foreach (JsonElement e in v.EnumerateArray()) if (e.ValueKind == JsonValueKind.String && e.GetString() is string t) list.Add(t);
            return list;
        }

        private async Task<object> Conversations(string method, string[] seg, string me, JsonElement body, HttpListenerRequest req)
        {
            if (seg.Length == 2 && method == "GET") return Service.Conversations(me);
            if (seg.Length == 2 && method == "POST")
            {
                var others = new List<string>();
                foreach (string n in StrList(body, "members")) others.Add(await Resolve(n).ConfigureAwait(false));
                return Service.CreateGroup(me, Str(body, "name"), others);
            }
            if (seg.Length == 4)
            {
                string id = await ConvId(me, seg[2]).ConfigureAwait(false);
                if (seg[3] == "messages" && method == "GET")
                {
                    long.TryParse(req.QueryString["before"], NumberStyles.None, CultureInfo.InvariantCulture, out long before);
                    int limit = int.TryParse(req.QueryString["limit"], NumberStyles.None, CultureInfo.InvariantCulture, out int l) ? l : 50;
                    return Service.Messages(me, id, before, limit);
                }
                if (seg[3] == "messages" && method == "POST") return Service.Send(me, id, Str(body, "text"), CardOf(body), Str(body, "cid"), Num(body, "replyTo"));
                if (seg[3] == "read" && method == "POST") return Service.MarkRead(me, id, Num(body, "upTo"));
                if (seg[3] == "name" && method == "POST") return Service.RenameGroup(me, id, Str(body, "name"));
                if (seg[3] == "members" && method == "POST") return Service.AddMember(me, id, await Resolve(Str(body, "username")).ConfigureAwait(false));
            }
            if (seg.Length == 5 && seg[3] == "members" && method == "DELETE")
                return Service.RemoveMember(me, await ConvId(me, seg[2]).ConfigureAwait(false), await Resolve(seg[4]).ConfigureAwait(false));
            throw new SocialException(404, "Not found.");
        }

        private async Task<object> Shares(string method, string[] seg, string me, JsonElement body)
        {
            if (seg.Length == 2 && method == "GET") return Service.Shares(me);
            if (seg.Length == 2 && method == "POST")
            {
                string? with = Str(body, "with");
                if (!string.IsNullOrEmpty(with)) with = await Resolve(with).ConfigureAwait(false);
                return Service.CreateShare(me, Str(body, "mapId"), Str(body, "name"), Str(body, "mode"), with, Flag(body, "link") == true, Num(body, "expiresInSeconds"), Str(body, "objectKey"));
            }
            if (seg.Length == 3 && method == "DELETE") return Service.Revoke(me, seg[2]);
            if (seg.Length == 4 && seg[3] == "download" && method == "GET") return Service.ShareDownload(me, seg[2]);
            throw new SocialException(404, "Not found.");
        }

        // ---- WebSocket ----

        private async Task Socket(HttpListenerContext ctx, HubUser user)
        {
            string key = SocialService.Norm(user.Username);
            var conn = new Conn { Id = Interlocked.Increment(ref _nextConn), UserKey = key, Name = user.Username };
            object hello = Service.Connect(user.Username, conn.Id);   // throws 429 before the upgrade when over the connection cap
            conn.Out.Writer.TryWrite(JsonSerializer.Serialize(hello, ApiJson));
            HttpListenerWebSocketContext wsc;
            try
            {
                wsc = await ctx.AcceptWebSocketAsync(null, TimeSpan.FromSeconds(30)).ConfigureAwait(false);
            }
            catch
            {
                Service.Disconnect(user.Username, conn.Id);
                try { ctx.Response.Abort(); } catch (ObjectDisposedException) { }
                return;
            }
            WebSocket ws = wsc.WebSocket;
            conn.Socket = ws;
            lock (_connLock)
            {
                if (!_conns.TryGetValue(key, out List<Conn>? list)) _conns[key] = list = new List<Conn>();
                list.Add(conn);
            }
            Task pump = Task.Run(() => SendPump(conn, ws));
            try { await ReceiveLoop(conn, ws, user).ConfigureAwait(false); }
            finally
            {
                lock (_connLock)
                {
                    if (_conns.TryGetValue(key, out List<Conn>? list))
                    {
                        list.Remove(conn);
                        if (list.Count == 0) _conns.Remove(key);
                    }
                }
                conn.Out.Writer.TryComplete();
                Service.Disconnect(user.Username, conn.Id);
                try { ws.Abort(); } catch (ObjectDisposedException) { }
                try { await pump.ConfigureAwait(false); } catch (Exception) { }
                ws.Dispose();
            }
        }

        private async Task SendPump(Conn conn, WebSocket ws)
        {
            try
            {
                await foreach (string text in conn.Out.Reader.ReadAllAsync(_cts.Token).ConfigureAwait(false))
                {
                    if (ws.State != WebSocketState.Open) return;
                    await ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, _cts.Token).ConfigureAwait(false);
                }
            }
            catch (Exception e) when (e is WebSocketException || e is OperationCanceledException || e is ObjectDisposedException || e is IOException) { }
        }

        private void Send(Conn conn, object payload) => conn.Out.Writer.TryWrite(JsonSerializer.Serialize(payload, ApiJson));

        private async Task ReceiveLoop(Conn conn, WebSocket ws, HubUser user)
        {
            var buffer = new byte[8192];
            var window = new RateLimiter(_o.WsMessagesPerSecond, TimeSpan.FromSeconds(1), _o.Clock);
            try
            {
                while (ws.State == WebSocketState.Open && !_cts.IsCancellationRequested)
                {
                    using var ms = new MemoryStream();
                    WebSocketReceiveResult res;
                    do
                    {
                        res = await ws.ReceiveAsync(buffer, _cts.Token).ConfigureAwait(false);
                        if (res.MessageType == WebSocketMessageType.Close)
                        {
                            try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None).ConfigureAwait(false); } catch (WebSocketException) { }
                            return;
                        }
                        ms.Write(buffer, 0, res.Count);
                        if (ms.Length > 16 * 1024)
                        {
                            try { await ws.CloseAsync(WebSocketCloseStatus.MessageTooBig, "message too big", CancellationToken.None).ConfigureAwait(false); } catch (WebSocketException) { }
                            return;
                        }
                    } while (!res.EndOfMessage);

                    if (!window.TryHit(conn.UserKey + "#" + conn.Id, out _))
                    {
                        try { await ws.CloseAsync(WebSocketCloseStatus.PolicyViolation, "rate limit", CancellationToken.None).ConfigureAwait(false); } catch (WebSocketException) { }
                        return;
                    }
                    await HandleFrame(conn, user, ms.ToArray()).ConfigureAwait(false);
                }
            }
            catch (Exception e) when (e is WebSocketException || e is OperationCanceledException || e is IOException || e is ObjectDisposedException) { }
        }

        private async Task HandleFrame(Conn conn, HubUser user, byte[] data)
        {
            JsonElement msg;
            try { using JsonDocument doc = JsonDocument.Parse(data); msg = doc.RootElement.Clone(); }
            catch (JsonException) { return; }
            string? reference = Str(msg, "ref");
            try
            {
                switch (Str(msg, "type"))
                {
                    case "presence":
                        Service.SetPresence(user.Username, conn.Id, Str(msg, "state"), Str(msg, "detail"), Str(msg, "join"));
                        break;
                    case "ping":
                        Send(conn, new { type = "pong" });
                        break;
                    case "send":
                    {
                        string? target = Str(msg, "conv") ?? Str(msg, "convId") ?? Str(msg, "to");
                        string convId = await ConvId(user.Username, target ?? "").ConfigureAwait(false);
                        object sent = Service.Send(user.Username, convId, Str(msg, "text"), CardOf(msg), Str(msg, "cid"), Num(msg, "replyTo"));
                        Send(conn, new { type = "sent", @ref = reference, message = sent });
                        break;
                    }
                }
            }
            catch (SocialException e)
            {
                Send(conn, new { type = "error", @ref = reference, status = e.Status, error = e.Message });
            }
        }
    }
}

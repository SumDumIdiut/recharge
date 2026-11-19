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
    public sealed partial class SocialServer : IDisposable
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

        // Voice presence only: Cloudflare session + published track names, never media or SDP.
        private sealed class VoiceMember
        {
            public Conn Conn = null!;
            public int ConnId;
            public string Username = "";
            public string SessionId = "";
            public string[] Tracks = Array.Empty<string>();
            public bool Muted;
            public bool Cam;
        }

        private const int MaxPollBuffer = 500;
        private static readonly TimeSpan PollIdle = TimeSpan.FromSeconds(45);

        private readonly SocialOptions _o;
        private readonly IHubDirectory _hub;
        private readonly HttpListener _listener = new HttpListener();
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private readonly object _connLock = new object();
        private readonly Dictionary<string, List<Conn>> _conns = new Dictionary<string, List<Conn>>(StringComparer.Ordinal);
        private readonly object _voiceLock = new object();
        private readonly Dictionary<string, Dictionary<int, VoiceMember>> _voice = new Dictionary<string, Dictionary<int, VoiceMember>>(StringComparer.Ordinal);
        private readonly RateLimiter _apiLimit;
        private readonly RateLimiter _anonLimit;
        private readonly RateLimiter _voiceLimit;
        private readonly CloudflareVoiceClient _voiceApi;
        private Task _accept = Task.CompletedTask;
        private Timer? _reaper;
        private int _nextConn;

        public SocialService Service { get; }
        public int Port { get; private set; }

        public SocialServer(SocialOptions options, IHubDirectory hub, IShareSigner signer, CloudflareVoiceClient? voice = null)
        {
            _o = options;
            _hub = hub;
            Service = new SocialService(options, signer);
            Service.Push += Deliver;
            _apiLimit = new RateLimiter(options.ApiPerMinute, TimeSpan.FromMinutes(1), options.Clock);
            _anonLimit = new RateLimiter(60, TimeSpan.FromMinutes(1), options.Clock);
            _voiceLimit = new RateLimiter(120, TimeSpan.FromMinutes(1), options.Clock);
            _voiceApi = voice ?? new CloudflareVoiceClient(clock: options.Clock);
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

        /// <summary>One inclusive byte range from a "bytes=a-b" header (no suffix/multi-range support).</summary>
        private static bool TryByteRange(string? header, long length, out long start, out long end)
        {
            start = 0;
            end = length - 1;
            if (length == 0 || string.IsNullOrEmpty(header) || !header.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase)) return false;
            string[] pair = header.Substring(6).Split(',')[0].Trim().Split('-');
            if (pair.Length != 2 || !long.TryParse(pair[0], NumberStyles.None, CultureInfo.InvariantCulture, out long from) || from < 0 || from >= length) return false;
            long to = length - 1;
            if (pair[1].Length > 0 && (!long.TryParse(pair[1], NumberStyles.None, CultureInfo.InvariantCulture, out to) || to < from)) return false;
            start = from;
            end = Math.Min(to, length - 1);
            return true;
        }

        /// <summary>Streams a stored message attachment; a byte range lets videos seek.</summary>
        private async Task ServeMedia(HttpListenerContext ctx, string name)
        {
            string? path = Service.MediaPath(name);
            if (path is null || !File.Exists(path)) throw new SocialException(404, "That file was not found.");
            long length = new FileInfo(path).Length;
            HttpListenerResponse res = ctx.Response;
            res.ContentType = SocialService.MediaMime(name);
            res.Headers["X-Content-Type-Options"] = "nosniff";
            res.Headers["Cache-Control"] = "public, max-age=31536000, immutable";
            res.Headers["Accept-Ranges"] = "bytes";
            long start = 0, end = length - 1;
            string? header = ctx.Request.Headers["Range"];
            bool ranged = !string.IsNullOrEmpty(header);
            if (ranged && !TryByteRange(header, length, out start, out end))
            {
                res.StatusCode = 416;
                res.Headers["Content-Range"] = "bytes */" + length.ToString(CultureInfo.InvariantCulture);
                res.ContentLength64 = 0;
                res.Close();
                return;
            }
            res.StatusCode = ranged ? 206 : 200;
            res.ContentLength64 = end - start + 1;
            if (ranged) res.Headers["Content-Range"] = "bytes " + start.ToString(CultureInfo.InvariantCulture) + "-" + end.ToString(CultureInfo.InvariantCulture) + "/" + length.ToString(CultureInfo.InvariantCulture);
            using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            file.Seek(start, SeekOrigin.Begin);
            var buf = new byte[81920];
            long left = end - start + 1;
            while (left > 0)
            {
                int n = file.Read(buf, 0, (int)Math.Min(buf.Length, left));
                if (n == 0) break;
                await res.OutputStream.WriteAsync(buf.AsMemory(0, n)).ConfigureAwait(false);
                left -= n;
            }
            res.Close();
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

        private async Task<JsonElement> ReadBody(HttpListenerRequest req, long maxBytes = -1)
        {
            if (maxBytes < 0) maxBytes = _o.MaxBodyBytes;
            if (!req.HasEntityBody) return default;
            if (req.ContentLength64 > maxBytes) throw new SocialException(413, "That request is too large.");
            using var ms = new MemoryStream();
            var buf = new byte[4096];
            int n;
            while ((n = await req.InputStream.ReadAsync(buf).ConfigureAwait(false)) > 0)
            {
                ms.Write(buf, 0, n);
                if (ms.Length > maxBytes) throw new SocialException(413, "That request is too large.");
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

        private static int? Int(JsonElement body, string name) =>
            body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out int i) ? i : (int?)null;

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

            // Public: message media is served by the social-proxy so <img>/<video> can load it without a token.
            if (seg.Length == 4 && seg[0] == "api" && seg[1] == "conversations" && seg[2] == "media" && method == "GET")
            {
                _anonLimit.Hit(ClientAddress(req), "Too many requests.");
                await ServeMedia(ctx, seg[3]).ConfigureAwait(false);
                return;
            }
            // Public: the shared emoji catalog, so pickers can load before/without a session.
            if (seg.Length == 2 && seg[0] == "api" && seg[1] == "emojis" && method == "GET")
            {
                _anonLimit.Hit(ClientAddress(req), "Too many requests.");
                await Reply(ctx, 200, Service.ListEmojis()).ConfigureAwait(false);
                return;
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
            if (seg[1] == "voice")
            {
                await VoiceApi(ctx, method, seg, me).ConfigureAwait(false);
                return;
            }
            bool mediaUpload = seg.Length == 4 && seg[3] == "media" && method == "POST";
            bool emojiUpload = (seg.Length == 2 && seg[0] == "api" && seg[1] == "emojis" && method == "POST")
                || (seg.Length == 4 && seg[1] == "servers" && seg[3] == "emojis" && method == "POST");
            JsonElement body = method == "GET" || method == "DELETE" ? default : await ReadBody(req, mediaUpload || emojiUpload ? _o.MaxMediaBodyBytes : _o.MaxBodyBytes).ConfigureAwait(false);

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
                case "servers":
                    result = await Servers(method, seg, me, body).ConfigureAwait(false);
                    break;
                case "emojis":
                    result = Emojis(method, seg, me, body, user.Admin);
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

        private object Emojis(string method, string[] seg, string me, JsonElement body, bool admin)
        {
            if (seg.Length == 2 && method == "POST")
                return Service.UploadEmoji(me, Str(body, "shortcode"), Str(body, "mime"), Str(body, "data"));
            if (seg.Length == 3 && seg[2] == "mine" && method == "GET") return Service.MyArsenal(me);
            if (seg.Length == 2 && method == "GET") return Service.ListEmojis();
            if (seg.Length == 3 && method == "DELETE")
            {
                Service.DeleteEmoji(me, seg[2], admin);
                return new { ok = true };
            }
            throw new SocialException(404, "Not found.");
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
                if (seg[3] == "media" && method == "POST")
                    return Service.UploadMedia(me, await ConvId(me, seg[2]).ConfigureAwait(false), Str(body, "name"), Str(body, "mime"), Str(body, "data"));
                string id = await ConvId(me, seg[2]).ConfigureAwait(false);
                if (seg[3] == "messages" && method == "GET")
                {
                    long.TryParse(req.QueryString["before"], NumberStyles.None, CultureInfo.InvariantCulture, out long before);
                    int limit = int.TryParse(req.QueryString["limit"], NumberStyles.None, CultureInfo.InvariantCulture, out int l) ? l : 50;
                    return Service.Messages(me, id, before, limit);
                }
                if (seg[3] == "messages" && method == "POST") return Service.Send(me, id, Str(body, "text"), CardOf(body), Str(body, "cid"), Num(body, "replyTo"), StrList(body, "media").ToArray());
                if (seg[3] == "read" && method == "POST") return Service.MarkRead(me, id, Num(body, "upTo"));
                if (seg[3] == "profile" && method == "PATCH")
                    return Service.SetGroupProfile(me, id, Str(body, "name"), Str(body, "color"), Str(body, "avatar"));
                if (seg[3] == "name" && method == "POST") return Service.RenameGroup(me, id, Str(body, "name"));
                if (seg[3] == "members" && method == "POST") return Service.AddMember(me, id, await Resolve(Str(body, "username")).ConfigureAwait(false));
            }
            if (seg.Length == 5 && seg[3] == "messages" && method == "PATCH" &&
                long.TryParse(seg[4], NumberStyles.None, CultureInfo.InvariantCulture, out long midEdit))
                return Service.Edit(me, await ConvId(me, seg[2]).ConfigureAwait(false), midEdit, Str(body, "text"));
            if (seg.Length == 6 && seg[3] == "messages" && seg[5] == "react" && method == "POST" &&
                long.TryParse(seg[4], NumberStyles.None, CultureInfo.InvariantCulture, out long mid))
                return Service.React(me, await ConvId(me, seg[2]).ConfigureAwait(false), mid, Str(body, "emoji"));
            if (seg.Length == 5 && seg[3] == "messages" && method == "DELETE" &&
                long.TryParse(seg[4], NumberStyles.None, CultureInfo.InvariantCulture, out long midDelete))
                return Service.Delete(me, await ConvId(me, seg[2]).ConfigureAwait(false), midDelete);
            if (seg.Length == 5 && seg[3] == "members" && method == "DELETE")
                return Service.RemoveMember(me, await ConvId(me, seg[2]).ConfigureAwait(false), await Resolve(seg[4]).ConfigureAwait(false));
            throw new SocialException(404, "Not found.");
        }

        private async Task<object> Servers(string method, string[] seg, string me, JsonElement body)
        {
            if (seg.Length == 2 && method == "GET") return Service.Servers(me);
            if (seg.Length == 2 && method == "POST") return Service.CreateServer(me, Str(body, "name"));
            if (seg.Length == 3 && method == "PATCH") return Service.UpdateServer(me, seg[2], Str(body, "name"), Str(body, "icon"));
            if (seg.Length == 4 && seg[3] == "channels" && method == "POST")
                return Service.CreateChannel(me, seg[2], Str(body, "name"), Str(body, "kind"), Str(body, "categoryId"));
            if (seg.Length == 5 && seg[3] == "channels" && method == "PATCH")
                return Service.UpdateChannel(me, seg[2], seg[4], Str(body, "name"), Str(body, "topic"), Int(body, "position"), Str(body, "categoryId"));
            if (seg.Length == 5 && seg[3] == "channels" && method == "DELETE")
                return Service.DeleteChannel(me, seg[2], seg[4]);
            // categories
            if (seg.Length == 4 && seg[3] == "categories" && method == "POST")
                return Service.CreateCategory(me, seg[2], Str(body, "name"));
            if (seg.Length == 5 && seg[3] == "categories" && method == "PATCH")
                return Service.UpdateCategory(me, seg[2], seg[4], Str(body, "name"), Int(body, "position"));
            if (seg.Length == 5 && seg[3] == "categories" && method == "DELETE")
                return Service.DeleteCategory(me, seg[2], seg[4]);
            // roles
            if (seg.Length == 4 && seg[3] == "roles" && method == "POST")
                return Service.CreateRole(me, seg[2], Str(body, "name"), Str(body, "color"), Flag(body, "admin") == true);
            if (seg.Length == 5 && seg[3] == "roles" && method == "PATCH")
                return Service.UpdateRole(me, seg[2], seg[4], Str(body, "name"), Str(body, "color"), Flag(body, "admin"), Int(body, "position"));
            if (seg.Length == 5 && seg[3] == "roles" && method == "DELETE")
                return Service.DeleteRole(me, seg[2], seg[4]);
            // server emoji set
            if (seg.Length == 4 && seg[3] == "emojis" && method == "GET")
                return Service.ServerEmojis(me, seg[2]);
            if (seg.Length == 4 && seg[3] == "emojis" && method == "POST")
                return Service.AddServerEmoji(me, seg[2], Str(body, "shortcode"), Str(body, "mime"), Str(body, "data"));
            if (seg.Length == 5 && seg[3] == "emojis" && method == "DELETE")
                return Service.RemoveServerEmoji(me, seg[2], seg[4]);
            if (seg.Length == 4 && seg[3] == "members" && method == "POST")
                return Service.AddServerMember(me, seg[2], await Resolve(Str(body, "username")).ConfigureAwait(false));
            if (seg.Length == 6 && seg[3] == "members" && seg[5] == "roles" && method == "PUT")
                return Service.SetMemberRoles(me, seg[2], await Resolve(seg[4]).ConfigureAwait(false), StrList(body, "roleIds").ToArray());
            if (seg.Length == 5 && seg[3] == "members" && method == "DELETE")
                return Service.RemoveServerMember(me, seg[2], await Resolve(seg[4]).ConfigureAwait(false));
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
                LeaveAllVoice(conn);
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

        // ---- voice rosters (ephemeral) ----

        private static bool IsCall(string id) =>
            id.StartsWith("dm:", StringComparison.Ordinal) || id.StartsWith("g:", StringComparison.Ordinal);

        /// <summary>Voice rooms: server voice channels (walk-in) or DM/group conversations (ringing).</summary>
        private string VoiceRoomId(HubUser user, JsonElement msg)
        {
            string id = Str(msg, "convId") ?? Str(msg, "channelId") ?? "";
            if (id.StartsWith("ch:", StringComparison.Ordinal))
            {
                ChannelRec ch = Service.ChannelForMember(user.Username, id);
                if (ch.Kind != "voice") throw new SocialException(400, "That channel isn't a voice channel.");
                return ch.Id;
            }
            if (IsCall(id)) return Service.CallConversation(user.Username, id).Id;
            throw new SocialException(400, "A conversation id is required.");
        }

        /// <summary>Call-only room id: ch: channels never ring.</summary>
        private string CallRoomId(HubUser user, JsonElement msg)
        {
            string id = Str(msg, "convId") ?? Str(msg, "channelId") ?? "";
            return Service.CallConversation(user.Username, id).Id;
        }

        private static string CallKindOf(JsonElement msg) => Str(msg, "kind") == "video" ? "video" : "audio";

        /// <summary>Push a call frame to every member; optionally skip the acting user.</summary>
        private void CallPush(string convId, string actor, object payload, bool exceptActor = false)
        {
            string[] members;
            try { members = Service.CallConversation(actor, convId).Members; }
            catch (SocialException) { return; }   // membership changed mid-call
            string skip = SocialService.Norm(actor);
            foreach (string member in members.Distinct())
                if (!exceptActor || member != skip) Deliver(member, payload);
        }

        private static object[] VoiceMembers(IEnumerable<VoiceMember> members) =>
            members.Select(m => (object)new { username = m.Username, sessionId = m.SessionId, tracks = m.Tracks, muted = m.Muted, cam = m.Cam }).ToArray();

        private object[] VoiceMembersOf(string convId)
        {
            lock (_voiceLock)
                return _voice.TryGetValue(convId, out Dictionary<int, VoiceMember>? roster) ? VoiceMembers(roster.Values) : Array.Empty<object>();
        }

        private void BroadcastVoice(string convId)
        {
            object state;
            List<Conn> targets;
            lock (_voiceLock)
            {
                if (!_voice.TryGetValue(convId, out Dictionary<int, VoiceMember>? roster)) return;
                state = new { type = "voice.state", channelId = convId, members = VoiceMembers(roster.Values) };
                targets = roster.Values.Select(m => m.Conn).ToList();
            }
            foreach (Conn c in targets) Send(c, state);
        }

        /// <summary>Caller holds _voiceLock.</summary>
        private Dictionary<int, VoiceMember> VoiceRoster(string convId)
        {
            if (!_voice.TryGetValue(convId, out Dictionary<int, VoiceMember>? roster)) _voice[convId] = roster = new Dictionary<int, VoiceMember>();
            return roster;
        }

        /// <summary>Caller holds _voiceLock.</summary>
        private static VoiceMember VoiceMemberFor(Dictionary<int, VoiceMember> roster, Conn conn)
        {
            if (!roster.TryGetValue(conn.Id, out VoiceMember? m)) roster[conn.Id] = m = new VoiceMember { Conn = conn, ConnId = conn.Id, Username = conn.Name };
            return m;
        }

        private void VoiceJoin(Conn conn, HubUser user, JsonElement msg, string? reference)
        {
            string id = VoiceRoomId(user, msg);
            bool ring;
            lock (_voiceLock)
            {
                Dictionary<int, VoiceMember> roster = VoiceRoster(id);
                ring = IsCall(id) && roster.Count == 0;   // only the first joiner rings
                VoiceMemberFor(roster, conn);
            }
            if (ring) CallPush(id, conn.Name, new { type = "call.ring", convId = id, from = conn.Name, kind = CallKindOf(msg) }, true);
            BroadcastVoice(id);
            Send(conn, new { type = "voice.state", channelId = id, members = VoiceMembersOf(id), @ref = reference });
        }

        private void CallDecline(Conn conn, HubUser user, JsonElement msg)
        {
            string id = CallRoomId(user, msg);
            CallPush(id, conn.Name, new { type = "call.declined", convId = id, from = conn.Name });
        }

        private void VoicePublish(Conn conn, HubUser user, JsonElement msg)
        {
            string id = VoiceRoomId(user, msg);
            string sessionId = Str(msg, "sessionId") ?? "";
            string[] tracks = StrList(msg, "tracks").ToArray();
            bool muted = Flag(msg, "muted") ?? false;
            bool cam = Flag(msg, "cam") ?? false;
            lock (_voiceLock)
            {
                VoiceMember m = VoiceMemberFor(VoiceRoster(id), conn);
                m.SessionId = sessionId;
                m.Tracks = tracks;
                m.Muted = muted;
                m.Cam = cam;
            }
            BroadcastVoice(id);
        }

        private void VoiceUpdate(Conn conn, HubUser user, JsonElement msg)
        {
            string id = VoiceRoomId(user, msg);
            bool? muted = Flag(msg, "muted"), cam = Flag(msg, "cam");
            lock (_voiceLock)
            {
                VoiceMember m = VoiceMemberFor(VoiceRoster(id), conn);
                if (muted.HasValue) m.Muted = muted.Value;
                if (cam.HasValue) m.Cam = cam.Value;
            }
            BroadcastVoice(id);
        }

        private void VoiceLeave(Conn conn, HubUser user, JsonElement msg)
        {
            string id = VoiceRoomId(user, msg);
            bool changed, ended = false;
            lock (_voiceLock)
            {
                changed = _voice.TryGetValue(id, out Dictionary<int, VoiceMember>? roster) && roster.Remove(conn.Id);
                if (changed && roster!.Count == 0) { _voice.Remove(id); ended = IsCall(id); }
            }
            if (changed) BroadcastVoice(id);
            if (ended) CallPush(id, conn.Name, new { type = "call.ended", convId = id });
        }

        private void LeaveAllVoice(Conn conn)
        {
            List<string> affected = new List<string>();
            lock (_voiceLock)
            {
                foreach (var kv in _voice.ToList())
                {
                    if (!kv.Value.Remove(conn.Id)) continue;
                    affected.Add(kv.Key);
                    if (kv.Value.Count == 0) _voice.Remove(kv.Key);
                }
            }
            foreach (string id in affected) BroadcastVoice(id);
            foreach (string id in affected.Where(IsCall)) CallPush(id, conn.Name, new { type = "call.ended", convId = id });
        }

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
                        object sent = Service.Send(user.Username, convId, Str(msg, "text"), CardOf(msg), Str(msg, "cid"), Num(msg, "replyTo"), StrList(msg, "media").ToArray());
                        Send(conn, new { type = "sent", @ref = reference, message = sent });
                        break;
                    }
                    case "voice.join":
                        VoiceJoin(conn, user, msg, reference);
                        break;
                    case "voice.publish":
                        VoicePublish(conn, user, msg);
                        break;
                    case "voice.update":
                        VoiceUpdate(conn, user, msg);
                        break;
                    case "voice.leave":
                        VoiceLeave(conn, user, msg);
                        break;
                    case "call.decline":
                        CallDecline(conn, user, msg);
                        break;
                }
            }
            catch (SocialException e)
            {
                Send(conn, new { type = "error", @ref = reference, status = e.Status, error = e.Message });
            }
        }
    }
}

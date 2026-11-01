using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Recharge.App.Account;
using Recharge.App.Bridge;
using Recharge.Core.Json;

namespace Recharge.App.Social
{
    /// <summary>Where the social server is. RECHARGE_SOCIAL_BASE (http or https) overrides the default; tests and snapshots use it.</summary>
    public static class SocialPaths
    {
        public const string BaseVariable = "RECHARGE_SOCIAL_BASE";
        public const string DefaultBaseUrl = "https://codecade.co.za/recharge/social";

        public static string BaseUrl
        {
            get
            {
                string? v = Environment.GetEnvironmentVariable(BaseVariable);
                return v != null && (v.StartsWith("http://", StringComparison.Ordinal) || v.StartsWith("https://", StringComparison.Ordinal))
                    ? v.TrimEnd('/') : DefaultBaseUrl;
            }
        }

        public static bool IsValid(string? path)
        {
            if (string.IsNullOrEmpty(path) || !path.StartsWith("/api/", StringComparison.Ordinal)) return false;
            foreach (char c in path)
            {
                if (c < ' ' || c == '\u007F' || c == '\\') return false;
            }
            return !path.Contains("..", StringComparison.Ordinal);
        }
    }

    public sealed class SocialHubOptions
    {
        public Func<string> BaseUrl { get; set; } = () => SocialPaths.BaseUrl;
        public Func<string?> Token { get; set; } = () => AccountStore.Load()?.Token;
        /// <summary>A "watch on" lapses after this long without being renewed (the page renews while open).</summary>
        public TimeSpan WatchLease { get; set; } = TimeSpan.FromSeconds(20);
        public TimeSpan ReconnectMin { get; set; } = TimeSpan.FromSeconds(1);
        public TimeSpan ReconnectMax { get; set; } = TimeSpan.FromSeconds(30);
        public int MaxEvents { get; set; } = 500;
        /// <summary>How long one long-poll request waits on the server (the server caps it at 30).</summary>
        public int PollWaitSeconds { get; set; } = 25;
        /// <summary>After the socket fails to connect, long-poll for this long before trying the socket again.</summary>
        public TimeSpan SocketRetry { get; set; } = TimeSpan.FromMinutes(2);
    }

    /// <summary>
    /// The app's connection to the social server. REST calls carry the hub session token (it never reaches the page). One
    /// WebSocket delivers presence and message pushes; they are kept as a numbered event list the page polls with
    /// social.events, the same pattern as the Lobbies page. The socket only runs while a page watches.
    /// </summary>
    public sealed class SocialHub : IDisposable
    {
        private static readonly Lazy<SocialHub> Shared = new Lazy<SocialHub>(() => new SocialHub(new SocialHubOptions()));
        public static SocialHub Instance => Shared.Value;

        private static readonly HttpClient Http = CreateClient();

        private static readonly HttpClient PollHttp = CreatePollClient();

        private static HttpClient CreatePollClient()
        {
            var client = new HttpClient { Timeout = TimeSpan.FromSeconds(45) };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("RechargeNext/" + AppVersion.Value);
            return client;
        }

        private static HttpClient CreateClient()
        {
            var client = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("RechargeNext/" + AppVersion.Value);
            return client;
        }

        private readonly SocialHubOptions _o;
        private readonly object _gate = new object();
        private readonly List<JsonObject> _events = new List<JsonObject>();
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private long _seq;
        private long _dropped;
        private bool _watching;
        private DateTime _watchRenewed = DateTime.MinValue;
        private bool _connected;
        private string _presenceFrame = "{\"type\":\"presence\",\"state\":\"online\"}";
        private ClientWebSocket? _socket;
        private bool _polling;
        private string _sid = Guid.NewGuid().ToString("N");
        private DateTime _socketFailedAt = DateTime.MinValue;
        private CancellationTokenSource? _pollCts;
        private Task _loop = Task.CompletedTask;
        private bool _disposed;

        public SocialHub(SocialHubOptions options) { _o = options; }

        public bool IsConnected { get { lock (_gate) return _connected; } }

        // ---- REST ----

        public async Task<JsonNode> Request(string method, string path, JsonNode? body)
        {
            if (!SocialPaths.IsValid(path)) throw new ArgumentException("social path must start with /api/", nameof(path));
            string verb = string.IsNullOrEmpty(method) ? "GET" : method.Trim().ToUpperInvariant();
            if (verb != "GET" && verb != "POST" && verb != "PUT" && verb != "DELETE") throw new ArgumentException("unsupported HTTP method", nameof(method));
            string? token = _o.Token();
            if (string.IsNullOrEmpty(token)) throw new InvalidOperationException("not logged in");

            using var request = new HttpRequestMessage(new HttpMethod(verb), _o.BaseUrl() + path);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            if (body is not null) request.Content = new StringContent(JsonWriter.Write(body, 0), Encoding.UTF8, "application/json");
            int status;
            string text;
            try
            {
                using HttpResponseMessage response = await Http.SendAsync(request).ConfigureAwait(false);
                status = (int)response.StatusCode;
                text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            }
            catch (HttpRequestException) { throw new InvalidOperationException("Couldn't reach the Recharge social server. Check your connection."); }
            catch (TaskCanceledException) { throw new InvalidOperationException("Couldn't reach the Recharge social server. Check your connection."); }

            var result = new JsonObject();
            result["status"] = JsonNumber.From(status);
            result["body"] = new JsonString(text.Replace(token, "[redacted]", StringComparison.Ordinal));
            return result;
        }

        // ---- the socket ----

        /// <summary>The page turns the socket on (and renews it) or off.</summary>
        public void Watch(bool on)
        {
            lock (_gate)
            {
                if (_disposed) return;
                if (on)
                {
                    _watching = true;
                    _watchRenewed = DateTime.UtcNow;
                    if (_loop.IsCompleted) _loop = Task.Run(Loop);
                }
                else
                {
                    _watching = false;
                    CloseSocketLocked();
                }
            }
        }

        private bool ShouldRun()
        {
            lock (_gate) return !_disposed && _watching && DateTime.UtcNow - _watchRenewed < _o.WatchLease;
        }

        private void CloseSocketLocked()
        {
            try { _socket?.Abort(); } catch (ObjectDisposedException) { }
            try { _pollCts?.Cancel(); } catch (ObjectDisposedException) { }
        }

        /// <summary>Tell the server what you are doing (online, game, lobby, editing). Remembered across reconnects.</summary>
        public void SetPresence(string state, string detail, string join)
        {
            var frame = new JsonObject();
            frame["type"] = new JsonString("presence");
            frame["state"] = new JsonString(state);
            frame["detail"] = new JsonString(detail);
            frame["join"] = new JsonString(join);
            string text = JsonWriter.Write(frame, 0);
            ClientWebSocket? socket;
            bool polling;
            lock (_gate) { _presenceFrame = text; socket = _connected ? _socket : null; polling = _connected && _polling; }
            if (socket is not null) _ = SendFrame(socket, text);
            else if (polling) _ = PostPresence(text);
        }

        /// <summary>Send a raw frame (used for messages over the socket); false when not connected.</summary>
        public bool TrySend(JsonObject frame)
        {
            ClientWebSocket? socket;
            lock (_gate) socket = _connected && !_polling ? _socket : null;
            if (socket is null) return false;
            _ = SendFrame(socket, JsonWriter.Write(frame, 0));
            return true;
        }

        private static async Task SendFrame(ClientWebSocket socket, string text)
        {
            try
            {
                if (socket.State == WebSocketState.Open)
                    await socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception e) when (e is WebSocketException || e is ObjectDisposedException || e is InvalidOperationException) { }
        }

        private async Task Loop()
        {
            TimeSpan delay = _o.ReconnectMin;
            while (ShouldRun())
            {
                string? token = _o.Token();
                if (string.IsNullOrEmpty(token))
                {
                    await Pause(TimeSpan.FromSeconds(1)).ConfigureAwait(false);
                    continue;
                }
                bool wasUp = false;
                try
                {
                    if (UsePolling()) wasUp = await RunPoll(token!).ConfigureAwait(false);
                    else wasUp = await RunSocket(token!).ConfigureAwait(false);
                }
                catch (Exception e) when (e is WebSocketException || e is IOException || e is OperationCanceledException || e is InvalidOperationException || e is HttpRequestException)
                {
                    lock (_gate) { if (!_connected && !_polling) _socketFailedAt = DateTime.UtcNow; }   // the socket never came up: long-poll for a while
                }
                lock (_gate)
                {
                    _connected = false;
                    _socket = null;
                    _polling = false;
                }
                if (wasUp) { delay = _o.ReconnectMin; Append(Local("disconnected")); }
                if (!ShouldRun()) break;
                await Pause(delay).ConfigureAwait(false);
                delay = TimeSpan.FromMilliseconds(Math.Min(_o.ReconnectMax.TotalMilliseconds, delay.TotalMilliseconds * 2));
            }
            lock (_gate) { _connected = false; _socket = null; }
        }

        /// <summary>Behind the portal (under /recharge/) WebSocket upgrades never get through; elsewhere only a recent failure switches over.</summary>
        private bool UsePolling()
        {
            if (_o.BaseUrl().Contains("/recharge/", StringComparison.Ordinal)) return true;
            lock (_gate) return DateTime.UtcNow - _socketFailedAt < _o.SocketRetry;
        }

        private async Task PostPresence(string text)
        {
            string? token = _o.Token();
            if (string.IsNullOrEmpty(token)) return;
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Post, _o.BaseUrl() + "/api/presence?sid=" + _sid);
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                req.Content = new StringContent(text, Encoding.UTF8, "application/json");
                using HttpResponseMessage res = await Http.SendAsync(req).ConfigureAwait(false);
            }
            catch (Exception e) when (e is HttpRequestException || e is TaskCanceledException) { }
        }

        /// <summary>Long-polling: GET /api/events waits on the server up to PollWaitSeconds and answers as soon as something happens.</summary>
        private async Task<bool> RunPoll(string token)
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
            lock (_gate) { _pollCts = cts; }
            _sid = Guid.NewGuid().ToString("N");
            long serverSeq = 0;
            bool up = false;
            string presence;
            while (ShouldRun())
            {
                string url = _o.BaseUrl() + "/api/events?since=" + serverSeq + "&wait=" + _o.PollWaitSeconds + "&sid=" + _sid;
                using var req = new HttpRequestMessage(HttpMethod.Get, url);
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                string text;
                try
                {
                    using HttpResponseMessage res = await PollHttp.SendAsync(req, cts.Token).ConfigureAwait(false);
                    if (!res.IsSuccessStatusCode) return up;
                    text = await res.Content.ReadAsStringAsync(cts.Token).ConfigureAwait(false);
                }
                catch (Exception e) when (e is HttpRequestException || e is TaskCanceledException || e is OperationCanceledException) { return up; }

                JsonObject? body;
                try { body = JsonReader.Parse(text) as JsonObject; }
                catch (Exception) { return up; }
                if (body is null) return up;
                if (!up)
                {
                    up = true;
                    lock (_gate) { _connected = true; _polling = true; presence = _presenceFrame; }
                    Append(Local("connected"));
                    _ = PostPresence(presence);
                }
                if (body["seq"] is JsonNumber n) serverSeq = n.AsInt64();
                if (body["events"] is JsonArray events)
                {
                    foreach (JsonNode e in events) if (e is JsonObject frame) Append(frame);
                }
            }
            return up;
        }

        private async Task Pause(TimeSpan span)
        {
            try { await Task.Delay(span, _cts.Token).ConfigureAwait(false); }
            catch (OperationCanceledException) { }
        }

        private static JsonObject Local(string type)
        {
            var o = new JsonObject();
            o["type"] = new JsonString(type);
            return o;
        }

        private async Task<bool> RunSocket(string token)
        {
            string url = _o.BaseUrl();
            url = (url.StartsWith("https://", StringComparison.Ordinal) ? "wss://" + url.Substring(8) : "ws://" + url.Substring(7)) + "/ws";
            using var socket = new ClientWebSocket();
            socket.Options.SetRequestHeader("Authorization", "Bearer " + token);
            socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
            using var connectTimeout = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
            connectTimeout.CancelAfter(TimeSpan.FromSeconds(10));
            await socket.ConnectAsync(new Uri(url), connectTimeout.Token).ConfigureAwait(false);

            string presence;
            lock (_gate)
            {
                _socket = socket;
                _connected = true;
                presence = _presenceFrame;
            }
            Append(Local("connected"));
            await SendFrame(socket, presence).ConfigureAwait(false);

            var buffer = new byte[16 * 1024];
            using var lease = new Timer(_ => { if (!ShouldRun()) { try { socket.Abort(); } catch (ObjectDisposedException) { } } }, null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
            while (socket.State == WebSocketState.Open)
            {
                using var ms = new MemoryStream();
                WebSocketReceiveResult res;
                do
                {
                    res = await socket.ReceiveAsync(buffer, _cts.Token).ConfigureAwait(false);
                    if (res.MessageType == WebSocketMessageType.Close) return true;
                    if (ms.Length + res.Count > 256 * 1024) return true;
                    ms.Write(buffer, 0, res.Count);
                } while (!res.EndOfMessage);
                try
                {
                    if (JsonReader.Parse(Encoding.UTF8.GetString(ms.ToArray())) is JsonObject frame) Append(frame);
                }
                catch (Exception) { /* an unreadable frame is ignored */ }
            }
            return true;
        }

        private void Append(JsonObject frame)
        {
            lock (_gate)
            {
                frame["seq"] = JsonNumber.From(++_seq);
                _events.Add(frame);
                if (_events.Count > _o.MaxEvents)
                {
                    int drop = _events.Count - _o.MaxEvents;
                    _events.RemoveRange(0, drop);
                    _dropped += drop;
                }
            }
        }

        /// <summary>Everything after <paramref name="since"/>. reset is true when events the page hadn't seen were dropped.</summary>
        public JsonObject Events(long since)
        {
            var result = new JsonObject();
            var list = new JsonArray();
            lock (_gate)
            {
                bool reset = since < _dropped;
                foreach (JsonObject e in _events)
                {
                    if (((JsonNumber)e["seq"]).AsInt64() > since) list.Add(e);
                }
                result["seq"] = JsonNumber.From(_seq);
                result["connected"] = _connected ? JsonBool.True : JsonBool.False;
                result["reset"] = reset ? JsonBool.True : JsonBool.False;
            }
            result["events"] = list;
            return result;
        }

        public void Dispose()
        {
            lock (_gate)
            {
                _disposed = true;
                _watching = false;
                CloseSocketLocked();
            }
            try { _cts.Cancel(); } catch (ObjectDisposedException) { }
        }
    }
}

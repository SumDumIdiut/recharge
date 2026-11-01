using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Recharge.Core.Json;
using Recharge.Net;

namespace Recharge.App.Lobbies
{
    /// <summary>Timings and endpoint for a <see cref="LobbyHub"/>; tests shorten the times.</summary>
    public sealed class LobbyHubOptions
    {
        public Func<(string Host, int Port)> Endpoint { get; set; } = LobbyHub.EndpointFromEnvironment;
        public TimeSpan PollInterval { get; set; } = TimeSpan.FromSeconds(2);
        /// <summary>A "watch on" lapses after this long without being renewed (the page renews while open).</summary>
        public TimeSpan WatchLease { get; set; } = TimeSpan.FromSeconds(20);
        /// <summary>The relay connection is dropped after this long with no watcher.</summary>
        public TimeSpan IdleDisconnect { get; set; } = TimeSpan.FromSeconds(30);
        public TimeSpan RequestTimeout { get; set; } = TimeSpan.FromSeconds(4);
    }

    /// <summary>
    /// One shared, lazily connected relay client that keeps the latest lobby list. Read-only: it only ever sends
    /// list_lobbies, never host or join. It polls while a page watches and disconnects when nobody has for a while.
    /// </summary>
    public sealed class LobbyHub : IDisposable
    {
        private static readonly Lazy<LobbyHub> Shared = new Lazy<LobbyHub>(() => new LobbyHub(new LobbyHubOptions()));
        public static LobbyHub Instance => Shared.Value;

        private readonly LobbyHubOptions _o;
        private readonly object _gate = new object();
        private readonly SemaphoreSlim _fetch = new SemaphoreSlim(1, 1);
        private NetClient? _client;
        private Timer? _timer;
        private int _ticking;
        private bool _watching;
        private DateTime _watchRenewed = DateTime.MinValue;
        private DateTime _idleSince = DateTime.UtcNow;
        private List<LobbyInfo> _lobbies = new List<LobbyInfo>();
        private DateTime _fetchedAt = DateTime.MinValue;
        private string? _error;
        private bool _everFetched;
        private bool _disposed;

        public LobbyHub(LobbyHubOptions options) { _o = options; }

        /// <summary>RECHARGE_RELAY=host:port, else codecade.co.za:443.</summary>
        public static (string Host, int Port) EndpointFromEnvironment()
        {
            string? v = Environment.GetEnvironmentVariable("RECHARGE_RELAY");
            if (!string.IsNullOrWhiteSpace(v))
            {
                v = v!.Trim();
                int colon = v.LastIndexOf(':');
                if (colon > 0 && int.TryParse(v.Substring(colon + 1), NumberStyles.None, CultureInfo.InvariantCulture, out int port) && port > 0 && port < 65536)
                    return (v.Substring(0, colon), port);
                if (colon < 0) return (v, NetUri.DefaultPort);
            }
            return (NetUri.DefaultHost, NetUri.DefaultPort);
        }

        public bool IsWatching
        {
            get { lock (_gate) return _watching && DateTime.UtcNow - _watchRenewed < _o.WatchLease; }
        }

        public bool IsConnected => _client != null && _client.IsConnected;

        /// <summary>The page turns polling on (and renews it) or off.</summary>
        public void Watch(bool on)
        {
            lock (_gate)
            {
                if (_disposed) return;
                if (on) { _watching = true; _watchRenewed = DateTime.UtcNow; }
                else if (_watching) { _watching = false; _idleSince = DateTime.UtcNow; }
                EnsureTimer();
            }
            if (on) _ = Task.Run(() => FetchAsync(TimeSpan.FromMilliseconds(1)));
        }

        private void EnsureTimer()
        {
            if (_timer == null)
                _timer = new Timer(_ => Tick(), null, _o.PollInterval, _o.PollInterval);
        }

        private void Tick()
        {
            if (Interlocked.Exchange(ref _ticking, 1) == 1) return;
            try
            {
                if (IsWatching)
                {
                    FetchAsync(TimeSpan.Zero).GetAwaiter().GetResult();
                    return;
                }
                lock (_gate)
                {
                    if (_watching) { _watching = false; _idleSince = DateTime.UtcNow; } // lease lapsed
                }
                NetClient? client = _client;
                if (client != null && DateTime.UtcNow - _idleSince >= _o.IdleDisconnect)
                {
                    client.Disconnect();
                    client.Dispose();
                    _client = null;
                }
            }
            catch { }
            finally { Interlocked.Exchange(ref _ticking, 0); }
        }

        /// <summary>The latest list, fetching first when it is older than a poll or two (so a one-off call still works).</summary>
        public async Task<JsonObject> ListAsync()
        {
            bool first;
            lock (_gate) { first = !_everFetched; EnsureTimer(); if (!_watching) _idleSince = DateTime.UtcNow; }
            await FetchAsync(first ? TimeSpan.Zero : _o.PollInterval + _o.PollInterval).ConfigureAwait(false);
            return Snapshot();
        }

        private async Task FetchAsync(TimeSpan maxAge)
        {
            if (!await _fetch.WaitAsync(_o.RequestTimeout + _o.RequestTimeout).ConfigureAwait(false)) return;
            try
            {
                if (_disposed) return;
                if (maxAge > TimeSpan.Zero && DateTime.UtcNow - _fetchedAt < maxAge) return;
                NetClient client = _client ??= new NetClient();
                if (!client.IsConnected)
                {
                    if (client.AutoReconnect)
                    {
                        // The client is already retrying every 3 s; give it a moment.
                        await Task.Delay(300).ConfigureAwait(false);
                        if (!client.IsConnected) { SetError(client.LastError ?? "not connected"); return; }
                    }
                    else
                    {
                        (string host, int port) = _o.Endpoint();
                        using var cts = new CancellationTokenSource(_o.RequestTimeout);
                        try { await client.ConnectAsync(host, port, cts.Token).ConfigureAwait(false); }
                        catch (Exception e) { SetError(Describe(e, client)); return; }
                    }
                }
                try
                {
                    IReadOnlyList<LobbyInfo> list = await client.ListLobbiesAsync((int)_o.RequestTimeout.TotalMilliseconds).ConfigureAwait(false);
                    lock (_gate)
                    {
                        _lobbies = new List<LobbyInfo>(list);
                        _fetchedAt = DateTime.UtcNow;
                        _everFetched = true;
                        _error = null;
                    }
                }
                catch (Exception e) { SetError(Describe(e, client)); }
            }
            finally { _fetch.Release(); }
        }

        private static string Describe(Exception e, NetClient c) => e is TimeoutException || e is OperationCanceledException ? "the relay did not answer" : (c.LastError ?? e.Message);

        private void SetError(string message)
        {
            lock (_gate) { _error = message; _everFetched = true; _fetchedAt = DateTime.UtcNow; }
        }

        public JsonObject Snapshot()
        {
            var result = new JsonObject();
            var arr = new JsonArray();
            string? error;
            lock (_gate)
            {
                error = _error;
                foreach (LobbyInfo l in _lobbies) arr.Add(LobbyJson(l));
                if (error != null) arr.Clear();
            }
            result["connected"] = IsConnected ? JsonBool.True : JsonBool.False;
            result["error"] = error == null ? (JsonNode)JsonNull.Instance : new JsonString(error);
            result["lobbies"] = arr;
            return result;
        }

        public JsonObject Status()
        {
            var o = new JsonObject();
            (string host, int port) = _o.Endpoint();
            string? error;
            lock (_gate) error = _error;
            bool connected = IsConnected;
            o["connected"] = connected ? JsonBool.True : JsonBool.False;
            o["state"] = new JsonString(connected ? "connected" : error != null ? "error" : _client != null ? "connecting" : "idle");
            o["error"] = error == null ? (JsonNode)JsonNull.Instance : new JsonString(error);
            o["host"] = new JsonString(host);
            o["port"] = JsonNumber.From((long)port);
            o["watching"] = IsWatching ? JsonBool.True : JsonBool.False;
            return o;
        }

        public static JsonObject LobbyJson(LobbyInfo l)
        {
            var o = new JsonObject();
            o["id"] = JsonNumber.From((long)l.Id);
            o["name"] = new JsonString(l.Name);
            o["hostName"] = new JsonString(l.HostName);
            o["hostColor"] = new JsonString(l.HostColor);
            o["count"] = JsonNumber.From((long)l.Count);
            o["hard"] = l.Hard ? JsonBool.True : JsonBool.False;
            o["mapHubId"] = l.MapHubId == null ? (JsonNode)JsonNull.Instance : new JsonString(l.MapHubId);
            o["mapName"] = l.MapName == null ? (JsonNode)JsonNull.Instance : new JsonString(l.MapName);
            return o;
        }

        public void Dispose()
        {
            lock (_gate) { _disposed = true; _timer?.Dispose(); _timer = null; }
            _client?.Dispose();
            _client = null;
        }
    }
}

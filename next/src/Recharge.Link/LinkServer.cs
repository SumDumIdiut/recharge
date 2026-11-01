using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Recharge.Core.Json;

namespace Recharge.Link;

/// <summary>The app's end of the channel: listens on 127.0.0.1, admits one authenticated game, sends intents and keeps the game's state.</summary>
public sealed class LinkServer : IDisposable
{
    private readonly LinkOptions _opt;
    private readonly object _gate = new object();
    private readonly CancellationTokenSource _cts = new CancellationTokenSource();
    private readonly ConcurrentDictionary<int, Task> _handshakes = new ConcurrentDictionary<int, Task>();
    private readonly ConcurrentDictionary<TcpClient, bool> _pendingSockets = new ConcurrentDictionary<TcpClient, bool>();
    private readonly ConcurrentDictionary<string, TaskCompletionSource<IntentAck>> _pending =
        new ConcurrentDictionary<string, TaskCompletionSource<IntentAck>>();
    private readonly Dictionary<string, JsonNode> _state = new Dictionary<string, JsonNode>(StringComparer.Ordinal);
    private TcpListener? _listener;
    private Task _acceptTask = Task.CompletedTask;
    private LinkChannel? _channel;
    private int _nextHandshake;
    private long _nextIntent;
    private bool _disposed;

    public LinkServer(LinkOptions? options = null, string? token = null)
    {
        _opt = options ?? new LinkOptions();
        Token = token ?? NewToken();
    }

    /// <summary>The per-launch secret: 32 random bytes as lower-case hex.</summary>
    public string Token { get; }

    /// <summary>The port the OS picked; 0 until <see cref="Start"/>.</summary>
    public int Port { get; private set; }

    public bool IsConnected { get { lock (_gate) return _channel != null; } }

    /// <summary>The value for <c>RECHARGE_LINK</c> in the game's environment.</summary>
    public string EnvironmentValue => Port + ":" + Token;

    /// <summary>A snapshot of the latest value per state key.</summary>
    public IReadOnlyDictionary<string, JsonNode> State
    {
        get { lock (_gate) return new Dictionary<string, JsonNode>(_state, StringComparer.Ordinal); }
    }

    public event Action? Connected;
    public event Action? Disconnected;
    public event Action<StateChange>? StateChanged;

    public static string NewToken()
    {
        var bytes = new byte[32];
        using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
        var sb = new StringBuilder(64);
        foreach (var b in bytes) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }

    public void Start()
    {
        lock (_gate)
        {
            if (_disposed) throw new ObjectDisposedException(nameof(LinkServer));
            if (_listener != null) throw new InvalidOperationException("already started");
            var l = new TcpListener(IPAddress.Loopback, 0);
            l.Start();
            _listener = l;
            Port = ((IPEndPoint)l.LocalEndpoint).Port;
            _acceptTask = Task.Run(() => AcceptLoop(l));
        }
    }

    private async Task AcceptLoop(TcpListener l)
    {
        while (!_cts.IsCancellationRequested)
        {
            TcpClient tcp;
            try { tcp = await l.AcceptTcpClientAsync().ConfigureAwait(false); }
            catch (Exception) { return; }
            int id = Interlocked.Increment(ref _nextHandshake);
            _pendingSockets[tcp] = true;
            _handshakes[id] = Task.Run(async () =>
            {
                try { await Handshake(tcp).ConfigureAwait(false); }
                catch (Exception) { try { tcp.Close(); } catch (Exception) { } }
                finally { _pendingSockets.TryRemove(tcp, out _); _handshakes.TryRemove(id, out _); }
            });
        }
    }

    private async Task Handshake(TcpClient tcp)
    {
        var stream = tcp.GetStream();
        if (IsConnected) { await Refuse(tcp, stream).ConfigureAwait(false); return; }

        using var timeout = new CancellationTokenSource(_opt.HelloTimeout);
        using var link = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, _cts.Token);
        using (link.Token.Register(() => { try { tcp.Close(); } catch (Exception) { } }))
        {
            JsonObject? hello;
            try { hello = await Frames.ReadAsync(stream, _opt.MaxFrameBytes, link.Token).ConfigureAwait(false); }
            catch (Exception) { tcp.Close(); return; }
            if (hello == null || !ValidHello(hello)) { tcp.Close(); return; }
        }

        LinkChannel channel;
        lock (_gate)
        {
            if (_disposed) { tcp.Close(); return; }
            if (_channel != null) { channel = null!; }
            else
            {
                channel = new LinkChannel(tcp, _opt, OnMessage, () => OnChannelClosed(tcp));
                _channel = channel;
            }
        }
        if (channel == null) { await Refuse(tcp, stream).ConfigureAwait(false); return; }

        var welcome = Frames.Msg("welcome");
        welcome["v"] = JsonNumber.From(1);
        try { await Frames.WriteAsync(stream, welcome, _opt.MaxFrameBytes, _cts.Token).ConfigureAwait(false); }
        catch (Exception) { channel.Close(); return; }
        channel.Start();
        Raise(Connected);
    }

    private bool ValidHello(JsonObject h)
    {
        if (Frames.Str(h, "t") != "hello" || Frames.Str(h, "role") != "game") return false;
        if (!(h.TryGetValue("v", out var v) && v is JsonNumber n && n.Raw == "1")) return false;
        return ConstantTimeEquals(Frames.Str(h, "token") ?? "", Token);
    }

    internal static bool ConstantTimeEquals(string a, string b)
    {
        var x = Encoding.UTF8.GetBytes(a);
        var y = Encoding.UTF8.GetBytes(b);
        int diff = x.Length ^ y.Length;
        for (int i = 0; i < y.Length; i++) diff |= (i < x.Length ? x[i] : 0) ^ y[i];
        return diff == 0;
    }

    private async Task Refuse(TcpClient tcp, NetworkStream stream)
    {
        try
        {
            var err = Frames.Msg("error");
            err["error"] = new JsonString("already connected");
            await Frames.WriteAsync(stream, err, _opt.MaxFrameBytes, _cts.Token).ConfigureAwait(false);
        }
        catch (Exception) { }
        try { tcp.Close(); } catch (Exception) { }
    }

    private Task OnMessage(JsonObject msg)
    {
        switch (Frames.Str(msg, "t"))
        {
            case "state":
                var key = Frames.Str(msg, "key");
                if (key == null) break;
                var value = msg.TryGetValue("value", out var v) ? v : JsonNull.Instance;
                bool changed;
                lock (_gate)
                {
                    changed = !(_state.TryGetValue(key, out var old) && JsonNode.DeepEquals(old, value));
                    if (changed) _state[key] = value;
                }
                if (changed) { try { StateChanged?.Invoke(new StateChange(key, value)); } catch (Exception) { } }
                break;
            case "ack":
                var id = Frames.Str(msg, "id");
                if (id != null && _pending.TryRemove(id, out var tcs))
                {
                    bool ok = msg.TryGetValue("ok", out var okNode) && okNode is JsonBool b && b.Value;
                    tcs.TrySetResult(new IntentAck(id, ok, Frames.Str(msg, "error")));
                }
                break;
        }
        return Task.CompletedTask;
    }

    private void OnChannelClosed(TcpClient tcp)
    {
        bool was;
        lock (_gate)
        {
            was = _channel != null;
            _channel = null;
            _state.Clear();
        }
        foreach (var kv in _pending)
            if (_pending.TryRemove(kv.Key, out var tcs)) tcs.TrySetResult(new IntentAck(kv.Key, false, "disconnected"));
        if (was) Raise(Disconnected);
    }

    /// <summary>Sends an intent to the game and waits for its ack. A missing game, a drop or a timeout come back as a failed ack, not an exception.</summary>
    public async Task<IntentAck> SendIntentAsync(string kind, JsonNode? args, TimeSpan timeout)
    {
        LinkChannel? ch;
        lock (_gate) ch = _channel;
        var id = "i" + Interlocked.Increment(ref _nextIntent).ToString();
        if (ch == null) return new IntentAck(id, false, "not connected");
        var tcs = new TaskCompletionSource<IntentAck>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = tcs;
        var msg = Frames.Msg("intent");
        msg["id"] = new JsonString(id);
        msg["kind"] = new JsonString(kind);
        msg["args"] = args ?? JsonNull.Instance;
        try
        {
            if (!await ch.SendAsync(msg).ConfigureAwait(false))
            {
                _pending.TryRemove(id, out _);
                return new IntentAck(id, false, "not connected");
            }
            var done = await Task.WhenAny(tcs.Task, Task.Delay(timeout)).ConfigureAwait(false);
            if (done == tcs.Task) return tcs.Task.Result;
            _pending.TryRemove(id, out _);
            return new IntentAck(id, false, "timeout");
        }
        catch (Exception e)
        {
            _pending.TryRemove(id, out _);
            return new IntentAck(id, false, e.Message);
        }
    }

    private static void Raise(Action? a)
    {
        try { a?.Invoke(); } catch (Exception) { }
    }

    public void Dispose()
    {
        LinkChannel? ch;
        TcpListener? l;
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            ch = _channel;
            l = _listener;
        }
        try { _cts.Cancel(); } catch (ObjectDisposedException) { }
        try { l?.Stop(); } catch (Exception) { }
        foreach (var s in _pendingSockets.Keys) { try { s.Close(); } catch (Exception) { } }
        ch?.Dispose();
        try { _acceptTask.Wait(2000); } catch (Exception) { }
        try { Task.WaitAll(new List<Task>(_handshakes.Values).ToArray(), 2000); } catch (Exception) { }
        _cts.Dispose();
    }
}

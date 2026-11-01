using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using Recharge.Core.Json;

namespace Recharge.Link;

/// <summary>The game's end of the channel (RechargeLoader 2): connects to the app, runs intents, publishes state, reconnects on its own.</summary>
public sealed class LinkClient : IDisposable
{
    public const string EnvironmentVariable = "RECHARGE_LINK";

    private readonly LinkOptions _opt;
    private readonly object _gate = new object();
    private readonly CancellationTokenSource _cts = new CancellationTokenSource();
    private readonly Dictionary<string, Func<JsonNode, Task>> _handlers = new Dictionary<string, Func<JsonNode, Task>>(StringComparer.Ordinal);
    private readonly Dictionary<string, JsonNode> _state = new Dictionary<string, JsonNode>(StringComparer.Ordinal);
    private readonly TaskCompletionSource<bool> _firstConnect = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _port;
    private string _token;
    private LinkChannel? _channel;
    private Task _loop = Task.CompletedTask;
    private bool _started;
    private bool _disposed;

    public LinkClient(int port, string token, LinkOptions? options = null)
    {
        _port = port;
        _token = token;
        _opt = options ?? new LinkOptions();
    }

    /// <summary>Reads <c>RECHARGE_LINK=&lt;port&gt;:&lt;token&gt;</c>; null when the game wasn't launched by the app.</summary>
    public static LinkClient? FromEnvironment(LinkOptions? options = null) =>
        Parse(Environment.GetEnvironmentVariable(EnvironmentVariable), options);

    public static LinkClient? Parse(string? value, LinkOptions? options = null)
    {
        if (string.IsNullOrEmpty(value)) return null;
        int i = value!.IndexOf(':');
        if (i <= 0 || i == value.Length - 1) return null;
        if (!int.TryParse(value.Substring(0, i), out var port) || port < 1 || port > 65535) return null;
        return new LinkClient(port, value.Substring(i + 1), options);
    }

    public bool IsConnected { get { lock (_gate) return _channel != null; } }

    public event Action? Connected;
    public event Action? Disconnected;

    /// <summary>Points the client at a new server (a restarted app has a new port); takes effect on the next attempt.</summary>
    public void SetEndpoint(int port, string token)
    {
        lock (_gate) { _port = port; _token = token; }
    }

    public void OnIntent(string kind, Func<JsonNode, Task> handler)
    {
        lock (_gate) _handlers[kind] = handler;
    }

    public void OnIntent(string kind, Action<JsonNode> handler) =>
        OnIntent(kind, a => { handler(a); return Task.CompletedTask; });

    /// <summary>Starts connecting (and reconnecting every <see cref="LinkOptions.ReconnectInterval"/>); completes true once the first connection is up, false if cancelled or disposed first.</summary>
    public Task<bool> ConnectAsync(CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (_disposed) throw new ObjectDisposedException(nameof(LinkClient));
            if (!_started)
            {
                _started = true;
                _loop = Task.Run(RunLoop);
            }
        }
        if (!ct.CanBeCanceled) return _firstConnect.Task;
        return WaitFirst(ct);
    }

    private async Task<bool> WaitFirst(CancellationToken ct)
    {
        var cancelled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using (ct.Register(() => cancelled.TrySetResult(false)))
        {
            var done = await Task.WhenAny(_firstConnect.Task, cancelled.Task).ConfigureAwait(false);
            return await done.ConfigureAwait(false);
        }
    }

    /// <summary>Records the value (replayed on every reconnect) and sends it if connected.</summary>
    public async Task SetStateAsync(string key, JsonNode value)
    {
        LinkChannel? ch;
        lock (_gate) { _state[key] = value; ch = _channel; }
        if (ch != null) await ch.SendAsync(StateMsg(key, value)).ConfigureAwait(false);
    }

    private static JsonObject StateMsg(string key, JsonNode value)
    {
        var m = Frames.Msg("state");
        m["key"] = new JsonString(key);
        m["value"] = value;
        return m;
    }

    private async Task RunLoop()
    {
        while (!_cts.IsCancellationRequested)
        {
            var closed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            LinkChannel? ch = null;
            try { ch = await TryConnect(closed).ConfigureAwait(false); }
            catch (Exception) { }
            if (ch != null)
            {
                try { await closed.Task.ConfigureAwait(false); } catch (Exception) { }
                ch.Dispose();
            }
            try { await Task.Delay(_opt.ReconnectInterval, _cts.Token).ConfigureAwait(false); }
            catch (Exception) { return; }
        }
    }

    private async Task<LinkChannel?> TryConnect(TaskCompletionSource<bool> closed)
    {
        int port; string token;
        lock (_gate) { port = _port; token = _token; }
        var tcp = new TcpClient();
        bool handedOver = false;
        try
        {
            using (_cts.Token.Register(() => { try { tcp.Close(); } catch (Exception) { } }))
            using (var timeout = new CancellationTokenSource(_opt.HelloTimeout + _opt.HelloTimeout))
            using (timeout.Token.Register(() => { try { tcp.Close(); } catch (Exception) { } }))
            {
                await tcp.ConnectAsync(IPAddress.Loopback, port).ConfigureAwait(false);
                var stream = tcp.GetStream();
                var hello = Frames.Msg("hello");
                hello["v"] = JsonNumber.From(1);
                hello["role"] = new JsonString("game");
                hello["token"] = new JsonString(token);
                await Frames.WriteAsync(stream, hello, _opt.MaxFrameBytes, _cts.Token).ConfigureAwait(false);
                var reply = await Frames.ReadAsync(stream, _opt.MaxFrameBytes, _cts.Token).ConfigureAwait(false);
                if (reply == null || Frames.Str(reply, "t") != "welcome") return null;
            }
            LinkChannel? channel = null;
            channel = new LinkChannel(tcp, _opt, OnMessage, () =>
            {
                bool was;
                lock (_gate) { was = ReferenceEquals(_channel, channel); if (was) _channel = null; }
                closed.TrySetResult(true);
                if (was) Raise(Disconnected);
            });
            KeyValuePair<string, JsonNode>[] replay;
            lock (_gate)
            {
                _channel = channel;
                replay = new KeyValuePair<string, JsonNode>[_state.Count];
                int n = 0;
                foreach (var kv in _state) replay[n++] = kv;
            }
            handedOver = true;
            channel.Start();
            foreach (var kv in replay) await channel.SendAsync(StateMsg(kv.Key, kv.Value)).ConfigureAwait(false);
            _firstConnect.TrySetResult(true);
            Raise(Connected);
            return channel;
        }
        finally
        {
            if (!handedOver) { try { tcp.Close(); } catch (Exception) { } }
        }
    }

    private async Task OnMessage(JsonObject msg)
    {
        if (Frames.Str(msg, "t") != "intent") return;
        var id = Frames.Str(msg, "id");
        var kind = Frames.Str(msg, "kind");
        if (id == null) return;
        Func<JsonNode, Task>? handler = null;
        LinkChannel? ch;
        lock (_gate)
        {
            ch = _channel;
            if (kind != null) _handlers.TryGetValue(kind, out handler);
        }
        var ack = Frames.Msg("ack");
        ack["id"] = new JsonString(id);
        if (handler == null)
        {
            ack["ok"] = JsonBool.False;
            ack["error"] = new JsonString("unknown intent");
        }
        else
        {
            try
            {
                await handler(msg.TryGetValue("args", out var a) ? a : JsonNull.Instance).ConfigureAwait(false);
                ack["ok"] = JsonBool.True;
            }
            catch (Exception e)
            {
                ack["ok"] = JsonBool.False;
                ack["error"] = new JsonString(e.Message);
            }
        }
        if (ch != null) await ch.SendAsync(ack).ConfigureAwait(false);
    }

    private static void Raise(Action? a)
    {
        try { a?.Invoke(); } catch (Exception) { }
    }

    public void Dispose()
    {
        LinkChannel? ch;
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            ch = _channel;
        }
        try { _cts.Cancel(); } catch (ObjectDisposedException) { }
        _firstConnect.TrySetResult(false);
        ch?.Dispose();
        try { _loop.Wait(3000); } catch (Exception) { }
        _cts.Dispose();
    }
}

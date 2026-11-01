using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Recharge.Core.Json;

namespace Recharge.Link;

/// <summary>Length-prefixed JSON frames: 4 bytes big-endian length, then UTF-8 compact JSON.</summary>
internal static class Frames
{
    public static async Task WriteAsync(Stream s, JsonObject msg, int max, CancellationToken ct)
    {
        var body = Encoding.UTF8.GetBytes(JsonWriter.Write(msg, 0));
        if (body.Length > max) throw new InvalidDataException("frame too large");
        var buf = new byte[4 + body.Length];
        buf[0] = (byte)(body.Length >> 24);
        buf[1] = (byte)(body.Length >> 16);
        buf[2] = (byte)(body.Length >> 8);
        buf[3] = (byte)body.Length;
        Buffer.BlockCopy(body, 0, buf, 4, body.Length);
        await s.WriteAsync(buf, 0, buf.Length, ct).ConfigureAwait(false);
        await s.FlushAsync(ct).ConfigureAwait(false);
    }

    /// <summary>Reads one frame; null on a clean close before a frame starts. Throws InvalidDataException on a bad length or body.</summary>
    public static async Task<JsonObject?> ReadAsync(Stream s, int max, CancellationToken ct)
    {
        var head = new byte[4];
        if (!await ReadExactAsync(s, head, ct).ConfigureAwait(false)) return null;
        int len = (head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3];
        if (len <= 0 || len > max) throw new InvalidDataException("bad frame length");
        var body = new byte[len];
        if (!await ReadExactAsync(s, body, ct).ConfigureAwait(false)) throw new EndOfStreamException();
        try
        {
            return JsonReader.Parse(Encoding.UTF8.GetString(body)) as JsonObject
                ?? throw new InvalidDataException("frame is not an object");
        }
        catch (JsonParseException e) { throw new InvalidDataException("bad frame json", e); }
    }

    private static async Task<bool> ReadExactAsync(Stream s, byte[] buf, CancellationToken ct)
    {
        int got = 0;
        while (got < buf.Length)
        {
            int n = await s.ReadAsync(buf, got, buf.Length - got, ct).ConfigureAwait(false);
            if (n == 0)
            {
                if (got == 0) return false;
                throw new EndOfStreamException();
            }
            got += n;
        }
        return true;
    }

    public static string? Str(JsonObject o, string key) =>
        o.TryGetValue(key, out var v) && v is JsonString s ? s.Value : null;

    public static JsonObject Msg(string t)
    {
        var o = new JsonObject();
        o["t"] = new JsonString(t);
        return o;
    }
}

/// <summary>One established connection (after the handshake): reads frames, answers pings, watches for silence.</summary>
internal sealed class LinkChannel : IDisposable
{
    private readonly TcpClient _tcp;
    private readonly NetworkStream _stream;
    private readonly LinkOptions _opt;
    private readonly SemaphoreSlim _writeLock = new SemaphoreSlim(1, 1);
    private readonly CancellationTokenSource _cts = new CancellationTokenSource();
    private readonly Func<JsonObject, Task> _onMessage;
    private readonly Action _onClosed;
    private long _lastRx = Stopwatch.GetTimestamp();
    private int _closed;
    private int _disposed;
    private Task _readTask = Task.CompletedTask;
    private Task _pingTask = Task.CompletedTask;

    public LinkChannel(TcpClient tcp, LinkOptions opt, Func<JsonObject, Task> onMessage, Action onClosed)
    {
        _tcp = tcp;
        _stream = tcp.GetStream();
        _opt = opt;
        _onMessage = onMessage;
        _onClosed = onClosed;
    }

    public void Start()
    {
        _readTask = Task.Run(ReadLoop);
        _pingTask = Task.Run(PingLoop);
    }

    public async Task<bool> SendAsync(JsonObject msg)
    {
        if (Volatile.Read(ref _closed) != 0) return false;
        try
        {
            await _writeLock.WaitAsync(_cts.Token).ConfigureAwait(false);
            try { await Frames.WriteAsync(_stream, msg, _opt.MaxFrameBytes, _cts.Token).ConfigureAwait(false); }
            finally { _writeLock.Release(); }
            return true;
        }
        catch (InvalidDataException) { throw; }
        catch (Exception) { Close(); return false; }
    }

    private async Task ReadLoop()
    {
        try
        {
            while (true)
            {
                var msg = await Frames.ReadAsync(_stream, _opt.MaxFrameBytes, _cts.Token).ConfigureAwait(false);
                if (msg == null) break;
                Volatile.Write(ref _lastRx, Stopwatch.GetTimestamp());
                var t = Frames.Str(msg, "t");
                if (t == "ping") { await SendAsync(Frames.Msg("pong")).ConfigureAwait(false); continue; }
                if (t == "pong") continue;
                try { await _onMessage(msg).ConfigureAwait(false); }
                catch (Exception) { /* a handler's failure must not kill the channel */ }
            }
        }
        catch (Exception) { /* closed, cancelled, or a bad frame: all end the connection */ }
        finally { Close(); }
    }

    private async Task PingLoop()
    {
        try
        {
            while (!_cts.IsCancellationRequested)
            {
                await Task.Delay(_opt.PingInterval, _cts.Token).ConfigureAwait(false);
                double silent = (Stopwatch.GetTimestamp() - Volatile.Read(ref _lastRx)) / (double)Stopwatch.Frequency;
                if (silent > _opt.PingTimeout.TotalSeconds) break;
                await SendAsync(Frames.Msg("ping")).ConfigureAwait(false);
            }
        }
        catch (Exception) { }
        finally { Close(); }
    }

    /// <summary>Ends the connection (once) and reports it.</summary>
    public void Close()
    {
        if (Interlocked.Exchange(ref _closed, 1) != 0) return;
        try { _cts.Cancel(); } catch (ObjectDisposedException) { }
        try { _tcp.Close(); } catch (Exception) { }
        try { _onClosed(); } catch (Exception) { }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        Close();
        try { Task.WaitAll(new[] { _readTask, _pingTask }, 2000); } catch (Exception) { }
        _cts.Dispose();
        _writeLock.Dispose();
    }
}

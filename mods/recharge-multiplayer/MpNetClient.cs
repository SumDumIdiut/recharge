using System;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Threading;

internal class MpNetClient : IDisposable
{
	public bool IsConnected => _ws != null && _ws.State == WebSocketState.Open && _running;
	public string LastError { get; private set; }

	private ClientWebSocket _ws;
	private Thread _readThread;
	private volatile bool _running;
	private readonly ConcurrentQueue<string> _incoming = new ConcurrentQueue<string>();

	// Blocking - call from a background thread, never from Update().
	public void Connect(string host, int port)
	{
		Disconnect();
		try
		{
			var uri = BuildUri(host, port);
			_ws = new ClientWebSocket();
			_ws.ConnectAsync(uri, CancellationToken.None).GetAwaiter().GetResult();
			_running = true;
			_readThread = new Thread(ReadLoop) { IsBackground = true };
			_readThread.Start();
			LastError = null;
		}
		catch (Exception e)
		{
			LastError = e.Message;
			Disconnect();
		}
	}

	// Port 443 means "the public relay behind codecade.co.za" - routed through
	// its existing Cloudflare Tunnel at wss://<host>/dotnet, same as how the
	// Tag game's relay rides that tunnel. Anything else is a plain self-hosted
	// ws:// relay on whatever host/port someone's running server.js on.
	private static Uri BuildUri(string host, int port)
		=> port == 443 ? new Uri($"wss://{host}/dotnet") : new Uri($"ws://{host}:{port}/");

	private void ReadLoop()
	{
		var buf = new byte[8192];
		try
		{
			while (_running)
			{
				var sb = new StringBuilder();
				WebSocketReceiveResult result;
				do
				{
					result = _ws.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None).GetAwaiter().GetResult();
					if (result.MessageType == WebSocketMessageType.Close) { _running = false; break; }
					sb.Append(Encoding.UTF8.GetString(buf, 0, result.Count));
				} while (!result.EndOfMessage);
				if (_running && sb.Length > 0) _incoming.Enqueue(sb.ToString());
			}
		}
		catch (Exception e)
		{
			LastError = e.Message;
		}
		_running = false;
	}

	public bool TryDequeue(out string line) => _incoming.TryDequeue(out line);

	public void Send(string json)
	{
		if (!IsConnected) return;
		try
		{
			var bytes = Encoding.UTF8.GetBytes(json);
			_ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None).GetAwaiter().GetResult();
		}
		catch (Exception e)
		{
			LastError = e.Message;
			_running = false;
		}
	}

	public void Disconnect()
	{
		_running = false;
		try { _ws?.Abort(); } catch { }
		try { _ws?.Dispose(); } catch { }
		_ws = null;
		_readThread = null;
		while (_incoming.TryDequeue(out _)) { }
	}

	public void Dispose() => Disconnect();
}

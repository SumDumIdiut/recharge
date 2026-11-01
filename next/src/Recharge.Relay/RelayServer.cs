// Surprising server.js behaviours noted while porting:
//  - `ws.on('message')` runs the rate-limit check and JSON.parse BEFORE handleMessage; malformed JSON
//    is silently ignored (no socket close), and unknown `type` values fall through the switch (no-op).
//  - `msg.lobbyId | 0` coerces lobby ids to int32; missing/non-numeric becomes 0.
//  - `host` with a full server sends `join_failed { reason: "Server is full" }` (not a separate reason).
//  - `game_msg` / `chat` to a client with no lobby are silently dropped (no reply).
//  - `chat` is echoed back to the author too.
//  - On `host` reclaim, `leaveLobby(id)` is called first, which can delete the lobby if it was empty;
//    but reclaim only happens when the lobby still exists, so it survives.
//  - Snapshot `players` spreads the state object (including `lastUpdate`) then strips `lastUpdate`;
//    property order is id,name,nameColor,dotColor,x,y,facingRight,animState,animSpeed,isPaused.
//  - States older than STALE_MS are pruned at the start of every broadcast tick.
//  - `lobby_list` keys iterate in insertion order (JS Map), including gaps from deleted lobbies.
//  - Heartbeat uses ws ping/pong; 3 consecutive misses terminate. .NET 9+ built-in keepalive
//    (KeepAliveInterval/KeepAliveTimeout) provides this; no raw frames or reflection needed.
//  - X-Forwarded-For / CF-Connecting-IP are trusted ONLY when the TCP peer is loopback.
//  - maxPayload exceeded closes the socket with code 1009 (MessageTooBig).
//  - `ws.close(1008, 'rate limit')` on rate-limit violation.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Recharge.Core.Json;

namespace Recharge.Relay
{
    internal sealed class ChatEntry
    {
        public string From { get; set; } = "";
        public string FromColor { get; set; } = "#FFFFFF";
        public string Text { get; set; } = "";
    }

    internal sealed class Lobby
    {
        public string Name { get; set; } = "";
        public int HostId { get; set; }
        public List<int> Members { get; } = new List<int>();
        public List<ChatEntry> ChatHistory { get; } = new List<ChatEntry>();
        public string? MapHubId { get; set; }
        public string? MapName { get; set; }
        public bool Hard { get; set; }
        public string? HostToken { get; set; }
    }

    internal sealed class ClientState
    {
        public double X;
        public double Y;
        public bool FacingRight;
        public int AnimState;
        public double AnimSpeed;
        public bool IsPaused;
        public long LastUpdate;
    }

    internal sealed class Client
    {
        public int Id;
        public TcpClient Tcp = null!;
        public WebSocket WebSocket = null!;
        public string Ip = "";
        public string Name = "";
        public string NameColor = "#FFFFFF";
        public string DotColor = "#3399FF";
        public int? LobbyId;
        public long MsgWindowStart;
        public int MsgCount;
        public bool Removed = false;

        public ConcurrentQueue<byte[]> SendQueue = new ConcurrentQueue<byte[]>();
        public SemaphoreSlim SendSignal = new SemaphoreSlim(0);
        public Task SendPumpTask = Task.CompletedTask;
        public CancellationTokenSource SendCts = new CancellationTokenSource();
        public const int SendQueueCapacity = 1024;
    }

    public sealed class RelayServer
    {
        private static readonly Regex HexColor = new Regex("^#[0-9a-fA-F]{6}$", RegexOptions.Compiled);
        private static readonly Regex TokenRe = new Regex("^[a-zA-Z0-9-]{1,64}$", RegexOptions.Compiled);
        private static readonly Regex MapHubRe = new Regex("^[a-zA-Z0-9-]{1,64}$", RegexOptions.Compiled);

        private readonly RelayOptions _opt;
        private TcpListener _listener = null!;
        private CancellationTokenSource _cts = new CancellationTokenSource();
        private Task _acceptTask = Task.CompletedTask;
        private System.Threading.Timer? _broadcastTimer;

        private readonly object _lock = new object();
        private int _nextId = 1;
        private int _nextLobbyId = 1;
        private readonly Dictionary<int, Client> _clients = new Dictionary<int, Client>();
        private readonly Dictionary<int, ClientState> _states = new Dictionary<int, ClientState>();
        private readonly Dictionary<int, Lobby> _lobbies = new Dictionary<int, Lobby>();
        private readonly Dictionary<string, int> _ipCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        private readonly Dictionary<string, int> _tokenToLobby = new Dictionary<string, int>(StringComparer.Ordinal);

        public int Port { get; private set; }

        public RelayServer(RelayOptions o)
        {
            _opt = o ?? new RelayOptions();
        }

        public Task StartAsync()
        {
            _listener = new TcpListener(IPAddress.Any, _opt.Port);
            _listener.Start();
            Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            _acceptTask = Task.Run(AcceptLoop);
            var period = TimeSpan.FromMilliseconds(1000.0 / _opt.BroadcastHz);
            _broadcastTimer = new System.Threading.Timer(_ => BroadcastTick(), null, period, period);
            return Task.CompletedTask;
        }

        public async Task StopAsync()
        {
            try { _cts.Cancel(); } catch { }
            try { _listener.Stop(); } catch { }
            try { await _acceptTask; } catch { }
            try { _broadcastTimer?.Dispose(); } catch { }
            List<Client> all;
            lock (_lock) { all = _clients.Values.ToList(); }
            foreach (var c in all)
            {
                try { c.SendCts.Cancel(); } catch { }
                try { c.WebSocket.Abort(); } catch { }
                try { c.Tcp.Close(); } catch { }
            }
        }

        private async Task AcceptLoop()
        {
            while (!_cts.IsCancellationRequested)
            {
                TcpClient tcp;
                try
                {
                    tcp = await _listener.AcceptTcpClientAsync(_cts.Token);
                }
                catch (OperationCanceledException) { break; }
                catch (SocketException) { break; }
                catch (ObjectDisposedException) { break; }
                catch { break; }
                _ = Task.Run(() => HandleConnection(tcp));
            }
        }

        private async Task HandleConnection(TcpClient tcp)
        {
            tcp.NoDelay = true;
            NetworkStream stream;
            try { stream = tcp.GetStream(); }
            catch { try { tcp.Close(); } catch { } return; }

            var request = await ReadHttpRequest(stream, _cts.Token);
            if (request == null)
            {
                try { tcp.Close(); } catch { }
                return;
            }

            string ip = GetClientIp(tcp, request);

            lock (_lock)
            {
                if (_clients.Count >= _opt.MaxConnections)
                {
                    _ = WriteHttpResponse(stream, 503, "Server full");
                    try { tcp.Close(); } catch { }
                    return;
                }
                if (_ipCounts.TryGetValue(ip, out var cnt) && cnt >= _opt.MaxConnectionsPerIp)
                {
                    _ = WriteHttpResponse(stream, 429, "Too many connections from this address");
                    try { tcp.Close(); } catch { }
                    return;
                }
            }

            if (!IsWebSocketUpgrade(request))
            {
                _ = WriteHttpResponse(stream, 400, "Bad Request");
                try { tcp.Close(); } catch { }
                return;
            }

            string? key = GetHeader(request, "sec-websocket-key");
            if (string.IsNullOrEmpty(key))
            {
                _ = WriteHttpResponse(stream, 400, "Bad Request");
                try { tcp.Close(); } catch { }
                return;
            }

            string accept = ComputeAccept(key!);

            var sb = new StringBuilder();
            sb.Append("HTTP/1.1 101 Switching Protocols\r\n");
            sb.Append("Upgrade: websocket\r\n");
            sb.Append("Connection: Upgrade\r\n");
            sb.Append("Sec-WebSocket-Accept: ").Append(accept).Append("\r\n\r\n");
            var respBytes = Encoding.ASCII.GetBytes(sb.ToString());
            try { await stream.WriteAsync(respBytes, 0, respBytes.Length, _cts.Token); }
            catch { try { tcp.Close(); } catch { } return; }

            WebSocket ws;
            try
            {
                ws = WebSocket.CreateFromStream(stream, new WebSocketCreationOptions
                {
                    IsServer = true,
                    KeepAliveInterval = _opt.KeepAliveInterval,
                    KeepAliveTimeout = _opt.KeepAliveTimeout,
                });
            }
            catch
            {
                try { tcp.Close(); } catch { }
                return;
            }

            Client client;
            lock (_lock)
            {
                _ipCounts[ip] = (_ipCounts.TryGetValue(ip, out var c) ? c : 0) + 1;
                client = new Client
                {
                    Id = _nextId++,
                    Tcp = tcp,
                    WebSocket = ws,
                    Ip = ip,
                    Name = "Player" + (_nextId - 1),
                    MsgWindowStart = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                };
                client.Name = "Player" + client.Id;
                _clients[client.Id] = client;
                client.SendPumpTask = Task.Run(() => SendPump(client));
            }

            EnqueueSendLocked(client, BuildWelcome(client.Id));

            await ReceiveLoop(client);

            RemoveClient(client.Id);
        }

        private async Task ReceiveLoop(Client client)
        {
            var buffer = new byte[_opt.MaxPayloadBytes + 1024];
            var ms = new MemoryStream();
            try
            {
                while (client.WebSocket.State == WebSocketState.Open && !_cts.IsCancellationRequested)
                {
                    ms.SetLength(0);
                    WebSocketReceiveResult res;
                    try
                    {
                        do
                        {
                            res = await client.WebSocket.ReceiveAsync(new ArraySegment<byte>(buffer), _cts.Token);
                            if (res.MessageType == WebSocketMessageType.Close)
                            {
                                try { await client.WebSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None); } catch { }
                                return;
                            }
                            ms.Write(buffer, 0, res.Count);
                            if (ms.Length > _opt.MaxPayloadBytes)
                            {
                                try { await client.WebSocket.CloseAsync(WebSocketCloseStatus.MessageTooBig, "message too big", CancellationToken.None); } catch { }
                                return;
                            }
                        } while (!res.EndOfMessage);
                    }
                    catch (WebSocketException) { return; }
                    catch (IOException) { return; }
                    catch (OperationCanceledException) { return; }

                    long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    if (now - client.MsgWindowStart >= 1000)
                    {
                        client.MsgWindowStart = now;
                        client.MsgCount = 0;
                    }
                    client.MsgCount++;
                    if (client.MsgCount > _opt.MaxMsgsPerSec)
                    {
                        try { await client.WebSocket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "rate limit", CancellationToken.None); } catch { }
                        return;
                    }

                    string text = Encoding.UTF8.GetString(ms.ToArray());
                    JsonObject? msg = null;
                    try
                    {
                        var node = JsonReader.Parse(text);
                        if (node is JsonObject o) msg = o;
                    }
                    catch
                    {
                        continue;
                    }
                    if (msg == null) continue;

                    lock (_lock)
                    {
                        if (_clients.ContainsKey(client.Id))
                        {
                            HandleMessage(client.Id, msg);
                        }
                    }
                }
            }
            catch { }
        }

        private async Task SendPump(Client client)
        {
            try
            {
                while (!client.SendCts.IsCancellationRequested)
                {
                    await client.SendSignal.WaitAsync(client.SendCts.Token);
                    while (client.SendQueue.TryDequeue(out var data))
                    {
                        try
                        {
                            if (client.WebSocket.State == WebSocketState.Open)
                            {
                                await client.WebSocket.SendAsync(new ArraySegment<byte>(data), WebSocketMessageType.Text, true, client.SendCts.Token);
                            }
                        }
                        catch { return; }
                    }
                }
            }
            catch (OperationCanceledException) { }
            catch { }
        }

        private void RemoveClient(int id)
        {
            Client? c = null;
            lock (_lock)
            {
                if (!_clients.TryGetValue(id, out c)) return;
                if (c.Removed) return;
                c.Removed = true;
                try { c.SendCts.Cancel(); } catch { }
                if (_ipCounts.TryGetValue(c.Ip, out var n))
                {
                    n--;
                    if (n <= 0) _ipCounts.Remove(c.Ip); else _ipCounts[c.Ip] = n;
                }
                LeaveLobbyInternal(id);
                _clients.Remove(id);
                _states.Remove(id);
            }
            if (c == null) return;
            try { c.WebSocket.Abort(); } catch { }
            try { c.Tcp.Close(); } catch { }
        }

        private void LeaveLobbyInternal(int id)
        {
            Client? c = null;
            _clients.TryGetValue(id, out c);
            if (c == null || c.LobbyId == null) return;
            var lobbyId = c.LobbyId.Value;
            if (_lobbies.TryGetValue(lobbyId, out var l))
            {
                l.Members.Remove(id);
                if (l.Members.Count == 0)
                {
                    _lobbies.Remove(lobbyId);
                    if (l.HostToken != null) _tokenToLobby.Remove(l.HostToken);
                }
            }
            c.LobbyId = null;
        }

        private void HandleMessage(int id, JsonObject msg)
        {
            Client? c = _clients.TryGetValue(id, out var cc) ? cc : null;
            if (c == null) return;

            string type = msg.TryGetValue("type", out var tn) && tn is JsonString js ? js.Value : "";

            switch (type)
            {
                case "state":
                    {
                        if (msg.TryGetValue("name", out var n) && n is JsonString ns && ns.Value.Length > 0)
                        {
                            c.Name = SanitizeName(ns.Value, 24);
                        }
                        if (msg.TryGetValue("nameColor", out var nc) && nc is JsonString ncs && HexColor.IsMatch(ncs.Value))
                        {
                            c.NameColor = ncs.Value;
                        }
                        if (msg.TryGetValue("dotColor", out var dc) && dc is JsonString dcs && HexColor.IsMatch(dcs.Value))
                        {
                            c.DotColor = dcs.Value;
                        }
                        var st = new ClientState();
                        if (TryFinite(msg, "x", out var xraw)) st.X = ClampNum(xraw, 0, -1e9, 1e9); else st.X = 0;
                        if (TryFinite(msg, "y", out var yraw)) st.Y = ClampNum(yraw, 0, -1e9, 1e9); else st.Y = 0;
                        st.FacingRight = Truthy(msg.TryGetValue("facingRight", out var fr) ? fr : null);
                        if (TryFinite(msg, "animState", out var asraw)) st.AnimState = ClampInt(ToInt32Js(asraw), 0, 0, 63); else st.AnimState = 0;
                        if (TryFinite(msg, "animSpeed", out var sp)) st.AnimSpeed = ClampNum(sp, 1, -10, 10); else st.AnimSpeed = 1;
                        st.IsPaused = Truthy(msg.TryGetValue("isPaused", out var ip) ? ip : null);
                        st.LastUpdate = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        _states[id] = st;
                        break;
                    }
                case "host":
                    {
                        if (msg.TryGetValue("playerName", out var pn) && pn is JsonString pns && pns.Value.Trim().Length > 0)
                        {
                            c.Name = SanitizeName(pns.Value, 24);
                        }
                        string? token = null;
                        if (msg.TryGetValue("token", out var tk) && tk is JsonString tks && TokenRe.IsMatch(tks.Value))
                        {
                            token = tks.Value;
                        }
                        int? reclaimId = null;
                        if (token != null && _tokenToLobby.TryGetValue(token, out var rid)) reclaimId = rid;
                        Lobby? reclaim = null;
                        if (reclaimId != null && _lobbies.TryGetValue(reclaimId.Value, out var rl)) reclaim = rl;

                        if (reclaim != null)
                        {
                            LeaveLobbyInternal(id);
                            reclaim.HostId = id;
                            if (!reclaim.Members.Contains(id)) reclaim.Members.Add(id);
                            c.LobbyId = reclaimId;
                            var ho = new JsonObject();
                            ho["type"] = new JsonString("hosted");
                            ho["lobbyId"] = JsonNumber.From(reclaimId!.Value);
                            ho["name"] = new JsonString(reclaim.Name);
                            ho["mapHubId"] = reclaim.MapHubId != null ? new JsonString(reclaim.MapHubId) : JsonNull.Instance;
                            ho["mapName"] = reclaim.MapName != null ? new JsonString(reclaim.MapName) : JsonNull.Instance;
                            ho["hard"] = reclaim.Hard ? JsonBool.True : JsonBool.False;
                            EnqueueSendLocked(c, JsonWriter.Write(ho, 0));
                            break;
                        }

                        if (_lobbies.Count >= _opt.MaxLobbies)
                        {
                            var jf = new JsonObject();
                            jf["type"] = new JsonString("join_failed");
                            jf["reason"] = new JsonString("Server is full");
                            EnqueueSendLocked(c, JsonWriter.Write(jf, 0));
                            break;
                        }

                        LeaveLobbyInternal(id);
                        int lobbyId = _nextLobbyId++;
                        string name;
                        if (msg.TryGetValue("name", out var nm) && nm is JsonString nms && nms.Value.Trim().Length > 0)
                        {
                            name = SanitizeName(nms.Value, 32);
                        }
                        else
                        {
                            name = c.Name + "'s lobby";
                        }
                        string? mapHubId = null;
                        if (msg.TryGetValue("mapHubId", out var mh) && mh is JsonString mhs && MapHubRe.IsMatch(mhs.Value))
                        {
                            mapHubId = mhs.Value;
                        }
                        string? mapName = null;
                        if (mapHubId != null && msg.TryGetValue("mapName", out var mn) && mn is JsonString mns)
                        {
                            mapName = SanitizeName(mns.Value, 48);
                        }
                        bool hard = Truthy(msg.TryGetValue("hard", out var hd) ? hd : null);

                        var lobby = new Lobby
                        {
                            Name = name,
                            HostId = id,
                            MapHubId = mapHubId,
                            MapName = mapName,
                            Hard = hard,
                            HostToken = token,
                        };
                        lobby.Members.Add(id);
                        _lobbies[lobbyId] = lobby;
                        if (token != null) _tokenToLobby[token] = lobbyId;
                        c.LobbyId = lobbyId;

                        var ho2 = new JsonObject();
                        ho2["type"] = new JsonString("hosted");
                        ho2["lobbyId"] = JsonNumber.From(lobbyId);
                        ho2["name"] = new JsonString(name);
                        ho2["mapHubId"] = mapHubId != null ? new JsonString(mapHubId) : JsonNull.Instance;
                        ho2["mapName"] = mapName != null ? new JsonString(mapName) : JsonNull.Instance;
                        ho2["hard"] = hard ? JsonBool.True : JsonBool.False;
                        EnqueueSendLocked(c, JsonWriter.Write(ho2, 0));
                        break;
                    }
                case "list_lobbies":
                    {
                        var arr = new JsonArray();
                        foreach (var kv in _lobbies.OrderBy(k => k.Key))
                        {
                            var s = LobbySummary(kv.Key);
                            if (s != null) arr.Add(s);
                        }
                        var lo = new JsonObject();
                        lo["type"] = new JsonString("lobby_list");
                        lo["lobbies"] = arr;
                        EnqueueSendLocked(c, JsonWriter.Write(lo, 0));
                        break;
                    }
                case "join_lobby":
                    {
                        if (msg.TryGetValue("playerName", out var pn) && pn is JsonString pns && pns.Value.Trim().Length > 0)
                        {
                            c.Name = SanitizeName(pns.Value, 24);
                        }
                        int lobbyId = ToInt32(msg.TryGetValue("lobbyId", out var lid) ? lid : null);
                        if (!_lobbies.TryGetValue(lobbyId, out var l))
                        {
                            var jf = new JsonObject();
                            jf["type"] = new JsonString("join_failed");
                            jf["reason"] = new JsonString("Lobby not found");
                            EnqueueSendLocked(c, JsonWriter.Write(jf, 0));
                            break;
                        }
                        if (l.Members.Count >= _opt.MaxLobbyMembers)
                        {
                            var jf = new JsonObject();
                            jf["type"] = new JsonString("join_failed");
                            jf["reason"] = new JsonString("Lobby is full");
                            EnqueueSendLocked(c, JsonWriter.Write(jf, 0));
                            break;
                        }
                        LeaveLobbyInternal(id);
                        if (!l.Members.Contains(id)) l.Members.Add(id);
                        c.LobbyId = lobbyId;

                        var hist = new JsonArray();
                        foreach (var e in l.ChatHistory)
                        {
                            var eo = new JsonObject();
                            eo["from"] = new JsonString(e.From);
                            eo["fromColor"] = new JsonString(e.FromColor);
                            eo["text"] = new JsonString(e.Text);
                            hist.Add(eo);
                        }

                        var jo = new JsonObject();
                        jo["type"] = new JsonString("joined");
                        jo["lobbyId"] = JsonNumber.From(lobbyId);
                        jo["name"] = new JsonString(l.Name);
                        jo["history"] = hist;
                        jo["mapHubId"] = l.MapHubId != null ? new JsonString(l.MapHubId) : JsonNull.Instance;
                        jo["mapName"] = l.MapName != null ? new JsonString(l.MapName) : JsonNull.Instance;
                        jo["hard"] = l.Hard ? JsonBool.True : JsonBool.False;
                        EnqueueSendLocked(c, JsonWriter.Write(jo, 0));
                        break;
                    }
                case "leave_lobby":
                    {
                        LeaveLobbyInternal(id);
                        var le = new JsonObject();
                        le["type"] = new JsonString("left");
                        EnqueueSendLocked(c, JsonWriter.Write(le, 0));
                        break;
                    }
                case "game_msg":
                    {
                        if (c.LobbyId == null) break;
                        if (!_lobbies.TryGetValue(c.LobbyId.Value, out var l)) break;
                        foreach (var memberId in l.Members)
                        {
                            if (!_clients.TryGetValue(memberId, out var mc)) continue;
                            var gm = new JsonObject();
                            gm["type"] = new JsonString("game_msg");
                            gm["from"] = JsonNumber.From(id);
                            if (msg.TryGetValue("payload", out var pl)) gm["payload"] = pl.DeepClone();
                            EnqueueSendLocked(mc, JsonWriter.Write(gm, 0));
                        }
                        break;
                    }
                case "chat":
                    {
                        if (c.LobbyId == null) break;
                        if (!_lobbies.TryGetValue(c.LobbyId.Value, out var l)) break;
                        string text = "";
                        if (msg.TryGetValue("text", out var t) && t is JsonString ts)
                        {
                            text = ts.Value.Length > 240 ? ts.Value.Substring(0, 240) : ts.Value;
                            text = text.Trim();
                        }
                        if (text.Length == 0) break;
                        var entry = new ChatEntry { From = c.Name, FromColor = c.NameColor, Text = text };
                        l.ChatHistory.Add(entry);
                        if (l.ChatHistory.Count > _opt.MaxChatHistory) l.ChatHistory.RemoveAt(0);
                        foreach (var memberId in l.Members)
                        {
                            if (!_clients.TryGetValue(memberId, out var mc)) continue;
                            var ch = new JsonObject();
                            ch["type"] = new JsonString("chat");
                            ch["from"] = new JsonString(entry.From);
                            ch["fromColor"] = new JsonString(entry.FromColor);
                            ch["text"] = new JsonString(entry.Text);
                            EnqueueSendLocked(mc, JsonWriter.Write(ch, 0));
                        }
                        break;
                    }
            }
        }

        private JsonObject? LobbySummary(int lobbyId)
        {
            if (!_lobbies.TryGetValue(lobbyId, out var l)) return null;
            Client? hostClient = _clients.TryGetValue(l.HostId, out var hc) ? hc : null;
            var o = new JsonObject();
            o["id"] = JsonNumber.From(lobbyId);
            o["name"] = new JsonString(l.Name);
            o["hostName"] = new JsonString(hostClient != null ? hostClient.Name : "?");
            o["hostColor"] = new JsonString(hostClient != null ? hostClient.NameColor : "#FFFFFF");
            o["count"] = JsonNumber.From(l.Members.Count);
            o["hard"] = l.Hard ? JsonBool.True : JsonBool.False;
            o["mapHubId"] = l.MapHubId != null ? new JsonString(l.MapHubId) : JsonNull.Instance;
            o["mapName"] = l.MapName != null ? new JsonString(l.MapName) : JsonNull.Instance;
            return o;
        }

        private void BroadcastTick()
        {
            lock (_lock)
            {
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                var stale = new List<int>();
                foreach (var kv in _states)
                {
                    if (now - kv.Value.LastUpdate > _opt.StaleMs) stale.Add(kv.Key);
                }
                foreach (var id in stale) _states.Remove(id);

                foreach (var lkvp in _lobbies.OrderBy(k => k.Key))
                {
                    var l = lkvp.Value;
                    var lobbyId = lkvp.Key;
                    var members = l.Members.ToList();
                    var all = new List<(int id, JsonObject obj)>();
                    foreach (var mid in members.OrderBy(x => x))
                    {
                        if (!_states.TryGetValue(mid, out var st)) continue;
                        if (!_clients.TryGetValue(mid, out var mc)) continue;
                        var po = new JsonObject();
                        po["id"] = JsonNumber.From(mid);
                        po["name"] = new JsonString(mc.Name);
                        po["nameColor"] = new JsonString(mc.NameColor);
                        po["dotColor"] = new JsonString(mc.DotColor);
                        po["x"] = JsonNumber.From(st.X);
                        po["y"] = JsonNumber.From(st.Y);
                        po["facingRight"] = st.FacingRight ? JsonBool.True : JsonBool.False;
                        po["animState"] = JsonNumber.From(st.AnimState);
                        po["animSpeed"] = JsonNumber.From(st.AnimSpeed);
                        po["isPaused"] = st.IsPaused ? JsonBool.True : JsonBool.False;
                        all.Add((mid, po));
                    }

                    foreach (var mid in members)
                    {
                        if (!_clients.TryGetValue(mid, out var mc)) continue;
                        var players = new JsonArray();
                        foreach (var (pid, po) in all)
                        {
                            if (pid == mid) continue;
                            players.Add(po.DeepClone());
                        }
                        var snap = new JsonObject();
                        snap["type"] = new JsonString("snapshot");
                        snap["players"] = players;
                        EnqueueSendLocked(mc, JsonWriter.Write(snap, 0));
                    }
                }
            }
        }

        private void EnqueueSendLocked(Client c, string json)
        {
            if (c.SendQueue.Count >= Client.SendQueueCapacity)
            {
                return;
            }
            var bytes = Encoding.UTF8.GetBytes(json);
            c.SendQueue.Enqueue(bytes);
            try { c.SendSignal.Release(); } catch { }
        }

        private static string BuildWelcome(int id)
        {
            var o = new JsonObject();
            o["type"] = new JsonString("welcome");
            o["id"] = JsonNumber.From(id);
            return JsonWriter.Write(o, 0);
        }

        private static string SanitizeName(string s, int maxLen)
        {
            var sb = new StringBuilder(s.Length);
            foreach (char ch in s)
            {
                if (ch >= '\x00' && ch <= '\x1F') continue;
                if (ch == '\x7F') continue;
                sb.Append(ch);
            }
            var r = sb.ToString();
            if (r.Length > maxLen) r = r.Substring(0, maxLen);
            return r;
        }

        private static bool Truthy(JsonNode? node)
        {
            if (node == null) return false;
            switch (node)
            {
                case JsonBool b: return b.Value;
                case JsonNumber n:
                    try { return double.Parse(n.Raw, CultureInfo.InvariantCulture) != 0; } catch { return false; }
                case JsonString s: return s.Value.Length > 0;
                case JsonObject: return true;
                case JsonArray: return true;
                case JsonNull: return false;
                default: return false;
            }
        }

        private static bool TryFinite(JsonObject obj, string key, out double value)
        {
            value = 0;
            if (!obj.TryGetValue(key, out var node)) return false;
            if (node is JsonNumber n)
            {
                try
                {
                    value = double.Parse(n.Raw, CultureInfo.InvariantCulture);
                    return double.IsFinite(value);
                }
                catch { return false; }
            }
            return false;
        }

        private static double ClampNum(double v, double fallback, double min, double max)
        {
            if (!double.IsFinite(v)) return fallback;
            if (v < min) return min;
            if (v > max) return max;
            return v;
        }

        private static int ClampInt(int v, int fallback, int min, int max)
        {
            if (v < min) return min;
            if (v > max) return max;
            return v;
        }

        private static int ToInt32Js(double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) return 0;
            double mod = d % 4294967296.0;
            if (mod < 0) mod += 4294967296.0;
            uint u = (uint)mod;
            return (int)u;
        }

        private static int ToInt32(JsonNode? node)
        {
            if (node == null) return 0;
            if (node is JsonNumber n)
            {
                try { return ToInt32Js(double.Parse(n.Raw, CultureInfo.InvariantCulture)); } catch { return 0; }
            }
            if (node is JsonString s)
            {
                if (double.TryParse(s.Value, NumberStyles.Any, CultureInfo.InvariantCulture, out var d)) return ToInt32Js(d);
                return 0;
            }
            if (node is JsonBool b) return b.Value ? 1 : 0;
            return 0;
        }

        private sealed class HttpRequest
        {
            public string Method = "";
            public string Path = "";
            public Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }

        private static async Task<HttpRequest?> ReadHttpRequest(NetworkStream stream, CancellationToken ct)
        {
            var sb = new StringBuilder();
            var buf = new byte[1024];
            while (!sb.ToString().Contains("\r\n\r\n"))
            {
                int n;
                try { n = await stream.ReadAsync(buf, 0, buf.Length, ct); }
                catch { return null; }
                if (n <= 0) return null;
                sb.Append(Encoding.ASCII.GetString(buf, 0, n));
                if (sb.Length > 8192) return null;
            }
            var raw = sb.ToString();
            var lines = raw.Split(new[] { "\r\n" }, StringSplitOptions.None);
            if (lines.Length == 0) return null;
            var parts = lines[0].Split(' ');
            if (parts.Length < 2) return null;
            var req = new HttpRequest { Method = parts[0], Path = parts[1] };
            for (int i = 1; i < lines.Length; i++)
            {
                var line = lines[i];
                if (line.Length == 0) break;
                int colon = line.IndexOf(':');
                if (colon < 0) continue;
                var key = line.Substring(0, colon).Trim();
                var val = line.Substring(colon + 1).Trim();
                req.Headers[key] = val;
            }
            return req;
        }

        private static bool IsWebSocketUpgrade(HttpRequest req)
        {
            if (!req.Headers.TryGetValue("Upgrade", out var up)) return false;
            if (!req.Headers.TryGetValue("Connection", out var conn)) return false;
            return up.Equals("websocket", StringComparison.OrdinalIgnoreCase) &&
                   conn.IndexOf("Upgrade", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static string? GetHeader(HttpRequest req, string name)
        {
            return req.Headers.TryGetValue(name, out var v) ? v : null;
        }

        private static string GetClientIp(TcpClient tcp, HttpRequest req)
        {
            var remoteEp = tcp.Client.RemoteEndPoint as IPEndPoint;
            string remote = remoteEp != null ? remoteEp.Address.ToString() : "unknown";
            bool isLoopback = remote == "127.0.0.1" || remote == "::1" || remote == "::ffff:127.0.0.1";
            if (isLoopback)
            {
                if (req.Headers.TryGetValue("cf-connecting-ip", out var cf) && !string.IsNullOrEmpty(cf)) return cf;
                if (req.Headers.TryGetValue("x-forwarded-for", out var xff) && !string.IsNullOrEmpty(xff))
                {
                    var first = xff.Split(',')[0].Trim();
                    if (first.Length > 0) return first;
                }
            }
            return remote;
        }

        private static Task WriteHttpResponse(NetworkStream stream, int status, string message)
        {
            var body = message;
            var sb = new StringBuilder();
            sb.Append($"HTTP/1.1 {status} {Reason(status)}\r\n");
            sb.Append("Content-Type: text/plain\r\n");
            sb.Append($"Content-Length: {Encoding.UTF8.GetByteCount(body)}\r\n");
            sb.Append("Connection: close\r\n\r\n");
            sb.Append(body);
            var bytes = Encoding.UTF8.GetBytes(sb.ToString());
            return stream.WriteAsync(bytes, 0, bytes.Length);
        }

        private static string Reason(int status)
        {
            switch (status)
            {
                case 400: return "Bad Request";
                case 429: return "Too Many Requests";
                case 503: return "Service Unavailable";
                default: return "Error";
            }
        }

        private static string ComputeAccept(string key)
        {
            using var sha1 = SHA1.Create();
            var bytes = sha1.ComputeHash(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
            return Convert.ToBase64String(bytes);
        }
    }
}
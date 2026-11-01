using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Recharge.Core.Json;

namespace Recharge.Net
{
    /// <summary>
    /// The DOTnet protocol client. Events are raised on the receive thread, so handlers that touch UI or Unity
    /// objects must marshal. Data in events is already sanitised for rich text.
    /// </summary>
    public sealed class NetClient : IDisposable
    {
        public static readonly TimeSpan ReconnectInterval = TimeSpan.FromSeconds(3);
        public static readonly TimeSpan MinStateInterval = TimeSpan.FromSeconds(1.0 / 60.0);
        private const int MaxChatLines = 50;

        private enum ResumeMode { None, Host, Join }

        private readonly object _gate = new object();
        private readonly SemaphoreSlim _sendLock = new SemaphoreSlim(1, 1);
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private ClientWebSocket? _ws;
        private CancellationTokenSource? _cts;
        private int _generation;

        private string _host = "";
        private int _port;
        private bool _autoReconnect;
        private ResumeMode _resume = ResumeMode.None;
        private HostMsg? _resumeHost;
        private int _resumeJoinLobbyId;
        private string _playerName = "Player";

        private TaskCompletionSource<WelcomeMsg>? _welcomeTcs;
        private TaskCompletionSource<LobbyListMsg>? _listTcs;
        private TaskCompletionSource<HostedMsg?>? _hostTcs;
        private TaskCompletionSource<JoinedMsg?>? _joinTcs;
        private long _lastStateTicks = long.MinValue;

        /// <summary>The reclaim token: one per client session, presented with every host.</summary>
        public string SessionToken { get; } = Guid.NewGuid().ToString("N");
        public int LocalPlayerId { get; private set; }
        public int CurrentLobbyId { get; private set; }
        public string? CurrentLobbyName { get; private set; }
        public bool InLobby => CurrentLobbyId != 0;
        public bool IsHost { get; private set; }
        public bool AutoReconnect => _autoReconnect;
        public string? LastError { get; private set; }
        public bool IsConnected { get { var ws = _ws; return ws != null && ws.State == WebSocketState.Open; } }
        public IReadOnlyList<PlayerState> LastSnapshotPlayers { get; private set; } = new PlayerState[0];
        public IReadOnlyList<LobbyInfo> LastLobbyList { get; private set; } = new LobbyInfo[0];
        public List<string> ChatLines { get; } = new List<string>();

        public event Action<IReadOnlyList<PlayerState>>? Snapshot;
        public event Action<ChatIn>? Chat;
        public event Action<int, JsonObject>? GameMessage;
        public event Action<IReadOnlyList<LobbyInfo>>? LobbyList;
        public event Action<string>? JoinFailed;
        public event Action<string?>? Disconnected;
        public event Action<int>? Welcome;
        public event Action<HostedMsg>? Hosted;
        public event Action<JoinedMsg>? Joined;
        public event Action? Left;

        // ---- connection ----

        /// <summary>Connects and waits for welcome. Turns auto-reconnect on, so a drop retries every 3 s and resumes.</summary>
        public async Task ConnectAsync(string host, int port, CancellationToken ct = default)
        {
            _host = host;
            _port = port;
            _autoReconnect = true;
            await OpenAsync(ct).ConfigureAwait(false);
        }

        private async Task OpenAsync(CancellationToken ct)
        {
            CloseSocket();
            var ws = new ClientWebSocket();
            var cts = new CancellationTokenSource();
            var welcome = new TaskCompletionSource<WelcomeMsg>(TaskCreationOptions.RunContinuationsAsynchronously);
            int gen;
            lock (_gate)
            {
                _ws = ws;
                _cts = cts;
                _welcomeTcs = welcome;
                gen = ++_generation;
            }
            try
            {
                await ws.ConnectAsync(NetUri.For(_host, _port), ct).ConfigureAwait(false);
            }
            catch (Exception e)
            {
                LastError = e.Message;
                CloseSocket();
                if (_autoReconnect) StartReconnectLoop();
                throw;
            }
            LastError = null;
            _ = Task.Run(() => ReadLoop(ws, cts.Token, gen));
            using (ct.Register(() => welcome.TrySetCanceled()))
            {
                var done = await Task.WhenAny(welcome.Task, Task.Delay(TimeSpan.FromSeconds(10), ct)).ConfigureAwait(false);
                if (done != welcome.Task) throw new TimeoutException("no welcome from the relay");
                await welcome.Task.ConfigureAwait(false);
            }
        }

        /// <summary>A deliberate disconnect: auto-reconnect and resume are off, nothing is replayed.</summary>
        public void Disconnect()
        {
            _autoReconnect = false;
            _resume = ResumeMode.None;
            _resumeHost = null;
            CloseSocket();
            ResetLobby();
            FailPending();
        }

        public void Dispose() => Disconnect();

        private void CloseSocket()
        {
            ClientWebSocket? ws;
            CancellationTokenSource? cts;
            lock (_gate)
            {
                ws = _ws; cts = _cts;
                _ws = null; _cts = null;
                _generation++;
            }
            try { cts?.Cancel(); } catch { }
            if (ws != null)
            {
                try { ws.Abort(); } catch { }
                try { ws.Dispose(); } catch { }
            }
        }

        private void ResetLobby()
        {
            CurrentLobbyId = 0;
            CurrentLobbyName = null;
            IsHost = false;
            LastSnapshotPlayers = new PlayerState[0];
        }

        private void FailPending()
        {
            _welcomeTcs?.TrySetCanceled();
            _listTcs?.TrySetCanceled();
            _hostTcs?.TrySetResult(null);
            _joinTcs?.TrySetResult(null);
        }

        private async Task ReadLoop(ClientWebSocket ws, CancellationToken ct, int gen)
        {
            var buf = new byte[16 * 1024];
            string? error = null;
            try
            {
                while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
                {
                    var ms = new MemoryStream();
                    WebSocketReceiveResult res;
                    do
                    {
                        res = await ws.ReceiveAsync(new ArraySegment<byte>(buf), ct).ConfigureAwait(false);
                        if (res.MessageType == WebSocketMessageType.Close) { error = "closed by the relay"; goto done; }
                        ms.Write(buf, 0, res.Count);
                    } while (!res.EndOfMessage);
                    if (res.MessageType != WebSocketMessageType.Text) continue;
                    var msg = NetMessage.Parse(Encoding.UTF8.GetString(ms.ToArray()));
                    if (msg != null)
                    {
                        try { Handle(msg); } catch (Exception e) { LastError = "handler: " + e.Message; }
                    }
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception e) { error = e.Message; }
        done:
            bool current;
            lock (_gate) current = gen == _generation;
            if (!current) return; // replaced or deliberately closed
            LastError = error ?? LastError;
            lock (_gate) { _ws = null; _generation++; }
            try { ws.Dispose(); } catch { }
            ResetLobby();
            FailPending();
            Disconnected?.Invoke(error);
            if (_autoReconnect) StartReconnectLoop();
        }

        private int _reconnecting;

        private void StartReconnectLoop()
        {
            if (Interlocked.Exchange(ref _reconnecting, 1) == 1) return;
            _ = Task.Run(async () =>
            {
                try
                {
                    while (_autoReconnect)
                    {
                        await Task.Delay(ReconnectInterval).ConfigureAwait(false);
                        if (!_autoReconnect) break;
                        try
                        {
                            // OpenAsync's own failure path must not recurse into a second loop.
                            await OpenQuietAsync().ConfigureAwait(false);
                            break;
                        }
                        catch { }
                    }
                }
                finally { Interlocked.Exchange(ref _reconnecting, 0); }
            });
        }

        private async Task OpenQuietAsync()
        {
            CloseSocket();
            var ws = new ClientWebSocket();
            var cts = new CancellationTokenSource();
            int gen;
            lock (_gate) { _ws = ws; _cts = cts; _welcomeTcs = new TaskCompletionSource<WelcomeMsg>(TaskCreationOptions.RunContinuationsAsynchronously); gen = ++_generation; }
            try { await ws.ConnectAsync(NetUri.For(_host, _port), cts.Token).ConfigureAwait(false); }
            catch (Exception e) { LastError = e.Message; CloseSocket(); throw; }
            LastError = null;
            _ = Task.Run(() => ReadLoop(ws, cts.Token, gen));
        }

        // ---- sending ----

        private async Task SendRawAsync(string json)
        {
            var ws = _ws;
            if (ws == null || ws.State != WebSocketState.Open) return;
            var bytes = Encoding.UTF8.GetBytes(json);
            await _sendLock.WaitAsync().ConfigureAwait(false);
            try
            {
                if (ws.State == WebSocketState.Open)
                    await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception e) { LastError = e.Message; }
            finally { _sendLock.Release(); }
        }

        private void Send(NetMessage m) => _ = SendRawAsync(m.Serialize());

        public Task SendAsync(NetMessage m) => SendRawAsync(m.Serialize());

        // ---- requests ----

        public async Task<IReadOnlyList<LobbyInfo>> ListLobbiesAsync(int timeoutMs = 5000)
        {
            var tcs = new TaskCompletionSource<LobbyListMsg>(TaskCreationOptions.RunContinuationsAsynchronously);
            _listTcs = tcs;
            await SendRawAsync(new ListLobbiesMsg().Serialize()).ConfigureAwait(false);
            var done = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs)).ConfigureAwait(false);
            if (done != tcs.Task) throw new TimeoutException("no lobby_list from the relay");
            return (await tcs.Task.ConfigureAwait(false)).Lobbies;
        }

        /// <summary>Opens a lobby (reclaiming it when the session token already owns one). Null when refused (JoinFailed fires).</summary>
        public async Task<HostedMsg?> HostAsync(string lobbyName, string playerName, string? mapHubId = null, string? mapName = null, bool hard = false, int timeoutMs = 5000)
        {
            _playerName = playerName;
            var msg = new HostMsg { Name = lobbyName, PlayerName = playerName, MapHubId = mapHubId, MapName = mapName, Hard = hard, Token = SessionToken };
            var tcs = new TaskCompletionSource<HostedMsg?>(TaskCreationOptions.RunContinuationsAsynchronously);
            _hostTcs = tcs;
            _resume = ResumeMode.Host;
            _resumeHost = msg;
            await SendRawAsync(msg.Serialize()).ConfigureAwait(false);
            var done = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs)).ConfigureAwait(false);
            if (done != tcs.Task) throw new TimeoutException("no hosted from the relay");
            return await tcs.Task.ConfigureAwait(false);
        }

        /// <summary>Joins a lobby. Null when refused (JoinFailed fires with the reason).</summary>
        public async Task<JoinedMsg?> JoinAsync(int lobbyId, string playerName, int timeoutMs = 5000)
        {
            _playerName = playerName;
            var tcs = new TaskCompletionSource<JoinedMsg?>(TaskCreationOptions.RunContinuationsAsynchronously);
            _joinTcs = tcs;
            _resume = ResumeMode.Join;
            _resumeJoinLobbyId = lobbyId;
            await SendRawAsync(new JoinLobbyMsg { LobbyId = lobbyId, PlayerName = playerName }.Serialize()).ConfigureAwait(false);
            var done = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs)).ConfigureAwait(false);
            if (done != tcs.Task) throw new TimeoutException("no joined from the relay");
            return await tcs.Task.ConfigureAwait(false);
        }

        public async Task LeaveAsync()
        {
            _resume = ResumeMode.None;
            _resumeHost = null;
            await SendRawAsync(new LeaveLobbyMsg().Serialize()).ConfigureAwait(false);
            ResetLobby();
            ChatLines.Clear();
        }

        /// <summary>Sends the local state if in a lobby and at least 1/60 s has passed since the last one. Returns whether it was sent.</summary>
        public bool SendState(StateMsg state)
        {
            if (!InLobby || !IsConnected) return false;
            long now = _clock.ElapsedTicks;
            long min = (long)(Stopwatch.Frequency / 60.0);
            lock (_gate)
            {
                if (_lastStateTicks != long.MinValue && now - _lastStateTicks < min) return false;
                _lastStateTicks = now;
            }
            Send(state);
            return true;
        }

        public bool SendState(double x, double y, bool facingRight, int animState, double animSpeed, bool isPaused, string name, string nameColor, string dotColor)
            => SendState(new StateMsg { X = x, Y = y, FacingRight = facingRight, AnimState = animState, AnimSpeed = animSpeed, IsPaused = isPaused, Name = name, NameColor = nameColor, DotColor = dotColor });

        public void SendChat(string text)
        {
            if (string.IsNullOrWhiteSpace(text) || !InLobby) return;
            Send(new ChatOut { Text = text });
        }

        public void SendGameMessage(JsonObject payload)
        {
            if (!InLobby) return;
            Send(new GameMsgOut { Payload = payload });
        }

        // ---- receiving ----

        private void Handle(NetMessage msg)
        {
            switch (msg)
            {
                case WelcomeMsg w:
                    LocalPlayerId = w.Id;
                    _welcomeTcs?.TrySetResult(w);
                    Welcome?.Invoke(w.Id);
                    // Replay what we were doing before the drop.
                    if (_resume == ResumeMode.Host && _resumeHost != null) Send(_resumeHost);
                    else if (_resume == ResumeMode.Join) Send(new JoinLobbyMsg { LobbyId = _resumeJoinLobbyId, PlayerName = _playerName });
                    break;
                case HostedMsg h:
                    h.Name = NetText.SanitizeForRichText(h.Name);
                    CurrentLobbyId = h.LobbyId;
                    CurrentLobbyName = h.Name;
                    IsHost = true;
                    ChatLines.Clear();
                    _hostTcs?.TrySetResult(h);
                    Hosted?.Invoke(h);
                    break;
                case JoinedMsg j:
                    j.Name = NetText.SanitizeForRichText(j.Name);
                    CurrentLobbyId = j.LobbyId;
                    CurrentLobbyName = j.Name;
                    IsHost = false;
                    ChatLines.Clear();
                    foreach (var e in j.History)
                    {
                        e.From = NetText.SanitizeForRichText(e.From);
                        e.Text = NetText.SanitizeForRichText(e.Text);
                        if (!NetText.IsValidColor(e.FromColor)) e.FromColor = "";
                        ChatLines.Add(NetText.FormatChatLine(e.From, e.FromColor, e.Text));
                    }
                    _joinTcs?.TrySetResult(j);
                    Joined?.Invoke(j);
                    break;
                case JoinFailedMsg f:
                    _resume = ResumeMode.None;
                    _resumeHost = null;
                    ResetLobby();
                    var reason = NetText.SanitizeForRichText(f.Reason);
                    _hostTcs?.TrySetResult(null);
                    _joinTcs?.TrySetResult(null);
                    JoinFailed?.Invoke(reason);
                    break;
                case LeftMsg _:
                    ResetLobby();
                    Left?.Invoke();
                    break;
                case SnapshotMsg s:
                {
                    var list = new List<PlayerState>(s.Players.Count);
                    foreach (var p in s.Players)
                    {
                        if (p.Id == LocalPlayerId) continue; // own echo
                        p.Name = NetText.SanitizeForRichText(p.Name);
                        p.NameColor = NetText.ColorOr(p.NameColor, NetText.DefaultNameColor);
                        p.DotColor = NetText.ColorOr(p.DotColor, NetText.DefaultDotColor);
                        list.Add(p);
                    }
                    LastSnapshotPlayers = list;
                    Snapshot?.Invoke(list);
                    break;
                }
                case LobbyListMsg l:
                    foreach (var lb in l.Lobbies)
                    {
                        lb.Name = NetText.SanitizeForRichText(lb.Name);
                        lb.HostName = NetText.SanitizeForRichText(lb.HostName);
                        lb.HostColor = NetText.ColorOr(lb.HostColor, NetText.DefaultNameColor);
                        if (lb.MapName != null) lb.MapName = NetText.SanitizeForRichText(lb.MapName);
                    }
                    LastLobbyList = l.Lobbies;
                    _listTcs?.TrySetResult(l);
                    LobbyList?.Invoke(l.Lobbies);
                    break;
                case GameMsgIn g:
                    if (g.From == LocalPlayerId) break; // own echo
                    GameMessage?.Invoke(g.From, g.Payload);
                    break;
                case ChatIn c:
                    c.From = NetText.SanitizeForRichText(c.From);
                    c.Text = NetText.SanitizeForRichText(c.Text);
                    if (!NetText.IsValidColor(c.FromColor)) c.FromColor = "";
                    ChatLines.Add(NetText.FormatChatLine(c.From, c.FromColor, c.Text));
                    while (ChatLines.Count > MaxChatLines) ChatLines.RemoveAt(0);
                    Chat?.Invoke(c);
                    break;
            }
        }
    }
}

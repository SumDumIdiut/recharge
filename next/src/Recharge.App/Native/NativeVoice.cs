using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Concentus;
using Concentus.Enums;
using Recharge.App.Account;
using Recharge.App.Social;
using Recharge.Core.Json;
using SIPSorcery.Net;
using SIPSorceryMedia.Abstractions;

namespace Recharge.App.Native
{
    /// <summary>
    /// Voice for hosts without WebRTC (Linux WebKitGTK has no RTCPeerConnection). One SIPSorcery peer connection talks to
    /// our /api/voice/* proxy; Opus frames are coded with Concentus and audio I/O is an ffmpeg CLI subprocess. Presence
    /// stays on the social WebSocket, and state for the page is pushed onto the same numbered feed social.events reads.
    /// </summary>
    public sealed class NativeVoice
    {
        private const int SampleRate = 48000;
        private const int FrameSamples = 960;                 // 20 ms of mono PCM at 48 kHz
        private const int FrameBytes = FrameSamples * 2;      // s16le
        private const string StateType = "voice.native.state";
        private const double SpeakThreshold = 0.015;
        private static readonly TimeSpan SpeakHold = TimeSpan.FromMilliseconds(350);

        private static readonly Lazy<NativeVoice> Shared = new Lazy<NativeVoice>(() => new NativeVoice(() => SocialHub.Instance));
        public static NativeVoice Instance => Shared.Value;

        private readonly Func<SocialHub> _hub;
        private readonly object _gate = new object();
        private readonly object _mixGate = new object();
        private readonly SemaphoreSlim _signaling = new SemaphoreSlim(1, 1);
        private readonly HashSet<string> _subscribed = new HashSet<string>(StringComparer.Ordinal);
        private readonly Dictionary<string, RemoteTrack> _remotes = new Dictionary<string, RemoteTrack>(StringComparer.Ordinal);
        private readonly Dictionary<uint, RemoteTrack> _bySsrc = new Dictionary<uint, RemoteTrack>();
        private readonly Dictionary<string, RemoteTrack> _byMid = new Dictionary<string, RemoteTrack>(StringComparer.Ordinal);
        private readonly int[] _mix = new int[FrameSamples];
        private readonly byte[] _playBytes = new byte[FrameBytes];
        private bool _mixReady;

        private RTCPeerConnection? _pc;
        private Process? _mic;
        private Process? _speaker;
        private Stream? _micStdout;
        private Stream? _speakerStdin;
        private Timer? _playTimer;
        private CancellationTokenSource? _cts;
        private IOpusEncoder? _encoder;
        private RemoteTrack? _pending;
        private string _convId = string.Empty;
        private string _sessionId = string.Empty;
        private string _micMid = string.Empty;
        private string _me = string.Empty;
        private string _kind = "audio";
        private int _generation;
        private bool _joined;
        private bool _muted;
        private bool _deafened;
        private bool _listening;
        private bool _selfSpeaking;
        private DateTime _selfLoud = DateTime.MinValue;

        public NativeVoice(Func<SocialHub> hub)
        {
            _hub = hub ?? throw new ArgumentNullException(nameof(hub));
            // The host is ABI-sensitive; keep Opus in the pure-C# Concentus implementation (no native libopus load).
            OpusCodecFactory.AttemptToUseNativeLibrary = false;
        }

        public bool Joined { get { lock (_gate) return _joined; } }
        public bool Muted { get { lock (_gate) return _muted; } }
        public bool Deafened { get { lock (_gate) return _deafened; } }

        /// <summary>Join the room's SFU session, publish a sendonly Opus track, then start mic capture and playback.</summary>
        public async Task JoinAsync(string convId, string kind, string? username = null)
        {
            if (string.IsNullOrWhiteSpace(convId)) throw new ArgumentException("convId is required", nameof(convId));
            Leave();
            int gen = ++_generation;
            var cts = new CancellationTokenSource();
            lock (_gate)
            {
                _convId = convId;
                _kind = string.IsNullOrEmpty(kind) ? "audio" : kind;
                _me = string.IsNullOrEmpty(username) ? AccountStore.Load()?.Username ?? string.Empty : username!;
                _cts = cts;
                _muted = false;
                _deafened = false;
            }
            Listen();

            try
            {
                await WaitForHub(cts.Token).ConfigureAwait(false);
                if (Stale(gen)) return;
                SendPresence("voice.join", new Dictionary<string, object?> { ["kind"] = _kind });

                JsonElement ice = await Request("GET", "/api/voice/ice", null, cts.Token).ConfigureAwait(false);
                if (Stale(gen)) return;
                JsonElement session = await Request("POST", "/api/voice/session", new { }, cts.Token).ConfigureAwait(false);
                if (Stale(gen)) return;
                string sid = JsonString(session, "sessionId");
                if (string.IsNullOrEmpty(sid)) throw new InvalidOperationException("The voice server didn't return a session.");

                var pc = new RTCPeerConnection(new RTCConfiguration { iceServers = IceServers(ice) });
                pc.oniceconnectionstatechange += state =>
                {
                    if (state == RTCIceConnectionState.connected) PushState("connected");
                };
                pc.OnRtpPacketReceived += (_, media, packet) =>
                {
                    if (media == SDPMediaTypesEnum.audio) OnRtp(packet);
                };

                var opus = new AudioFormat(AudioCodecsEnum.OPUS, 111, 48000, 2, "minptime=10;useinbandfec=1");
                pc.addTrack(new MediaStreamTrack(new List<AudioFormat> { opus }, MediaStreamStatusEnum.SendOnly));

                var offer = pc.createOffer();
                await pc.setLocalDescription(offer).ConfigureAwait(false);
                await WaitGathering(pc, 2500, cts.Token).ConfigureAwait(false);
                if (Stale(gen)) { pc.close(); return; }
                string localSdp = pc.localDescription?.sdp?.ToString() ?? offer.sdp ?? string.Empty;
                string mid = SdpMid(localSdp);
                _micMid = mid;

                JsonElement published = await Request("POST", "/api/voice/session/" + Uri.EscapeDataString(sid) + "/tracks", new
                {
                    sessionDescription = new { type = "offer", sdp = localSdp },
                    tracks = new[] { new { location = "local", mid, trackName = "mic" } },
                }, cts.Token).ConfigureAwait(false);
                if (Stale(gen)) { pc.close(); return; }
                string answer = AnswerSdp(published);
                SetDescriptionResultEnum applied = pc.setRemoteDescription(new RTCSessionDescriptionInit { type = RTCSdpType.answer, sdp = answer });
                if (applied != SetDescriptionResultEnum.OK) throw new InvalidOperationException("The SFU answer was rejected: " + applied);

                lock (_gate)
                {
                    _pc = pc;
                    _sessionId = sid;
                    _joined = true;
                }
                StartMic(gen);
                StartPlayback();
                bool muted;
                lock (_gate) muted = _muted;
                SendPresence("voice.publish", new Dictionary<string, object?>
                {
                    ["sessionId"] = sid, ["tracks"] = new[] { "mic" }, ["muted"] = muted, ["cam"] = false,
                });
                PushState("connected");
            }
            catch (Exception e)
            {
                if (gen == _generation) Leave();
                throw new InvalidOperationException("Native voice couldn't start: " + e.Message, e);
            }
        }

        /// <summary>Leave the room: close SFU tracks, drop the peer connection and stop both ffmpeg processes.</summary>
        public void Leave()
        {
            int gen = ++_generation;
            RTCPeerConnection? pc;
            string sid, mid, conv;
            lock (_gate)
            {
                _cts?.Cancel();
                pc = _pc;
                sid = _sessionId;
                mid = _micMid;
                conv = _convId;
                _pc = null;
                _sessionId = string.Empty;
                _micMid = string.Empty;
                _joined = false;
                _selfSpeaking = false;
            }
            Unlisten();

            if (!string.IsNullOrEmpty(conv)) SendPresence("voice.leave", null, conv);
            if (!string.IsNullOrEmpty(sid) && !string.IsNullOrEmpty(mid))
            {
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await Request("PUT", "/api/voice/session/" + Uri.EscapeDataString(sid) + "/tracks/close",
                            new { tracks = new[] { new { mid } } }, CancellationToken.None).ConfigureAwait(false);
                    }
                    catch (Exception) { /* the SFU drops tracks when our session ends anyway */ }
                });
            }
            try { pc?.close(); } catch (Exception) { /* already closed */ }

            StopMic();
            StopPlayback();
            lock (_mixGate) { Array.Clear(_mix, 0, _mix.Length); _mixReady = false; }
            lock (_gate)
            {
                _subscribed.Clear();
                _remotes.Clear();
                _bySsrc.Clear();
                _byMid.Clear();
                _pending = null;
                _convId = string.Empty;
                _me = string.Empty;
            }
            if (!string.IsNullOrEmpty(conv))
            {
                var frame = new JsonObject();
                frame["type"] = new JsonString(StateType);
                frame["convId"] = new JsonString(conv);
                frame["status"] = new JsonString("left");
                _hub().Push(frame);
            }
        }

        /// <summary>Mute stops sending Opus frames and updates the roster; the mic subprocess keeps running so unmute is instant.</summary>
        public void SetMute(bool muted)
        {
            bool changed;
            lock (_gate) { changed = _muted != muted; _muted = muted; }
            if (changed && Joined)
                SendPresence("voice.update", new Dictionary<string, object?> { ["muted"] = muted });
        }

        /// <summary>Deafen silences local playback only (it is not a roster change), like the JS client.</summary>
        public void SetDeafened(bool deafened)
        {
            lock (_gate) _deafened = deafened;
        }

        // ---- presence + host events ----

        private void Listen()
        {
            lock (_gate)
            {
                if (_listening) return;
                _listening = true;
            }
            _hub().FrameReceived += OnHubFrame;
        }

        private void Unlisten()
        {
            lock (_gate)
            {
                if (!_listening) return;
                _listening = false;
            }
            _hub().FrameReceived -= OnHubFrame;
        }

        private void OnHubFrame(JsonObject frame)
        {
            if (!StringOf(frame, "type").Equals("voice.state", StringComparison.Ordinal)) return;
            string id = StringOf(frame, "convId");
            if (string.IsNullOrEmpty(id)) id = StringOf(frame, "channelId");
            string conv;
            lock (_gate) conv = _convId;
            if (!string.Equals(id, conv, StringComparison.Ordinal)) return;

            var members = new List<Member>();
            if (frame["members"] is JsonArray array)
            {
                foreach (JsonNode node in array)
                {
                    if (node is not JsonObject m) continue;
                    string name = StringOf(m, "username");
                    if (string.IsNullOrEmpty(name)) continue;
                    var tracks = new List<string>();
                    if (m["tracks"] is JsonArray names)
                        foreach (JsonNode t in names) if (t is JsonString ts && !string.IsNullOrEmpty(ts.Value)) tracks.Add(ts.Value);
                    members.Add(new Member(name, StringOf(m, "sessionId"), tracks, BoolOf(m, "muted"), BoolOf(m, "cam")));
                }
            }
            PushState("roster", members);

            foreach (Member m in members)
            {
                if (string.IsNullOrEmpty(m.SessionId) || IsSelf(m.Username) || !m.Tracks.Contains("mic", StringComparer.OrdinalIgnoreCase)) continue;
                string key = m.SessionId + ":mic";
                int gen = _generation;
                lock (_gate)
                {
                    if (!_subscribed.Add(key) || _pc is null) continue;
                }
                _ = SubscribeAsync(m, gen);
            }
        }

        private void PushState(string status, List<Member>? members = null, string? username = null, bool speaking = false, string? message = null)
        {
            string conv;
            lock (_gate) conv = _convId;
            if (string.IsNullOrEmpty(conv)) return;
            var frame = new JsonObject();
            frame["type"] = new JsonString(StateType);
            frame["convId"] = new JsonString(conv);
            frame["status"] = new JsonString(status);
            if (members is not null)
            {
                var list = new JsonArray();
                foreach (Member m in members)
                {
                    var item = new JsonObject();
                    item["username"] = new JsonString(m.Username);
                    item["sessionId"] = new JsonString(m.SessionId);
                    item["muted"] = m.Muted ? JsonBool.True : JsonBool.False;
                    item["cam"] = m.Cam ? JsonBool.True : JsonBool.False;
                    var tracks = new JsonArray();
                    foreach (string t in m.Tracks) tracks.Add(new JsonString(t));
                    item["tracks"] = tracks;
                    list.Add(item);
                }
                frame["members"] = list;
            }
            if (username is not null)
            {
                frame["username"] = new JsonString(username);
                frame["speaking"] = speaking ? JsonBool.True : JsonBool.False;
            }
            if (message is not null) frame["message"] = new JsonString(message);
            _hub().Push(frame);
        }

        private async Task WaitForHub(CancellationToken token)
        {
            for (int i = 0; i < 40 && !_hub().IsConnected; i++)
            {
                if (token.IsCancellationRequested) return;
                await Task.Delay(100, CancellationToken.None).ConfigureAwait(false);
            }
        }

        private void SendPresence(string type, Dictionary<string, object?>? fields, string? convId = null)
        {
            string conv;
            lock (_gate) conv = string.IsNullOrEmpty(convId) ? _convId : convId!;
            if (string.IsNullOrEmpty(conv)) return;
            var f = new JsonObject();
            f["type"] = new JsonString(type);
            f["convId"] = new JsonString(conv);
            f["channelId"] = new JsonString(conv);   // both names: old channel clients and new calls
            if (fields is not null)
                foreach (KeyValuePair<string, object?> pair in fields)
                    f[pair.Key] = ToNode(pair.Value);
            if (!_hub().TrySend(f))
            {
                _ = Task.Run(async () =>
                {
                    for (int i = 0; i < 15; i++)
                    {
                        await Task.Delay(100).ConfigureAwait(false);
                        if (_hub().TrySend(f)) return;
                    }
                });
            }
        }

        private static JsonNode ToNode(object? value) => value switch
        {
            null => JsonNull.Instance,
            bool b => b ? JsonBool.True : JsonBool.False,
            string s => new JsonString(s),
            int n => JsonNumber.From(n),
            IEnumerable<string> list => BuildArray(list),
            _ => new JsonString(value.ToString() ?? string.Empty),
        };

        private static JsonArray BuildArray(IEnumerable<string> values)
        {
            var array = new JsonArray();
            foreach (string v in values) array.Add(new JsonString(v));
            return array;
        }

        // ---- SFU signaling ----

        private async Task SubscribeAsync(Member member, int gen)
        {
            try
            {
                await _signaling.WaitAsync().ConfigureAwait(false);
                try
                {
                    if (Stale(gen)) return;
                    string sid;
                    RTCPeerConnection? pc;
                    lock (_gate) { sid = _sessionId; pc = _pc; }
                    if (pc is null || string.IsNullOrEmpty(sid)) return;

                    JsonElement reply = await Request("POST", "/api/voice/session/" + Uri.EscapeDataString(sid) + "/tracks", new
                    {
                        tracks = new[] { new { location = "remote", sessionId = member.SessionId, trackName = "mic" } },
                    }, _cts?.Token ?? CancellationToken.None).ConfigureAwait(false);

                    string offerSdp = SdpOf(reply, "offer");
                    var track = new RemoteTrack(member.Username);
                    lock (_gate)
                    {
                        _remotes[member.SessionId + ":mic"] = track;
                        _pending = track;
                    }
                    if (reply.ValueKind == JsonValueKind.Object && reply.TryGetProperty("tracks", out JsonElement tracks))
                    {
                        foreach (JsonElement t in tracks.EnumerateArray())
                        {
                            string mid = JsonString(t, "mid");
                            if (mid.Length == 0 || !JsonString(t, "trackName").Equals("mic", StringComparison.OrdinalIgnoreCase)) continue;
                            if (!JsonString(t, "sessionId").Equals(member.SessionId, StringComparison.Ordinal) &&
                                !string.IsNullOrEmpty(JsonString(t, "sessionId"))) continue;
                            lock (_gate) _byMid[mid] = track;
                        }
                    }
                    SetDescriptionResultEnum applied = pc.setRemoteDescription(new RTCSessionDescriptionInit { type = RTCSdpType.offer, sdp = offerSdp });
                    if (applied != SetDescriptionResultEnum.OK) throw new InvalidOperationException("The SFU offer was rejected: " + applied);
                    MapSsrcs(offerSdp, track);

                    var answer = pc.createAnswer();
                    await pc.setLocalDescription(answer).ConfigureAwait(false);
                    await WaitGathering(pc, 1200, _cts?.Token ?? CancellationToken.None).ConfigureAwait(false);
                    if (Stale(gen)) return;
                    string localSdp = pc.localDescription?.sdp?.ToString() ?? answer.sdp ?? string.Empty;
                    await Request("PUT", "/api/voice/session/" + Uri.EscapeDataString(sid) + "/renegotiate", new
                    {
                        sessionDescription = new { type = "answer", sdp = localSdp },
                    }, _cts?.Token ?? CancellationToken.None).ConfigureAwait(false);
                    lock (_gate) _pending = null;
                }
                finally { _signaling.Release(); }
            }
            catch (Exception e)
            {
                lock (_gate)
                {
                    _subscribed.Remove(member.SessionId + ":mic");
                    _remotes.Remove(member.SessionId + ":mic");
                    if (_pending is not null) _pending = null;
                }
                if (!Stale(gen)) PushState("error", message: "Couldn't subscribe to " + member.Username + ": " + e.Message);
            }
        }

        private void MapSsrcs(string sdp, RemoteTrack fallback)
        {
            try
            {
                SDP parsed = SDP.ParseSDPDescription(sdp);
                foreach (SDPMediaAnnouncement media in parsed.Media)
                {
                    RemoteTrack? track = null;
                    if (!string.IsNullOrEmpty(media.MediaID))
                    {
                        lock (_gate) _byMid.TryGetValue(media.MediaID, out track);
                    }
                    track ??= fallback;
                    if (media.SsrcAttributes is null) continue;
                    foreach (SDPSsrcAttribute ssrc in media.SsrcAttributes)
                    {
                        lock (_gate) _bySsrc[ssrc.SSRC] = track;
                    }
                }
            }
            catch (Exception) { /* SDP parsing is only a routing aid; the pending track is the fallback */ }
        }

        private void OnRtp(RTPPacket packet)
        {
            RemoteTrack? track;
            lock (_gate)
            {
                track = _bySsrc.TryGetValue(packet.Header.SyncSource, out RemoteTrack? found) ? found : _pending;
            }
            if (track is null || packet.Payload is null || packet.Payload.Length == 0) return;
            int decoded;
            try { decoded = track.Decoder.Decode(packet.Payload, track.Pcm, FrameSamples); }
            catch (Exception) { return; }
            if (decoded <= 0) return;

            Mix(track.Pcm, decoded);
            double rms = Rms(track.Pcm, decoded);
            DateTime now = DateTime.UtcNow;
            if (rms > SpeakThreshold) track.LastLoud = now;
            bool speaking = now - track.LastLoud < SpeakHold;
            if (speaking != track.Speaking)
            {
                track.Speaking = speaking;
                PushState("speaking", username: track.Username, speaking: speaking);
            }
        }

        private void Mix(short[] pcm, int count)
        {
            lock (_mixGate)
            {
                int n = Math.Min(count, FrameSamples);
                for (int i = 0; i < n; i++) _mix[i] += pcm[i];
                _mixReady = true;
            }
        }

        // ---- ffmpeg audio ----

        private void StartMic(int gen)
        {
            string args = OperatingSystem.IsWindows()
                ? "-hide_banner -loglevel error -nostdin -f dshow -i audio=default -ar 48000 -ac 1 -f s16le -"
                : "-hide_banner -loglevel error -nostdin -f pulse -i default -ar 48000 -ac 1 -f s16le -";
            Process mic = StartFfmpeg(args, stdin: false, stdout: true);
            _mic = mic;
            _micStdout = mic.StandardOutput.BaseStream;
            _encoder = OpusCodecFactory.CreateEncoder(SampleRate, 1, OpusApplication.OPUS_APPLICATION_VOIP);
            Stream stdout = _micStdout;
            _ = Task.Run(() => CaptureLoop(stdout, gen));
        }

        private async Task CaptureLoop(Stream stdout, int gen)
        {
            var raw = new byte[FrameBytes];
            var pcm = new short[FrameSamples];
            var encoded = new byte[4000];
            int filled = 0;
            try
            {
                while (!Stale(gen))
                {
                    int n = await stdout.ReadAsync(raw.AsMemory(filled, FrameBytes - filled)).ConfigureAwait(false);
                    if (n == 0) break;
                    filled += n;
                    if (filled < FrameBytes) continue;
                    filled = 0;
                    for (int i = 0; i < FrameSamples; i++) pcm[i] = BinaryPrimitives.ReadInt16LittleEndian(raw.AsSpan(i * 2, 2));

                    DateTime now = DateTime.UtcNow;
                    double rms = Rms(pcm, FrameSamples);
                    if (rms > SpeakThreshold) _selfLoud = now;
                    bool speaking = now - _selfLoud < SpeakHold;
                    if (speaking != _selfSpeaking)
                    {
                        _selfSpeaking = speaking;
                        string me;
                        lock (_gate) me = _me;
                        if (!string.IsNullOrEmpty(me)) PushState("speaking", username: me, speaking: speaking);
                    }

                    bool muted;
                    RTCPeerConnection? pc;
                    lock (_gate) { muted = _muted; pc = _pc; }
                    if (muted || pc is null || Stale(gen)) continue;
                    int bytes = _encoder?.Encode(pcm, FrameSamples, encoded, encoded.Length) ?? 0;
                    if (bytes <= 0) continue;
                    var payload = new byte[bytes];
                    Buffer.BlockCopy(encoded, 0, payload, 0, bytes);
                    pc.SendAudio(FrameSamples, payload);
                }
            }
            catch (Exception) { /* a closed ffmpeg pipe just ends capture */ }
        }

        private void StartPlayback()
        {
            // ffmpeg reads raw mono s16le from stdin and plays it through the default PulseAudio sink (dshow/wasapi on Windows).
            string args = OperatingSystem.IsWindows()
                ? "-hide_banner -loglevel error -nostdin -f s16le -ar 48000 -ac 1 -i - -f wasapi default"
                : "-hide_banner -loglevel error -nostdin -f s16le -ar 48000 -ac 1 -i - -f pulse default";
            Process speaker = StartFfmpeg(args, stdin: true, stdout: false);
            _speaker = speaker;
            _speakerStdin = speaker.StandardInput.BaseStream;
            _playTimer = new Timer(_ => FlushMix(), null, 20, 20);
        }

        private void FlushMix()
        {
            short[] pcm = new short[FrameSamples];
            lock (_mixGate)
            {
                if (!_mixReady) return;
                for (int i = 0; i < FrameSamples; i++) pcm[i] = (short)Math.Clamp(_mix[i], short.MinValue, short.MaxValue);
                Array.Clear(_mix, 0, _mix.Length);
                _mixReady = false;
            }
            bool deafened;
            lock (_gate) deafened = _deafened;
            if (deafened) return;
            Stream? stdin = _speakerStdin;
            if (stdin is null) return;
            Buffer.BlockCopy(pcm, 0, _playBytes, 0, FrameBytes);
            try { stdin.Write(_playBytes, 0, FrameBytes); stdin.Flush(); }
            catch (Exception) { /* the playback pipe closed */ }
        }

        private static Process StartFfmpeg(string arguments, bool stdin, bool stdout)
        {
            var info = new ProcessStartInfo("ffmpeg")
            {
                Arguments = arguments,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = stdin,
                RedirectStandardOutput = stdout,
            };
            return Process.Start(info) ?? throw new InvalidOperationException("Couldn't start ffmpeg for audio.");
        }

        private void StopMic()
        {
            Kill(_mic);
            _mic = null;
            _micStdout = null;
            Dispose(_encoder);
            _encoder = null;
        }

        private void StopPlayback()
        {
            Timer? timer = _playTimer;
            _playTimer = null;
            try { timer?.Dispose(); } catch (Exception) { /* already disposed */ }
            Kill(_speaker);
            _speaker = null;
            _speakerStdin = null;
        }

        private static void Kill(Process? process)
        {
            if (process is null) return;
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (Exception) { /* already gone */ }
            try { process.Dispose(); } catch (Exception) { /* already gone */ }
        }

        private static void Dispose(IDisposable? disposable)
        {
            try { disposable?.Dispose(); } catch (Exception) { /* already gone */ }
        }

        // ---- JSON / SDP helpers ----

        private async Task<JsonElement> Request(string method, string path, object? body, CancellationToken token)
        {
            JsonNode? node = body is null ? null : JsonReader.Parse(JsonSerializer.Serialize(body));
            JsonNode reply = await _hub().Request(method, path, node).ConfigureAwait(false);
            int status = reply is JsonObject obj && obj["status"] is JsonNumber number ? (int)number.AsInt64() : 0;
            string text = reply is JsonObject o && o["body"] is JsonString s ? s.Value : string.Empty;
            if (status < 200 || status >= 300) throw new InvalidOperationException("Voice request failed (" + status + "): " + text);
            using JsonDocument doc = JsonDocument.Parse(text);
            return doc.RootElement.Clone();
        }

        private static List<RTCIceServer> IceServers(JsonElement ice)
        {
            var servers = new List<RTCIceServer>();
            if (ice.ValueKind != JsonValueKind.Object || !ice.TryGetProperty("iceServers", out JsonElement list) ||
                list.ValueKind != JsonValueKind.Array) return servers;
            foreach (JsonElement server in list.EnumerateArray())
            {
                var item = new RTCIceServer();
                if (server.TryGetProperty("urls", out JsonElement urls))
                {
                    item.urls = urls.ValueKind == JsonValueKind.String
                        ? urls.GetString() ?? string.Empty
                        : string.Join(",", urls.EnumerateArray().Select(u => u.GetString() ?? string.Empty));
                }
                if (server.TryGetProperty("username", out JsonElement user)) item.username = user.GetString();
                if (server.TryGetProperty("credential", out JsonElement credential)) item.credential = credential.GetString();
                servers.Add(item);
            }
            return servers;
        }

        private static string SdpMid(string sdp)
        {
            foreach (string line in sdp.Split('\n'))
                if (line.StartsWith("a=mid:", StringComparison.Ordinal)) return line.Substring(6).Trim();
            return "0";
        }

        private static string AnswerSdp(JsonElement reply) => reply.ValueKind == JsonValueKind.Object &&
            reply.TryGetProperty("sessionDescription", out JsonElement sd) ? JsonString(sd, "sdp") : string.Empty;

        private static string SdpOf(JsonElement reply, string type) => reply.ValueKind == JsonValueKind.Object &&
            reply.TryGetProperty("sessionDescription", out JsonElement sd) &&
            (JsonString(sd, "type").Length == 0 || JsonString(sd, "type").Equals(type, StringComparison.OrdinalIgnoreCase))
                ? JsonString(sd, "sdp") : string.Empty;

        private static string JsonString(JsonElement o, string key) =>
            o.ValueKind == JsonValueKind.Object && o.TryGetProperty(key, out JsonElement v) && v.ValueKind == JsonValueKind.String
                ? v.GetString() ?? string.Empty : string.Empty;

        private static string StringOf(JsonObject o, string key) =>
            o.TryGetValue(key, out JsonNode node) && node is JsonString s ? s.Value : string.Empty;

        private static bool BoolOf(JsonObject o, string key) =>
            o.TryGetValue(key, out JsonNode node) && node is JsonBool b && b.Value;

        private static double Rms(short[] pcm, int count)
        {
            if (count <= 0) return 0;
            double sum = 0;
            for (int i = 0; i < count; i++)
            {
                double v = pcm[i] / 32768.0;
                sum += v * v;
            }
            return Math.Sqrt(sum / count);
        }

        private async Task WaitGathering(RTCPeerConnection pc, int ms, CancellationToken token)
        {
            if (pc.iceGatheringState == RTCIceGatheringState.complete) return;
            var done = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            Action<RTCIceGatheringState> handler = state =>
            {
                if (state == RTCIceGatheringState.complete) done.TrySetResult(true);
            };
            pc.onicegatheringstatechange += handler;
            try
            {
                await Task.WhenAny(done.Task, Task.Delay(ms, CancellationToken.None)).ConfigureAwait(false);
            }
            finally { pc.onicegatheringstatechange -= handler; }
            _ = token;
        }

        private bool Stale(int gen) => gen != _generation || (_cts?.IsCancellationRequested ?? true);

        private bool IsSelf(string username)
        {
            lock (_gate) return string.IsNullOrEmpty(_me) ||
                username.Equals(_me, StringComparison.OrdinalIgnoreCase);
        }

        private sealed class Member
        {
            internal Member(string username, string sessionId, List<string> tracks, bool muted, bool cam)
            {
                Username = username;
                SessionId = sessionId;
                Tracks = tracks;
                Muted = muted;
                Cam = cam;
            }

            internal string Username { get; }
            internal string SessionId { get; }
            internal List<string> Tracks { get; }
            internal bool Muted { get; }
            internal bool Cam { get; }
        }

        private sealed class RemoteTrack
        {
            internal RemoteTrack(string username)
            {
                Username = username;
                Decoder = OpusCodecFactory.CreateDecoder(SampleRate, 1);
                Pcm = new short[FrameSamples];
            }

            internal string Username { get; }
            internal IOpusDecoder Decoder { get; }
            internal short[] Pcm { get; }
            internal bool Speaking { get; set; }
            internal DateTime LastLoud { get; set; } = DateTime.MinValue;
        }
    }
}

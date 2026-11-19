using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Recharge.Server
{
    /// <summary>Cloudflare Realtime SFU settings. The app secret is never logged or sent to clients.</summary>
    public sealed class CloudflareRealtimeConfig
    {
        public string AppId = "";
        public string AppSecret = "";
        public string TurnKeyId = "";
        public string TurnApiToken = "";

        /// <summary>
        /// Reads CLOUDFLARE_REALTIME_APP_ID / _APP_SECRET (required) and CLOUDFLARE_TURN_KEY_ID / _API_TOKEN (optional)
        /// from the environment, then the env file at RECHARGE_CLOUDFLARE_ENV (else ~/.config/recharge/cloudflare-realtime.env).
        /// Null when the required pair is absent. Values are never logged.
        /// </summary>
        public static CloudflareRealtimeConfig? Load(Func<string, string?>? env = null, string? envFile = null)
        {
            env ??= Environment.GetEnvironmentVariable;
            var fromFile = new Dictionary<string, string>(StringComparer.Ordinal);
            string? file = envFile ?? env("RECHARGE_CLOUDFLARE_ENV") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config", "recharge", "cloudflare-realtime.env");
            try
            {
                foreach (string raw in File.ReadAllLines(file))
                {
                    string line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith('#')) continue;
                    if (line.StartsWith("export ", StringComparison.Ordinal)) line = line.Substring(7).TrimStart();
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string v = line.Substring(eq + 1).Trim();
                    if (v.Length >= 2 && (v[0] == '"' || v[0] == '\'') && v[^1] == v[0]) v = v.Substring(1, v.Length - 2);
                    fromFile[line.Substring(0, eq).Trim()] = v;
                }
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { }
            string? Get(string k) { string? v = env(k); return string.IsNullOrEmpty(v) ? (fromFile.TryGetValue(k, out string? f) && f.Length > 0 ? f : null) : v; }

            string? appId = Get("CLOUDFLARE_REALTIME_APP_ID"), secret = Get("CLOUDFLARE_REALTIME_APP_SECRET");
            if (string.IsNullOrEmpty(appId) || string.IsNullOrEmpty(secret)) return null;
            return new CloudflareRealtimeConfig
            {
                AppId = appId!,
                AppSecret = secret!,
                TurnKeyId = Get("CLOUDFLARE_TURN_KEY_ID") ?? "",
                TurnApiToken = Get("CLOUDFLARE_TURN_API_TOKEN") ?? ""
            };
        }
    }

    /// <summary>HttpClient proxy for Cloudflare's Realtime SFU REST API; the app secret stays on this side.</summary>
    public sealed class CloudflareVoiceClient
    {
        private const string Base = "https://rtc.live.cloudflare.com/v1";
        private static readonly Regex HexSession = new Regex("^[0-9a-fA-F]{8,128}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly byte[] StunOnly = JsonSerializer.SerializeToUtf8Bytes(new { iceServers = new[] { new { urls = new[] { "stun:stun.cloudflare.com:3478" } } } });
        private static readonly byte[] TurnTtl = Encoding.UTF8.GetBytes("{\"ttl\":3600}");

        private readonly Func<CloudflareRealtimeConfig?> _load;
        private readonly Func<DateTimeOffset> _clock;
        private readonly HttpClient _http;
        private CloudflareRealtimeConfig? _cfg;
        private readonly object _gate = new object();
        private readonly Dictionary<string, SessionGate> _gates = new Dictionary<string, SessionGate>(StringComparer.Ordinal);
        private readonly Dictionary<string, RateLimiter> _limits = new Dictionary<string, RateLimiter>(StringComparer.Ordinal);

        // Mutations of one session are serialized; GETs are allowed to run alongside them.
        private sealed class SessionGate
        {
            public readonly SemaphoreSlim Sem = new SemaphoreSlim(1, 1);
            public int Users;
        }

        public CloudflareVoiceClient(Func<CloudflareRealtimeConfig?>? load = null, Func<DateTimeOffset>? clock = null, HttpClient? http = null)
        {
            _load = load ?? (() => CloudflareRealtimeConfig.Load());
            _clock = clock ?? (() => DateTimeOffset.UtcNow);
            _http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        }

        public static bool ValidSessionId(string? id) => !string.IsNullOrEmpty(id) && HexSession.IsMatch(id!);

        private CloudflareRealtimeConfig Config => _cfg ??= _load() ?? throw new SocialException(503, "Cloudflare realtime voice is not configured on this server.");

        private async Task<byte[]> Send(HttpMethod method, string path, byte[]? body, string bearer)
        {
            using var req = new HttpRequestMessage(method, Base + path);
            req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + bearer);
            if (body is null)
            {
                req.Headers.TryAddWithoutValidation("Content-Type", "application/json");
            }
            else
            {
                req.Content = new ByteArrayContent(body);
                req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            }
            using HttpResponseMessage res = await _http.SendAsync(req).ConfigureAwait(false);
            byte[] raw = await res.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
            if (!res.IsSuccessStatusCode)
            {
                // Cloudflare's status/body only: never the bearer or the request URL.
                string detail = Encoding.UTF8.GetString(raw, 0, Math.Min(raw.Length, 512)).Replace('\r', ' ').Replace('\n', ' ');
                throw new SocialException(502, "Cloudflare voice API returned " + (int)res.StatusCode + ": " + detail);
            }
            return raw;
        }

        private SessionGate Enter(string sid)
        {
            lock (_gate)
            {
                if (!_gates.TryGetValue(sid, out SessionGate? g)) _gates[sid] = g = new SessionGate();
                g.Users++;
                if (_gates.Count > 4096)
                    foreach (var dead in _gates.Where(e => e.Value.Users == 0).Select(e => e.Key).ToList()) _gates.Remove(dead);
                return g;
            }
        }

        private void Exit(string sid, SessionGate g)
        {
            g.Sem.Release();
            lock (_gate) if (--g.Users == 0 && _gates.Count > 4096) _gates.Remove(sid);
        }

        private void Limit(string sid) // Cloudflare: 50 requests/sec per session
        {
            lock (_gate)
            {
                if (_limits.Count > 4096) _limits.Clear(); // dropping counters only resets the window
                if (!_limits.TryGetValue(sid, out RateLimiter? r)) _limits[sid] = r = new RateLimiter(50, TimeSpan.FromSeconds(1), _clock);
                r.Hit(sid, "Too many voice requests for this session.");
            }
        }

        private static void Check(string sid)
        {
            if (!ValidSessionId(sid)) throw new SocialException(400, "That voice session id is not valid.");
        }

        private static string AppPath(CloudflareRealtimeConfig cfg, string sid, string suffix) =>
            "/apps/" + Uri.EscapeDataString(cfg.AppId) + "/sessions/" + sid + suffix;

        /// <summary>POST sessions/new; returns only the session id to the client.</summary>
        public async Task<byte[]> NewSession()
        {
            CloudflareRealtimeConfig cfg = Config;
            byte[] raw = await Send(HttpMethod.Post, "/apps/" + Uri.EscapeDataString(cfg.AppId) + "/sessions/new", null, cfg.AppSecret).ConfigureAwait(false);
            using JsonDocument doc = JsonDocument.Parse(raw);
            string? sid = doc.RootElement.TryGetProperty("sessionId", out JsonElement v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            if (!ValidSessionId(sid)) throw new SocialException(502, "Cloudflare voice API did not return a valid session id.");
            return JsonSerializer.SerializeToUtf8Bytes(new { sessionId = sid });
        }

        /// <summary>POST tracks/new: opaque client body goes straight to Cloudflare (publish or subscribe, up to 64 tracks).</summary>
        public async Task<byte[]> NewTracks(string sid, byte[] body)
        {
            CloudflareRealtimeConfig cfg = Config;
            Check(sid);
            Limit(sid);
            SessionGate g = Enter(sid);
            await g.Sem.WaitAsync().ConfigureAwait(false);
            try { return await Send(HttpMethod.Post, AppPath(cfg, sid, "/tracks/new"), body, cfg.AppSecret).ConfigureAwait(false); }
            finally { Exit(sid, g); }
        }

        public async Task<byte[]> Renegotiate(string sid, byte[] body)
        {
            CloudflareRealtimeConfig cfg = Config;
            Check(sid);
            Limit(sid);
            SessionGate g = Enter(sid);
            await g.Sem.WaitAsync().ConfigureAwait(false);
            try { return await Send(HttpMethod.Put, AppPath(cfg, sid, "/renegotiate"), body, cfg.AppSecret).ConfigureAwait(false); }
            finally { Exit(sid, g); }
        }

        public async Task<byte[]> CloseTracks(string sid, byte[] body)
        {
            CloudflareRealtimeConfig cfg = Config;
            Check(sid);
            Limit(sid);
            SessionGate g = Enter(sid);
            await g.Sem.WaitAsync().ConfigureAwait(false);
            try { return await Send(HttpMethod.Put, AppPath(cfg, sid, "/tracks/close"), body, cfg.AppSecret).ConfigureAwait(false); }
            finally { Exit(sid, g); }
        }

        public async Task<byte[]> Session(string sid)
        {
            CloudflareRealtimeConfig cfg = Config;
            Check(sid);
            Limit(sid);
            return await Send(HttpMethod.Get, AppPath(cfg, sid, ""), null, cfg.AppSecret).ConfigureAwait(false);
        }

        /// <summary>Mints TURN credentials server-side, or returns the public STUN server when no TURN key is set.</summary>
        public async Task<byte[]> Ice()
        {
            CloudflareRealtimeConfig cfg = Config;
            if (string.IsNullOrEmpty(cfg.TurnKeyId) || string.IsNullOrEmpty(cfg.TurnApiToken)) return StunOnly;
            string path = "/turn/keys/" + Uri.EscapeDataString(cfg.TurnKeyId) + "/credentials/generate-ice-servers";
            return await Send(HttpMethod.Post, path, TurnTtl, cfg.TurnApiToken).ConfigureAwait(false);
        }
    }
}

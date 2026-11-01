using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Threading.Tasks;

namespace Recharge.Server
{
    /// <summary>Validates sessions against the hub's GET /api/me, caching each answer briefly.</summary>
    public sealed class HttpHubDirectory : IHubDirectory
    {
        private readonly string _base;
        private readonly HttpClient _http;
        private readonly TimeSpan _ttl;
        private readonly Func<DateTimeOffset> _clock;
        private readonly object _gate = new object();
        private readonly Dictionary<string, (HubUser? User, DateTimeOffset Expires)> _cache = new Dictionary<string, (HubUser?, DateTimeOffset)>(StringComparer.Ordinal);

        public HttpHubDirectory(string hubBase, TimeSpan cacheTtl, Func<DateTimeOffset> clock, HttpClient? http = null)
        {
            _base = hubBase.TrimEnd('/');
            _ttl = cacheTtl;
            _clock = clock;
            _http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        }

        public async Task<HubUser?> Authenticate(string token)
        {
            if (string.IsNullOrEmpty(token) || token.Length > 512) return null;
            DateTimeOffset now = _clock();
            lock (_gate)
            {
                if (_cache.TryGetValue(token, out var hit) && hit.Expires > now) return hit.User;
            }

            HubUser? user = null;
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, _base + "/api/me");
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                using HttpResponseMessage res = await _http.SendAsync(req).ConfigureAwait(false);
                if (res.StatusCode == HttpStatusCode.Unauthorized || res.StatusCode == HttpStatusCode.Forbidden)
                {
                    user = null;
                }
                else if (!res.IsSuccessStatusCode)
                {
                    throw new SocialException(503, "The Recharge hub could not check your session.");
                }
                else
                {
                    using JsonDocument doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync().ConfigureAwait(false));
                    JsonElement root = doc.RootElement;
                    string? name = root.TryGetProperty("username", out JsonElement n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null;
                    bool admin = root.TryGetProperty("admin", out JsonElement a) && a.ValueKind == JsonValueKind.True;
                    if (!string.IsNullOrEmpty(name)) user = new HubUser(name!, admin);
                }
            }
            catch (Exception e) when (e is HttpRequestException || e is TaskCanceledException || e is JsonException)
            {
                throw new SocialException(503, "The Recharge hub could not be reached.");
            }

            lock (_gate)
            {
                if (_cache.Count > 5000) _cache.Clear();
                // A rejected token is remembered only briefly, so a fresh login works almost at once.
                _cache[token] = (user, now + (user is null ? TimeSpan.FromSeconds(5) : _ttl));
            }
            return user;
        }

        public async Task<string?> LookupUser(string username)
        {
            try
            {
                using HttpResponseMessage res = await _http.GetAsync(_base + "/api/users/" + Uri.EscapeDataString(username)).ConfigureAwait(false);
                if (res.StatusCode == HttpStatusCode.NotFound) return null;
                if (!res.IsSuccessStatusCode) throw new SocialException(503, "The Recharge hub could not look that user up.");
                using JsonDocument doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync().ConfigureAwait(false));
                return doc.RootElement.TryGetProperty("username", out JsonElement n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null;
            }
            catch (Exception e) when (e is HttpRequestException || e is TaskCanceledException || e is JsonException)
            {
                throw new SocialException(503, "The Recharge hub could not be reached.");
            }
        }
    }
}

using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>
    /// site.icon {url}: the linked site's own icon (favicon, else apple-touch-icon) for profile links. https only, images only,
    /// at most 128 KB, cached on disk for a week (misses for a day) so each site is asked rarely.
    /// </summary>
    public static class IconCommands
    {
        private const int MaxBytes = 128 * 1024;
        private static readonly HttpClient Client = CreateClient();
        private static readonly ConcurrentDictionary<string, Task<(string Mime, byte[] Data)?>> Pending = new ConcurrentDictionary<string, Task<(string, byte[])?>>();

        private static HttpClient CreateClient()
        {
            var c = new HttpClient(new HttpClientHandler { MaxAutomaticRedirections = 3 }) { Timeout = TimeSpan.FromSeconds(8) };
            c.DefaultRequestHeaders.UserAgent.ParseAdd("RechargeNext/" + AppVersion.Value);
            return c;
        }

        public static void Register(CommandRegistry registry) => registry.Register("site.icon", SiteIcon);

        /// <summary>The site host for a profile link, or null: https, a real host name (no IP literals, no localhost), no credentials.</summary>
        public static string? HostOf(string? url)
        {
            if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? u) || u.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(u.UserInfo)) return null;
            if (u.HostNameType != UriHostNameType.Dns || !u.Host.Contains('.') || u.Host.EndsWith(".local", StringComparison.OrdinalIgnoreCase)) return null;
            if (u.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) || !u.IsDefaultPort) return null;
            return u.Host.ToLowerInvariant();
        }

        private static async Task<JsonNode> SiteIcon(JsonObject args)
        {
            string? host = HostOf(args.TryGetValue("url", out JsonNode v) && v is JsonString s ? s.Value : null);
            var result = new JsonObject();
            if (host == null) { result["data"] = JsonNull.Instance; return result; }
            var icon = await Pending.GetOrAdd(host, h => Fetch(h)).ConfigureAwait(false);
            Pending.TryRemove(host, out _);
            result["mime"] = icon is null ? (JsonNode)JsonNull.Instance : new JsonString(icon.Value.Mime);
            result["data"] = icon is null ? (JsonNode)JsonNull.Instance : new JsonString(Convert.ToBase64String(icon.Value.Data));
            return result;
        }

        private static string CacheDir() => Path.Combine(Settings.SettingsStore.DataDir(), "cache", "site-icons");

        private static async Task<(string Mime, byte[] Data)?> Fetch(string host)
        {
            string key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(host))).Substring(0, 24).ToLowerInvariant();
            string file = Path.Combine(CacheDir(), key), miss = file + ".miss";
            try
            {
                if (File.Exists(file) && DateTime.UtcNow - File.GetLastWriteTimeUtc(file) < TimeSpan.FromDays(7))
                {
                    byte[] all = File.ReadAllBytes(file);
                    int nl = Array.IndexOf(all, (byte)'\n');
                    if (nl > 0) return (Encoding.ASCII.GetString(all, 0, nl), all[(nl + 1)..]);
                }
                if (File.Exists(miss) && DateTime.UtcNow - File.GetLastWriteTimeUtc(miss) < TimeSpan.FromDays(1)) return null;
            }
            catch (IOException) { /* fall through to fetching */ }

            foreach (string path in new[] { "/favicon.ico", "/apple-touch-icon.png", "/favicon.png" })
            {
                try
                {
                    using var response = await Client.GetAsync("https://" + host + path, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
                    string mime = response.Content.Headers.ContentType?.MediaType ?? "";
                    if (!response.IsSuccessStatusCode || !mime.StartsWith("image/", StringComparison.Ordinal) || mime.Contains("svg")) continue;
                    if (response.Content.Headers.ContentLength > MaxBytes) continue;
                    byte[] data = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
                    if (data.Length == 0 || data.Length > MaxBytes) continue;
                    try
                    {
                        Directory.CreateDirectory(CacheDir());
                        File.WriteAllBytes(file, Encoding.ASCII.GetBytes(mime + "\n").Concat(data));
                    }
                    catch (IOException) { /* cache is best effort */ }
                    return (mime, data);
                }
                catch (HttpRequestException) { }
                catch (TaskCanceledException) { }
            }
            try { Directory.CreateDirectory(CacheDir()); File.WriteAllText(miss, ""); } catch (IOException) { }
            return null;
        }

        private static byte[] Concat(this byte[] a, byte[] b)
        {
            var r = new byte[a.Length + b.Length];
            Buffer.BlockCopy(a, 0, r, 0, a.Length);
            Buffer.BlockCopy(b, 0, r, a.Length, b.Length);
            return r;
        }
    }
}

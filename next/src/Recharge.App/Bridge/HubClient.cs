using System;
using System.Net.Http;
using System.Threading.Tasks;

namespace Recharge.App.Bridge
{
    /// <summary>Validation and URL building for hub requests.</summary>
    public static class HubPath
    {
        public const string DefaultBaseUrl = "https://codecade.co.za/recharge";
        public const string BaseVariable = "RECHARGE_HUB_BASE";

        /// <summary>The hub, or the http(s) address in RECHARGE_HUB_BASE (tests point it at a local stub, as the current app allows).</summary>
        public static string BaseUrl
        {
            get
            {
                string? v = Environment.GetEnvironmentVariable(BaseVariable);
                return v != null && (v.StartsWith("http://", StringComparison.Ordinal) || v.StartsWith("https://", StringComparison.Ordinal))
                    ? v.TrimEnd('/') : DefaultBaseUrl;
            }
        }

        public static bool IsValid(string? path)
        {
            if (string.IsNullOrEmpty(path) || !path.StartsWith("/api/", StringComparison.Ordinal))
            {
                return false;
            }
            foreach (char c in path)
            {
                if (c < ' ' || c == '\u007F' || c == '\\')
                {
                    return false;
                }
            }
            return true;
        }

        public static string BuildUri(string path)
        {
            if (!IsValid(path))
            {
                throw new ArgumentException("hub path must start with /api/", nameof(path));
            }
            return BaseUrl + path;
        }
    }

    /// <summary>The single shared HTTP client for hub requests.</summary>
    public static class HubClient
    {
        private static readonly HttpClient Client = CreateClient();

        private static HttpClient CreateClient()
        {
            var client = new HttpClient
            {
                Timeout = TimeSpan.FromSeconds(20),
            };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("RechargeNext/" + AppVersion.Value);
            return client;
        }

        /// <summary>Hub gallery images only: /api/&lt;kind&gt;s/&lt;id&gt;/gallery/&lt;file&gt;.</summary>
        public static bool IsGalleryPath(string? path)
        {
            if (!HubPath.IsValid(path)) return false;
            string[] parts = path!.Split('/');
            // "", "api", kind, id, "gallery", file
            if (parts.Length != 6 || parts[1] != "api" || parts[4] != "gallery") return false;
            for (int i = 2; i < 6; i++)
            {
                string part = parts[i];
                // no empty segments, no dot segments, plain or percent-encoded (Uri would collapse %2e%2e)
                if (part.Length == 0 || part.Contains("..") || part.IndexOf("%2e", StringComparison.OrdinalIgnoreCase) >= 0 || part.Contains('?') || part.Contains('#'))
                    return false;
            }
            return true;
        }

        public const int MaxImageBytes = 8 * 1024 * 1024;

        /// <summary>
        /// The image's bytes (the hub redirects to its CDN; the client follows). The page gets them as same-origin data, so it can
        /// read pixels (skin sheets) without the hub's redirect needing CORS headers.
        /// </summary>
        public static async Task<(int Status, string Mime, byte[] Data)> GetImageAsync(string path)
        {
            if (!IsGalleryPath(path)) throw new ArgumentException("not a hub gallery path", nameof(path));
            using var response = await Client.GetAsync(HubPath.BuildUri(path), HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
            string mime = response.Content.Headers.ContentType?.MediaType ?? "application/octet-stream";
            if (!response.IsSuccessStatusCode) return ((int)response.StatusCode, mime, Array.Empty<byte>());
            if (!mime.StartsWith("image/", StringComparison.Ordinal)) throw new InvalidOperationException("not an image: " + mime);
            if (response.Content.Headers.ContentLength > MaxImageBytes) throw new InvalidOperationException("image too large");
            byte[] data = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
            if (data.Length > MaxImageBytes) throw new InvalidOperationException("image too large");
            return ((int)response.StatusCode, mime, data);
        }

        // Packages can be large and slow: their own client, with a long timeout.
        private static readonly HttpClient Downloads = CreateDownloadClient();

        private static HttpClient CreateDownloadClient()
        {
            var client = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("RechargeNext/" + AppVersion.Value);
            return client;
        }

        /// <summary>A package file's bytes (the hub redirects to its CDN), capped at maxBytes; retried twice on network errors.</summary>
        public static async Task<byte[]> GetPackageAsync(string path, long maxBytes)
        {
            Exception? last = null;
            foreach (int delay in new[] { 0, 1000, 2000 })
            {
                if (delay > 0) await Task.Delay(delay).ConfigureAwait(false);
                try
                {
                    using var response = await Downloads.GetAsync(HubPath.BuildUri(path), HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
                    if (!response.IsSuccessStatusCode) throw new InvalidOperationException("the hub answered " + (int)response.StatusCode);
                    if (response.Content.Headers.ContentLength > maxBytes) throw new InvalidOperationException("the package is too large");
                    using var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
                    using var memory = new System.IO.MemoryStream();
                    var buffer = new byte[81920];
                    int read;
                    while ((read = await stream.ReadAsync(buffer).ConfigureAwait(false)) > 0)
                    {
                        memory.Write(buffer, 0, read);
                        if (memory.Length > maxBytes) throw new InvalidOperationException("the package is too large");
                    }
                    return memory.ToArray();
                }
                catch (HttpRequestException e) { last = e; }
                catch (TaskCanceledException e) { last = e; }
            }
            throw new InvalidOperationException("couldn't download the package: " + last?.Message);
        }

        /// <summary>Streams a package to a file (a playlist can be hundreds of MB, so it never sits in memory), capped at maxBytes. Returns the size.</summary>
        public static async Task<long> DownloadToFileAsync(string path, string dest, long maxBytes)
        {
            try
            {
                using var response = await LongDownloads.GetAsync(HubPath.BuildUri(path), HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode) throw new InvalidOperationException("the hub answered " + (int)response.StatusCode);
                long? total = response.Content.Headers.ContentLength;
                if (total > maxBytes) throw new InvalidOperationException("the package is too large");
                using var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
                using var file = new System.IO.FileStream(dest, System.IO.FileMode.Create, System.IO.FileAccess.Write);
                var buffer = new byte[81920];
                long done = 0;
                int read;
                while ((read = await stream.ReadAsync(buffer).ConfigureAwait(false)) > 0)
                {
                    done += read;
                    if (done > maxBytes) throw new InvalidOperationException("the package is too large");
                    file.Write(buffer, 0, read);
                }
                if (total > 0 && done < total) throw new InvalidOperationException("download cut short (" + done / 1048576 + " of " + total / 1048576 + " MB)");
                return done;
            }
            catch (HttpRequestException e) { throw new InvalidOperationException("couldn't download the package: " + e.Message); }
            catch (TaskCanceledException e) { throw new InvalidOperationException("couldn't download the package: " + e.Message); }
        }

        private static readonly HttpClient LongDownloads = CreateLongClient();

        private static HttpClient CreateLongClient()
        {
            var client = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("RechargeNext/" + AppVersion.Value);
            return client;
        }

        private static readonly ConditionalGetCache Revalidated = new ConditionalGetCache();

        /// <summary>A hub GET; repeat requests revalidate with the ETag, so an unchanged list costs the server no body.</summary>
        public static Task<(int Status, string Body)> GetAsync(string path) =>
            Revalidated.GetAsync(Client, HubPath.BuildUri(path), null);
    }

    /// <summary>The application's short version string.</summary>
    public static class AppVersion
    {
        public static string Value { get; } = ReadVersion();

        private static string ReadVersion()
        {
            Version? version = typeof(AppVersion).Assembly.GetName().Version;
            return version is null ? "0.0.0" : version.ToString(3);
        }
    }
}

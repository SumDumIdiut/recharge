using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading.Tasks;

namespace Recharge.App.Bridge
{
    /// <summary>
    /// GETs that revalidate instead of refetching: the last 200 answer's body is kept with its ETag / Last-Modified, the next request
    /// sends If-None-Match / If-Modified-Since, and a 304 answers the kept body as a 200. Entries are per URL and per session token (an
    /// answer for one login is never served to another). Only 200 answers are kept; any other status (a 401 above all) drops the
    /// entry and is passed on as it came, so session handling is unchanged.
    /// </summary>
    public sealed class ConditionalGetCache
    {
        private sealed class Entry
        {
            public string? ETag;
            public string? LastModified;
            public string Body = "";
        }

        private const int MaxEntries = 256;
        private readonly Dictionary<string, Entry> _entries = new Dictionary<string, Entry>(StringComparer.Ordinal);
        private readonly object _lock = new object();

        public int Count { get { lock (_lock) return _entries.Count; } }

        public void Clear() { lock (_lock) _entries.Clear(); }

        /// <summary>Sends a GET for <paramref name="uri"/> (with a bearer token when given) and answers (status, body).</summary>
        public async Task<(int Status, string Body)> GetAsync(HttpClient client, string uri, string? token)
        {
            string key = (token ?? "") + "|" + uri;
            Entry? known;
            lock (_lock) _entries.TryGetValue(key, out known);

            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            if (!string.IsNullOrEmpty(token)) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            if (known != null)
            {
                if (known.ETag != null) request.Headers.TryAddWithoutValidation("If-None-Match", known.ETag);
                else if (known.LastModified != null) request.Headers.TryAddWithoutValidation("If-Modified-Since", known.LastModified);
            }

            using HttpResponseMessage response = await client.SendAsync(request).ConfigureAwait(false);
            if (response.StatusCode == HttpStatusCode.NotModified && known != null)
            {
                return (200, known.Body);
            }

            string body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            int status = (int)response.StatusCode;
            if (status == 200)
            {
                string? etag = response.Headers.ETag?.ToString();
                string? modified = response.Content.Headers.LastModified?.ToString("R");
                if (etag != null || modified != null)
                {
                    lock (_lock)
                    {
                        if (_entries.Count >= MaxEntries && !_entries.ContainsKey(key)) _entries.Clear();
                        _entries[key] = new Entry { ETag = etag, LastModified = modified, Body = body };
                    }
                    return (status, body);
                }
            }
            lock (_lock) _entries.Remove(key);
            return (status, body);
        }
    }
}

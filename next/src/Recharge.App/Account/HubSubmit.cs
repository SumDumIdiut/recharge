using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Tasks;
using Recharge.App.Bridge;
using Recharge.Core.Json;

namespace Recharge.App.Account
{
    /// <summary>
    /// hub.submit: uploads a mod, map or skin to POST /api/submit as multipart, streaming the zip and screenshots from disk.
    /// The session token is read from AccountStore and never returned, logged or put in an error message.
    /// </summary>
    public static class HubSubmit
    {
        public const long MaxZipBytes = 200L * 1024 * 1024;
        public const long MaxImageBytes = 15L * 1024 * 1024;
        public const int MaxImages = 8;

        private static readonly string[] ImageExtensions = { ".png", ".jpg", ".jpeg", ".gif", ".webp" };
        private static readonly HttpClient Client = CreateClient();

        private static HttpClient CreateClient()
        {
            var client = new HttpClient { Timeout = TimeSpan.FromMinutes(15) };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("RechargeNext/" + AppVersion.Value);
            return client;
        }

        /// <summary>Checks the files before anything is sent. Throws ArgumentException with a plain message.</summary>
        public static void Validate(string? zip, IReadOnlyList<string> gallery)
        {
            if (zip is not null)
            {
                if (!File.Exists(zip)) throw new ArgumentException("The zip file was not found: " + Path.GetFileName(zip));
                if (!zip.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Choose a .zip file.");
                if (new FileInfo(zip).Length > MaxZipBytes) throw new ArgumentException("The zip is over 200 MB.");
            }
            if (gallery.Count > MaxImages) throw new ArgumentException("Add at most " + MaxImages + " screenshots.");
            foreach (string path in gallery)
            {
                if (!File.Exists(path)) throw new ArgumentException("A screenshot was not found: " + Path.GetFileName(path));
                if (Array.IndexOf(ImageExtensions, Path.GetExtension(path).ToLowerInvariant()) < 0)
                    throw new ArgumentException(Path.GetFileName(path) + " is not a png, jpg, gif or webp picture.");
                if (new FileInfo(path).Length > MaxImageBytes) throw new ArgumentException(Path.GetFileName(path) + " is over 15 MB.");
            }
        }

        private static string MimeOf(string path) => Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".zip" => "application/zip",
            _ => "application/octet-stream",
        };

        /// <summary>The multipart body: every text field by name, the zip as "file", each screenshot as "gallery". Null fields are skipped.</summary>
        public static MultipartFormDataContent BuildContent(IReadOnlyDictionary<string, string> fields, string? zip, IReadOnlyList<string> gallery)
        {
            var content = new MultipartFormDataContent();
            foreach (KeyValuePair<string, string> field in fields)
            {
                content.Add(new StringContent(field.Value, Encoding.UTF8), field.Key);
            }
            if (zip is not null) content.Add(FilePart(zip), "file", SafeName(zip));
            foreach (string path in gallery) content.Add(FilePart(path), "gallery", SafeName(path));
            return content;
        }

        private static StreamContent FilePart(string path)
        {
            var part = new StreamContent(new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, true));
            part.Headers.ContentType = new MediaTypeHeaderValue(MimeOf(path));
            return part;
        }

        private static string SafeName(string path)
        {
            var sb = new StringBuilder();
            foreach (char c in Path.GetFileName(path))
                sb.Append(char.IsAsciiLetterOrDigit(c) || c == '.' || c == '-' || c == '_' ? c : '_');
            return sb.Length == 0 ? "file" : sb.ToString();
        }

        public static async Task<JsonNode> SubmitAsync(IReadOnlyDictionary<string, string> fields, string? zip, IReadOnlyList<string> gallery)
        {
            Validate(zip, gallery);
            AccountSession? session = AccountStore.Load();
            if (session is null) throw new InvalidOperationException("not logged in");
            using var request = new HttpRequestMessage(HttpMethod.Post, HubPath.BuildUri("/api/submit"));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", session.Token);
            using MultipartFormDataContent content = BuildContent(fields, zip, gallery);
            request.Content = content;
            int status;
            string text;
            try
            {
                using HttpResponseMessage response = await Client.SendAsync(request).ConfigureAwait(false);
                status = (int)response.StatusCode;
                text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            }
            catch (HttpRequestException) { throw new InvalidOperationException("Couldn't reach the Recharge hub. Check your connection."); }
            catch (TaskCanceledException) { throw new InvalidOperationException("The upload took too long and was stopped."); }

            text = text.Replace(session.Token, "[redacted]", StringComparison.Ordinal);
            if (status == 401) AccountStore.Clear();
            if (status < 200 || status >= 300) throw new InvalidOperationException(ErrorText(status, text));
            try { return JsonReader.Parse(text); }
            catch (Exception) { throw new InvalidOperationException("the hub sent something unreadable"); }
        }

        /// <summary>The hub's own { error } text, else a plain line for the status.</summary>
        public static string ErrorText(int status, string body)
        {
            try
            {
                if (JsonReader.Parse(body) is JsonObject obj && obj.TryGetValue("error", out JsonNode e) && e is JsonString s && s.Value.Length > 0)
                    return s.Value;
            }
            catch (Exception) { /* not JSON */ }
            return status == 401 ? "not logged in" : status == 413 ? "The upload is too large." : "the hub answered " + status;
        }
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Recharge.App.Bridge;
using Recharge.Core.Json;

namespace Recharge.App.Account
{
    /// <summary>
    /// The account and authenticated hub requests. The session token is read from and written to AccountStore; it is never
    /// returned to the page, logged, or included in an error message.
    /// </summary>
    public sealed class AccountService
    {
        private const int MaxImageBytes = 8 * 1024 * 1024;
        private static readonly HttpClient Client = CreateClient();
        private static readonly ConditionalGetCache Revalidated = new ConditionalGetCache();
        private static readonly Regex PlainFile = new Regex("^[A-Za-z0-9._-]{1,160}$", RegexOptions.CultureInvariant);
        /// <summary>A username as one URL-encoded path segment (encodeURIComponent output: letters, digits, -_.!~*'() and %XX).</summary>
        private static readonly Regex UserSegment = new Regex("^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-F]{2}){1,120}$", RegexOptions.CultureInvariant);
        private static readonly string[] PublicProfileKeys =
        {
            "username", "admin", "avatar_url", "banner_color", "banner_url", "accent_color", "name_color",
            "frame", "frame_colors", "bio", "pronouns", "links", "created_at", "post_count", "reply_count",
            "comment_count", "uploads",
        };

        private static HttpClient CreateClient()
        {
            var client = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("RechargeNext/" + AppVersion.Value);
            return client;
        }

        // ---- account ----

        public async Task<JsonNode> Login(string username, string password)
        {
            JsonObject body = Credentials(username, password);
            (int status, string text) = await SendJsonAsync(HttpMethod.Post, "/api/login", body, null).ConfigureAwait(false);
            return await SessionFromAsync(status, text, username).ConfigureAwait(false);
        }

        public async Task<JsonNode> Register(string username, string password)
        {
            JsonObject body = Credentials(username, password);
            (int status, string text) = await SendJsonAsync(HttpMethod.Post, "/api/register", body, null).ConfigureAwait(false);
            return await SessionFromAsync(status, text, username).ConfigureAwait(false);
        }

        public async Task<JsonNode> Me()
        {
            AccountSession? session = AccountStore.Load();
            if (session is null)
            {
                throw new InvalidOperationException("not logged in");
            }

            int status;
            string text;
            try
            {
                (status, text) = await SendAsync(HttpMethod.Get, "/api/me", null, session.Token).ConfigureAwait(false);
            }
            catch (HttpRequestException)
            {
                return Basic(session);
            }
            catch (TaskCanceledException)
            {
                return Basic(session);
            }

            if (status == 401)
            {
                AccountStore.Clear();
                throw new InvalidOperationException("not logged in");
            }
            if (status < 200 || status >= 300)
            {
                throw new InvalidOperationException(ErrorFrom(status, text, session.Token));
            }

            JsonObject me = ParseObject(text, session.Token);
            string name = StringOf(me, "username");
            bool admin = BoolOf(me, "admin");
            if (!string.IsNullOrEmpty(name))
            {
                AccountStore.Save(session.Token, name, admin);
            }
            return Public(me, session.Token);
        }

        public Task<JsonNode> Logout()
        {
            AccountStore.Clear();
            var result = new JsonObject();
            result["loggedOut"] = JsonBool.True;
            return Task.FromResult<JsonNode>(result);
        }

        private async Task<JsonNode> SessionFromAsync(int status, string text, string fallbackName)
        {
            if (status < 200 || status >= 300)
            {
                throw new InvalidOperationException(ErrorFrom(status, text, null));
            }

            JsonObject reply = ParseRaw(text);
            string token = StringOf(reply, "token");
            if (string.IsNullOrEmpty(token))
            {
                throw new InvalidOperationException("the hub did not return a session");
            }

            string username = StringOf(reply, "username");
            if (string.IsNullOrEmpty(username)) username = fallbackName;
            bool admin = false;

            // Login only says who the token belongs to; /api/me adds the profile and whether the account is an admin.
            try
            {
                (int meStatus, string meText) = await SendAsync(HttpMethod.Get, "/api/me", null, token).ConfigureAwait(false);
                if (meStatus >= 200 && meStatus < 300)
                {
                    JsonObject me = ParseObject(meText, token);
                    string meName = StringOf(me, "username");
                    if (!string.IsNullOrEmpty(meName)) username = meName;
                    admin = BoolOf(me, "admin");
                    AccountStore.Save(token, username, admin);
                    return Public(me, token);
                }
            }
            catch (HttpRequestException)
            {
                // The session still exists even if the follow-up request failed.
            }
            catch (TaskCanceledException)
            {
                // Same.
            }

            AccountStore.Save(token, username, admin);
            var basic = new JsonObject();
            basic["username"] = new JsonString(username);
            basic["admin"] = admin ? JsonBool.True : JsonBool.False;
            return basic;
        }

        private static JsonObject Credentials(string username, string password)
        {
            if (string.IsNullOrWhiteSpace(username)) throw new ArgumentException("a username is required", nameof(username));
            if (string.IsNullOrEmpty(password)) throw new ArgumentException("a password is required", nameof(password));
            var body = new JsonObject();
            body["username"] = new JsonString(username);
            body["password"] = new JsonString(password);
            return body;
        }

        private static JsonNode Public(JsonObject me, string token)
        {
            string? name = me.TryGetValue("username", out JsonNode nameNode) && nameNode is JsonString s ? s.Value : null;
            if (string.IsNullOrEmpty(name))
            {
                throw new InvalidOperationException("the hub sent a profile without a username");
            }

            var result = new JsonObject();
            foreach (string key in PublicProfileKeys)
            {
                if (key == "admin")
                {
                    result[key] = BoolOf(me, "admin") ? JsonBool.True : JsonBool.False;
                    continue;
                }
                if (me.TryGetValue(key, out JsonNode value))
                {
                    result[key] = RedactNode(value, token);
                }
            }
            if (!result.ContainsKey("admin"))
            {
                result["admin"] = JsonBool.False;
            }
            return result;
        }

        private static JsonNode Basic(AccountSession session)
        {
            var result = new JsonObject();
            result["username"] = new JsonString(session.Username);
            result["admin"] = session.Admin ? JsonBool.True : JsonBool.False;
            return result;
        }

        // ---- authenticated requests ----

        public async Task<JsonNode> Request(string method, string path, JsonNode? body)
        {
            if (!HubPath.IsValid(path))
            {
                throw new ArgumentException("hub path must start with /api/", nameof(path));
            }
            if (path == "/api/login" || path == "/api/register")
            {
                throw new ArgumentException("use account.login or account.register", nameof(path));
            }

            string verb = string.IsNullOrEmpty(method) ? "GET" : method!.Trim().ToUpperInvariant();
            if (verb != "GET" && verb != "POST" && verb != "PUT" && verb != "PATCH" && verb != "DELETE")
            {
                throw new ArgumentException("unsupported HTTP method", nameof(method));
            }

            AccountSession? session = AccountStore.Load();
            int status;
            string text;
            try
            {
                (status, text) = await SendAsync(new HttpMethod(verb), path, body, session?.Token).ConfigureAwait(false);
            }
            catch (HttpRequestException)
            {
                throw new InvalidOperationException("Couldn't reach the Recharge hub. Check your connection.");
            }
            catch (TaskCanceledException)
            {
                throw new InvalidOperationException("Couldn't reach the Recharge hub. Check your connection.");
            }

            if (status == 401 && session is not null)
            {
                AccountStore.Clear();
            }

            var result = new JsonObject();
            result["status"] = JsonNumber.From(status);
            result["body"] = new JsonString(Redact(text, session?.Token));
            return result;
        }

        private static async Task<(int Status, string Body)> SendJsonAsync(
            HttpMethod method, string path, JsonNode body, string? token)
        {
            return await SendAsync(method, path, body, token).ConfigureAwait(false);
        }

        private static async Task<(int Status, string Body)> SendAsync(
            HttpMethod method, string path, JsonNode? body, string? token)
        {
            if (method == HttpMethod.Get && body is null)
            {
                // reads revalidate (ETag) per session token; a 401 or any non-200 answer is passed on and never kept
                return await Revalidated.GetAsync(Client, HubPath.BuildUri(path), token).ConfigureAwait(false);
            }

            using var request = new HttpRequestMessage(method, HubPath.BuildUri(path));
            if (!string.IsNullOrEmpty(token))
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            }
            if (body is not null)
            {
                request.Content = BuildContent(body);
            }

            using HttpResponseMessage response = await Client.SendAsync(request).ConfigureAwait(false);
            string text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            return ((int)response.StatusCode, text);
        }

        private static HttpContent BuildContent(JsonNode body)
        {
            if (body is JsonObject obj && obj.TryGetValue("__multipart", out JsonNode multipartNode) &&
                multipartNode is JsonObject multipart)
            {
                return BuildMultipart(multipart);
            }
            return new StringContent(JsonWriter.Write(body, 0), Encoding.UTF8, "application/json");
        }

        private static HttpContent BuildMultipart(JsonObject multipart)
        {
            var content = new MultipartFormDataContent();
            if (multipart.TryGetValue("fields", out JsonNode fieldsNode) && fieldsNode is JsonObject fields)
            {
                foreach (KeyValuePair<string, JsonNode> field in fields)
                {
                    if (field.Value is JsonNull) continue;
                    content.Add(new StringContent(ScalarText(field.Value), Encoding.UTF8), field.Key);
                }
            }
            if (multipart.TryGetValue("files", out JsonNode filesNode) && filesNode is JsonArray files)
            {
                foreach (JsonNode item in files)
                {
                    if (item is not JsonObject file) continue;
                    string field = StringOf(file, "field");
                    string name = StringOf(file, "name");
                    string mime = StringOf(file, "mime");
                    string data = StringOf(file, "data");
                    if (string.IsNullOrEmpty(field) || string.IsNullOrEmpty(data)) continue;
                    if (!PlainFile.IsMatch(name)) name = "image";
                    byte[] bytes;
                    try { bytes = Convert.FromBase64String(data); }
                    catch (FormatException) { throw new ArgumentException("an uploaded file was not valid base64"); }
                    var part = new ByteArrayContent(bytes);
                    try
                    {
                        part.Headers.ContentType = new MediaTypeHeaderValue(
                            string.IsNullOrEmpty(mime) ? "application/octet-stream" : mime);
                    }
                    catch (FormatException)
                    {
                        part.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                    }
                    content.Add(part, field, name);
                }
            }
            return content;
        }

        private static string ScalarText(JsonNode node) => node switch
        {
            JsonString s => s.Value,
            JsonNumber n => n.Raw,
            JsonBool b => b.Value ? "true" : "false",
            _ => JsonWriter.Write(node, 0),
        };

        // ---- images ----

        public static bool IsImagePath(string? path)
        {
            if (!HubPath.IsValid(path)) return false;
            string[] parts = path!.Split('/');
            // A player's current picture by name (/api/users/<name>/avatar), for lists that only know the name.
            if (parts.Length == 5 && parts[1] == "api" && parts[2] == "users" && parts[4] == "avatar") return UserSegment.IsMatch(parts[3]) && parts[3] != "." && parts[3] != "..";
            bool allowed = parts.Length == 4 && parts[1] == "api" && (parts[2] == "avatars" || parts[2] == "banners");
            allowed = allowed || (parts.Length == 5 && parts[1] == "api" && parts[2] == "forum" && parts[3] == "images");
            allowed = allowed || (parts.Length == 6 && parts[1] == "api" && parts[4] == "gallery");
            if (!allowed) return false;
            string name = parts[parts.Length - 1];
            return PlainFile.IsMatch(name) && !name.Contains("..");
        }

        public async Task<JsonNode> Image(string path)
        {
            if (!IsImagePath(path))
            {
                throw new ArgumentException("not a hub image path", nameof(path));
            }

            using HttpResponseMessage response = await Client
                .GetAsync(HubPath.BuildUri(path), HttpCompletionOption.ResponseHeadersRead)
                .ConfigureAwait(false);
            string mime = response.Content.Headers.ContentType?.MediaType ?? "application/octet-stream";
            var result = new JsonObject();
            result["status"] = JsonNumber.From((int)response.StatusCode);
            result["mime"] = new JsonString(mime);
            if (!response.IsSuccessStatusCode)
            {
                result["data"] = new JsonString(string.Empty);
                return result;
            }
            if (!mime.StartsWith("image/", StringComparison.Ordinal))
            {
                throw new InvalidOperationException("not an image: " + mime);
            }
            if (response.Content.Headers.ContentLength > MaxImageBytes)
            {
                throw new InvalidOperationException("image too large");
            }
            byte[] data = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
            if (data.Length > MaxImageBytes)
            {
                throw new InvalidOperationException("image too large");
            }
            result["data"] = new JsonString(Convert.ToBase64String(data));
            return result;
        }

        // ---- parsing ----

        private static JsonObject ParseRaw(string text)
        {
            JsonNode node;
            try { node = JsonReader.Parse(text); }
            catch (Exception) { throw new InvalidOperationException("the hub sent something unreadable"); }
            if (node is not JsonObject obj)
            {
                throw new InvalidOperationException("the hub sent something unexpected");
            }
            return obj;
        }

        private static JsonObject ParseObject(string text, string? token) => (JsonObject)RedactNode(ParseRaw(text), token);

        private static string ErrorFrom(int status, string text, string? token)
        {
            string message = string.Empty;
            try
            {
                if (JsonReader.Parse(text) is JsonObject obj && obj.TryGetValue("error", out JsonNode error) &&
                    error is JsonString value)
                {
                    message = value.Value;
                }
            }
            catch (Exception)
            {
                // Not JSON; keep the generic message.
            }
            message = Redact(message, token);
            if (!string.IsNullOrEmpty(message)) return message;
            return status == 401 ? "not logged in" : "the hub answered " + status;
        }

        private static JsonNode RedactNode(JsonNode node, string? token)
        {
            if (node is JsonString text)
            {
                return token is null ? text : new JsonString(Redact(text.Value, token));
            }
            if (node is JsonArray array)
            {
                var copy = new JsonArray();
                foreach (JsonNode item in array) copy.Add(RedactNode(item, token));
                return copy;
            }
            if (node is JsonObject obj)
            {
                var copy = new JsonObject();
                foreach (KeyValuePair<string, JsonNode> item in obj)
                {
                    if (item.Key.Equals("token", StringComparison.OrdinalIgnoreCase) ||
                        item.Key.Equals("password", StringComparison.OrdinalIgnoreCase) ||
                        item.Key.Equals("password_hash", StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }
                    copy[item.Key] = RedactNode(item.Value, token);
                }
                return copy;
            }
            return node;
        }

        private static string Redact(string text, string? token)
        {
            if (string.IsNullOrEmpty(text) || string.IsNullOrEmpty(token)) return text;
            return text.Replace(token!, "[redacted]", StringComparison.Ordinal);
        }

        private static string StringOf(JsonObject obj, string key) =>
            obj.TryGetValue(key, out JsonNode node) && node is JsonString value ? value.Value : string.Empty;

        private static bool BoolOf(JsonObject obj, string key) =>
            obj.TryGetValue(key, out JsonNode node) && node is JsonBool value && value.Value;
    }
}

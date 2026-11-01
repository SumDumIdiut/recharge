using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Recharge.Server
{
    /// <summary>R2 settings: the account, a key pair, the bucket and (optionally) an endpoint override.</summary>
    public sealed class R2Config
    {
        public string AccessKey = "";
        public string Secret = "";
        public string Bucket = "";
        public string Endpoint = "";

        /// <summary>
        /// Reads the same names the hub uses (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT) from the
        /// environment, then from the env file (RECHARGE_R2_ENV, else ~/.config/recharge/r2.env). Null when not all are present.
        /// Values are never logged.
        /// </summary>
        public static R2Config? Load(Func<string, string?>? env = null, string? envFile = null)
        {
            env ??= Environment.GetEnvironmentVariable;
            var fromFile = new Dictionary<string, string>(StringComparer.Ordinal);
            string? file = envFile ?? env("RECHARGE_R2_ENV") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config", "recharge", "r2.env");
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

            string? key = Get("R2_ACCESS_KEY_ID"), secret = Get("R2_SECRET_ACCESS_KEY"), bucket = Get("R2_BUCKET");
            string? endpoint = Get("R2_ENDPOINT");
            string? account = Get("R2_ACCOUNT_ID");
            if (string.IsNullOrEmpty(endpoint) && !string.IsNullOrEmpty(account)) endpoint = "https://" + account + ".r2.cloudflarestorage.com";
            if (string.IsNullOrEmpty(key) || string.IsNullOrEmpty(secret) || string.IsNullOrEmpty(bucket) || string.IsNullOrEmpty(endpoint)) return null;
            return new R2Config { AccessKey = key!, Secret = secret!, Bucket = bucket!, Endpoint = endpoint!.TrimEnd('/') };
        }
    }

    /// <summary>
    /// Presigned GET links (AWS SigV4 query signing) for private objects in the R2 bucket. Only keys under "private/" are
    /// ever signed, so a share can never point at the public downloads. The config is read when first needed, so the
    /// server can start before r2.env exists.
    /// </summary>
    public sealed class R2ShareSigner : IShareSigner
    {
        public const string PrivatePrefix = "private/";

        private readonly Func<R2Config?> _load;
        private readonly Func<DateTimeOffset> _clock;
        private R2Config? _cfg;

        public R2ShareSigner(Func<R2Config?> load, Func<DateTimeOffset>? clock = null)
        {
            _load = load;
            _clock = clock ?? (() => DateTimeOffset.UtcNow);
        }

        public SignedLink Sign(string objectKey, DateTimeOffset expires)
        {
            if (!objectKey.StartsWith(PrivatePrefix, StringComparison.Ordinal) || objectKey.Contains("..", StringComparison.Ordinal))
                throw new SocialException(400, "That file isn't a private share.");
            R2Config? cfg = _cfg ??= _load();
            if (cfg is null) throw new SocialException(503, "Private downloads are not configured on this server.");

            DateTimeOffset now = _clock();
            long seconds = (long)Math.Ceiling((expires - now).TotalSeconds);
            if (seconds < 1) seconds = 1;
            if (seconds > 604800) seconds = 604800;
            var endpoint = new Uri(cfg.Endpoint);
            string host = endpoint.IsDefaultPort ? endpoint.Host : endpoint.Host + ":" + endpoint.Port.ToString(CultureInfo.InvariantCulture);
            string path = "/" + cfg.Bucket + "/" + EncodePath(objectKey);
            string query = Presign("GET", host, path, cfg.AccessKey, cfg.Secret, "auto", "s3", now.UtcDateTime.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture), seconds);
            return new SignedLink(endpoint.Scheme + "://" + host + path + "?" + query, now.AddSeconds(seconds));
        }

        /// <summary>The signed query string (X-Amz-... parameters, signature last) for a presigned request with only the host header signed.</summary>
        public static string Presign(string method, string host, string canonicalPath, string accessKey, string secret, string region, string service, string amzDate, long expiresSeconds)
        {
            string day = amzDate.Substring(0, 8);
            string scope = day + "/" + region + "/" + service + "/aws4_request";
            string query =
                "X-Amz-Algorithm=AWS4-HMAC-SHA256" +
                "&X-Amz-Credential=" + EncodeSegment(accessKey + "/" + scope) +
                "&X-Amz-Date=" + amzDate +
                "&X-Amz-Expires=" + expiresSeconds.ToString(CultureInfo.InvariantCulture) +
                "&X-Amz-SignedHeaders=host";
            string canonical = method + "\n" + canonicalPath + "\n" + query + "\nhost:" + host + "\n\nhost\nUNSIGNED-PAYLOAD";
            string toSign = "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + Hex(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));
            byte[] k = Hmac(Hmac(Hmac(Hmac(Encoding.UTF8.GetBytes("AWS4" + secret), day), region), service), "aws4_request");
            return query + "&X-Amz-Signature=" + Hex(Hmac(k, toSign));
        }

        private static byte[] Hmac(byte[] key, string data)
        {
            using var h = new HMACSHA256(key);
            return h.ComputeHash(Encoding.UTF8.GetBytes(data));
        }

        private static string Hex(byte[] b) => Convert.ToHexString(b).ToLowerInvariant();

        private static string EncodeSegment(string s)
        {
            var sb = new StringBuilder();
            foreach (byte b in Encoding.UTF8.GetBytes(s))
            {
                char c = (char)b;
                if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') sb.Append(c);
                else sb.Append('%').Append(b.ToString("X2", CultureInfo.InvariantCulture));
            }
            return sb.ToString();
        }

        public static string EncodePath(string key)
        {
            string[] parts = key.Split('/');
            for (int i = 0; i < parts.Length; i++) parts[i] = EncodeSegment(parts[i]);
            return string.Join("/", parts);
        }
    }
}

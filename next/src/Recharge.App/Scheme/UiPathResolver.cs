using System;
using System.Collections.Generic;
using System.IO;

namespace Recharge.App.Scheme
{
    public enum UiPathStatus
    {
        Ok,
        NotFound,
        Forbidden,
    }

    /// <summary>The outcome of mapping a recharge:// URI onto the UI folder.</summary>
    public sealed class UiPathResult
    {
        public UiPathStatus Status { get; }
        public string FullPath { get; }
        public string MimeType { get; }
        public string Message { get; }

        internal UiPathResult(UiPathStatus status, string fullPath, string mimeType, string message)
        {
            Status = status;
            FullPath = fullPath;
            MimeType = mimeType;
            Message = message;
        }
    }

    /// <summary>
    /// Maps <c>recharge://app/&lt;path&gt;</c> to a file below the UI root.
    /// Traversal and absolute paths are rejected before touching the file system.
    /// </summary>
    public static class UiPathResolver
    {
        private const string Prefix = "recharge://";

        private static readonly Dictionary<string, string> MimeTypes =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                [".html"] = "text/html; charset=utf-8",
                [".htm"] = "text/html; charset=utf-8",
                [".js"] = "text/javascript; charset=utf-8",
                [".mjs"] = "text/javascript; charset=utf-8",
                [".css"] = "text/css; charset=utf-8",
                [".json"] = "application/json; charset=utf-8",
                [".map"] = "application/json; charset=utf-8",
                [".png"] = "image/png",
                [".jpg"] = "image/jpeg",
                [".jpeg"] = "image/jpeg",
                [".webp"] = "image/webp",
                [".gif"] = "image/gif",
                [".svg"] = "image/svg+xml",
                [".ico"] = "image/x-icon",
                [".woff"] = "font/woff",
                [".woff2"] = "font/woff2",
                [".ttf"] = "font/ttf",
                [".otf"] = "font/otf",
                [".mp4"] = "video/mp4",
                [".webm"] = "video/webm",
                [".mp3"] = "audio/mpeg",
                [".ogg"] = "audio/ogg",
                [".wav"] = "audio/wav",
                [".txt"] = "text/plain; charset=utf-8",
                [".wasm"] = "application/wasm",
            };

        public static string MimeTypeFor(string path)
        {
            string extension = Path.GetExtension(path);
            return MimeTypes.TryGetValue(extension, out string? mime)
                ? mime
                : "application/octet-stream";
        }

        public static UiPathResult Resolve(string root, string uri)
        {
            if (string.IsNullOrEmpty(root))
            {
                throw new ArgumentException("UI root is required.", nameof(root));
            }
            if (uri is null)
            {
                return Forbidden("Missing URI.");
            }

            string fullRoot = Path.GetFullPath(root);
            fullRoot = fullRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (fullRoot.Length == 0)
            {
                fullRoot = Path.DirectorySeparatorChar.ToString();
            }

            if (!uri.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase))
            {
                return Forbidden("Unsupported URI.");
            }

            string remainder = uri.Substring(Prefix.Length);

            int hash = remainder.IndexOf('#');
            if (hash >= 0)
            {
                remainder = remainder.Substring(0, hash);
            }
            int query = remainder.IndexOf('?');
            if (query >= 0)
            {
                remainder = remainder.Substring(0, query);
            }

            int slash = remainder.IndexOf('/');
            string host;
            string encodedPath;
            if (slash < 0)
            {
                host = remainder;
                encodedPath = "/";
            }
            else
            {
                host = remainder.Substring(0, slash);
                encodedPath = remainder.Substring(slash);
            }

            if (!string.Equals(host, "app", StringComparison.OrdinalIgnoreCase))
            {
                return Forbidden("Unknown recharge host.");
            }

            string decodedPath;
            try
            {
                decodedPath = Uri.UnescapeDataString(encodedPath);
            }
            catch (UriFormatException)
            {
                return Forbidden("Malformed URI escape.");
            }

            if (decodedPath.IndexOf('\0') >= 0)
            {
                return Forbidden("NUL byte in path.");
            }

            // A leading double slash is an absolute path on Unix; never join it.
            if (decodedPath.StartsWith("//", StringComparison.Ordinal))
            {
                return Forbidden("Absolute paths are not allowed.");
            }

            string[] segments = decodedPath.Split('/');
            var safeSegments = new List<string>(segments.Length);
            foreach (string segment in segments)
            {
                if (segment.Length == 0 || segment == ".")
                {
                    continue;
                }
                if (segment == ".." || segment.IndexOf('\\') >= 0)
                {
                    return Forbidden("Path traversal is not allowed.");
                }
                safeSegments.Add(segment);
            }

            if (safeSegments.Count == 0)
            {
                safeSegments.Add("index.html");
            }

            string relative = string.Join(Path.DirectorySeparatorChar.ToString(), safeSegments);
            string candidate = Path.GetFullPath(Path.Combine(fullRoot, relative));

            string rootWithSeparator = fullRoot.EndsWith(
                Path.DirectorySeparatorChar.ToString(),
                StringComparison.Ordinal)
                ? fullRoot
                : fullRoot + Path.DirectorySeparatorChar;

            if (!string.Equals(candidate, fullRoot, StringComparison.Ordinal) &&
                !candidate.StartsWith(rootWithSeparator, StringComparison.Ordinal))
            {
                return Forbidden("Path escapes the UI folder.");
            }

            string mime = MimeTypeFor(candidate);
            if (Directory.Exists(candidate))
            {
                candidate = Path.Combine(candidate, "index.html");
                mime = MimeTypeFor(candidate);
            }

            if (!File.Exists(candidate))
            {
                return new UiPathResult(
                    UiPathStatus.NotFound,
                    candidate,
                    mime,
                    "Not found: " + uri);
            }

            return new UiPathResult(UiPathStatus.Ok, candidate, mime, string.Empty);
        }

        private static UiPathResult Forbidden(string message) =>
            new UiPathResult(UiPathStatus.Forbidden, string.Empty, "text/plain; charset=utf-8", message);
    }
}

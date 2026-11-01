using System;
using System.IO;

namespace Recharge.App.Scheme
{
    /// <summary>
    /// Maps <c>recharge://bg/&lt;backgrounds|playlists&gt;/&lt;folder&gt;/&lt;file&gt;</c> to one media file in the app's backgrounds folder
    /// (<c>&lt;data&gt;/backgrounds/&lt;kind&gt;/&lt;folder&gt;/&lt;file&gt;</c>). Read-only; the folders are flat, so the file is one plain name.
    /// </summary>
    public static class BackgroundPathResolver
    {
        private const string Prefix = "recharge://bg/";

        public static string Root(string dataDir) => Path.Combine(dataDir, "backgrounds");

        public static UiPathResult Resolve(string backgroundsRoot, string uri)
        {
            if (string.IsNullOrEmpty(backgroundsRoot)) throw new ArgumentException("Backgrounds root is required.", nameof(backgroundsRoot));
            if (uri is null || !uri.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase)) return Forbidden("Unsupported URI.");

            string remainder = uri.Substring(Prefix.Length);
            int cut = remainder.IndexOfAny(new[] { '#', '?' });
            if (cut >= 0) remainder = remainder.Substring(0, cut);

            string[] parts = remainder.Split('/');
            if (parts.Length != 3) return Forbidden("A kind, a folder and a file are required.");
            string kind, folder, file;
            try
            {
                kind = Uri.UnescapeDataString(parts[0]);
                folder = Uri.UnescapeDataString(parts[1]);
                file = Uri.UnescapeDataString(parts[2]);
            }
            catch (UriFormatException)
            {
                return Forbidden("Malformed URI escape.");
            }
            if (kind != "backgrounds" && kind != "playlists") return Forbidden("Unknown kind.");
            if (!MapPathResolver.IsPlainName(folder)) return Forbidden("Invalid folder.");
            if (!MapPathResolver.IsPlainName(file)) return Forbidden("Invalid file.");

            string root = Path.GetFullPath(backgroundsRoot).TrimEnd(Path.DirectorySeparatorChar);
            string candidate = Path.GetFullPath(Path.Combine(root, kind, folder, file));
            string expectedDir = Path.Combine(root, kind, folder);
            if (!string.Equals(Path.GetDirectoryName(candidate), expectedDir, StringComparison.Ordinal))
                return Forbidden("Path escapes the folder.");

            string mime = UiPathResolver.MimeTypeFor(candidate);
            if (!File.Exists(candidate)) return new UiPathResult(UiPathStatus.NotFound, candidate, mime, "Not found: " + uri);
            return new UiPathResult(UiPathStatus.Ok, candidate, mime, string.Empty);
        }

        private static UiPathResult Forbidden(string message) =>
            new UiPathResult(UiPathStatus.Forbidden, string.Empty, "text/plain; charset=utf-8", message);
    }

    /// <summary>A parsed HTTP Range header over a file of known length.</summary>
    public readonly struct ByteRange
    {
        /// <summary>One answer is never longer than this, so a seek in a big video never reads the whole file.</summary>
        public const long MaxChunk = 2L * 1024 * 1024;

        public enum Kind { Full, Partial, Unsatisfiable }

        public Kind Result { get; }
        public long Start { get; }
        /// <summary>Last byte to send, inclusive.</summary>
        public long End { get; }
        public long Length => Result == Kind.Partial ? End - Start + 1 : 0;

        private ByteRange(Kind result, long start, long end)
        {
            Result = result;
            Start = start;
            End = end;
        }

        /// <summary>No usable range (missing, malformed or several ranges): send the whole file.</summary>
        public static ByteRange Parse(string? header, long fileLength, long maxChunk = MaxChunk)
        {
            var full = new ByteRange(Kind.Full, 0, fileLength - 1);
            if (string.IsNullOrWhiteSpace(header)) return full;
            string h = header.Trim();
            if (!h.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase)) return full;
            string spec = h.Substring(6).Trim();
            if (spec.Length == 0 || spec.Contains(',')) return full;
            int dash = spec.IndexOf('-');
            if (dash < 0) return full;
            string a = spec.Substring(0, dash).Trim(), b = spec.Substring(dash + 1).Trim();
            long start, end;
            if (a.Length == 0)
            {
                // suffix: the last n bytes
                if (!long.TryParse(b, out long n) || n < 0) return full;
                if (n == 0 || fileLength == 0) return new ByteRange(Kind.Unsatisfiable, 0, 0);
                start = Math.Max(0, fileLength - n);
                end = fileLength - 1;
            }
            else
            {
                if (!long.TryParse(a, out start) || start < 0) return full;
                if (b.Length == 0) end = fileLength - 1;
                else if (!long.TryParse(b, out end) || end < start) return full;
                if (start >= fileLength) return new ByteRange(Kind.Unsatisfiable, 0, 0);
                if (end >= fileLength) end = fileLength - 1;
            }
            if (end - start + 1 > maxChunk) end = start + maxChunk - 1;
            return new ByteRange(Kind.Partial, start, end);
        }
    }
}

using System;
using System.Collections.Generic;
using System.IO;

namespace Recharge.App.Scheme
{
    /// <summary>
    /// Maps <c>recharge://maps/&lt;folder&gt;/&lt;path&gt;</c> to a file below one installed map folder
    /// (<c>&lt;maps root&gt;/&lt;folder&gt;/</c>). Read-only: it only ever answers with a path to read.
    /// </summary>
    public static class MapPathResolver
    {
        private const string Prefix = "recharge://maps/";

        /// <summary>The maps folder inside a game install.</summary>
        public static string MapsRoot(string gameDir) =>
            Path.Combine(gameDir, "Recharge", "Mods", "recharge.maps", "maps");

        /// <summary>A folder name is one plain segment: no separators, no dots-only names, no NUL.</summary>
        public static bool IsPlainName(string name) =>
            name.Length > 0 && name != "." && name != ".." &&
            name.IndexOfAny(new[] { '/', '\\', '\0', ':' }) < 0 &&
            name.Trim() == name;

        public static UiPathResult Resolve(string mapsRoot, string uri)
        {
            if (string.IsNullOrEmpty(mapsRoot)) throw new ArgumentException("Maps root is required.", nameof(mapsRoot));
            if (uri is null || !uri.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase))
                return Forbidden("Unsupported URI.");

            string remainder = uri.Substring(Prefix.Length);
            int cut = remainder.IndexOfAny(new[] { '#', '?' });
            if (cut >= 0) remainder = remainder.Substring(0, cut);

            int slash = remainder.IndexOf('/');
            if (slash <= 0) return Forbidden("A map folder and a file are required.");
            string folder, filePart;
            try
            {
                folder = Uri.UnescapeDataString(remainder.Substring(0, slash));
                filePart = Uri.UnescapeDataString(remainder.Substring(slash));
            }
            catch (UriFormatException)
            {
                return Forbidden("Malformed URI escape.");
            }

            if (!IsPlainName(folder)) return Forbidden("Invalid map folder.");
            if (filePart.IndexOf('\0') >= 0) return Forbidden("NUL byte in path.");
            if (filePart.StartsWith("//", StringComparison.Ordinal)) return Forbidden("Absolute paths are not allowed.");

            var segments = new List<string>();
            foreach (string segment in filePart.Split('/'))
            {
                if (segment.Length == 0 || segment == ".") continue;
                if (segment == ".." || segment.IndexOf('\\') >= 0) return Forbidden("Path traversal is not allowed.");
                segments.Add(segment);
            }
            if (segments.Count == 0) return Forbidden("A file is required.");

            string root = Path.GetFullPath(mapsRoot).TrimEnd(Path.DirectorySeparatorChar);
            string folderFull = Path.GetFullPath(Path.Combine(root, folder));
            if (!string.Equals(Path.GetDirectoryName(folderFull), root, StringComparison.Ordinal))
                return Forbidden("Invalid map folder.");

            string candidate = Path.GetFullPath(Path.Combine(folderFull, string.Join(Path.DirectorySeparatorChar.ToString(), segments)));
            if (!candidate.StartsWith(folderFull + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                return Forbidden("Path escapes the map folder.");

            if (!File.Exists(candidate))
                return new UiPathResult(UiPathStatus.NotFound, candidate, UiPathResolver.MimeTypeFor(candidate), "Not found: " + uri);
            return new UiPathResult(UiPathStatus.Ok, candidate, UiPathResolver.MimeTypeFor(candidate), string.Empty);
        }

        private static UiPathResult Forbidden(string message) =>
            new UiPathResult(UiPathStatus.Forbidden, string.Empty, "text/plain; charset=utf-8", message);
    }
}

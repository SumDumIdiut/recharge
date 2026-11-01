using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace Recharge.App.Library
{
    /// <summary>
    /// A map's identity is the top-level "uid" in its map.json. A copy of a map folder carries the source's uid, and the hub
    /// (and the old app) used the uid to decide "this upload is a new version of that upload", so copies overwrote their source.
    /// Rule here: a map made as a copy (save-as, duplicate), or any folder whose uid already belongs to another local folder,
    /// gets a fresh uid. The fresh uid is a hash of (source uid, destination folder, attempt), so it is deterministic and testable,
    /// and a copy never inherits the source's hub link either (hub.json is not copied).
    /// </summary>
    public static class MapIdentity
    {
        public static string? UidOf(string folder)
        {
            string file = Path.Combine(folder, "map.json");
            if (!File.Exists(file)) return null;
            try { using var reader = new StreamReader(file); return InstalledScanner.ScanTopLevelString(reader, "uid"); }
            catch (IOException) { return null; }
        }

        /// <summary>A uid derived from the source uid and the destination folder name: the same inputs always give the same uid.</summary>
        public static string NewUid(string? sourceUid, string destFolderName, int attempt = 0)
        {
            byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes("recharge-next/map-uid|" + (sourceUid ?? "") + "|" + destFolderName + "|" + attempt));
            var b = new byte[16];
            Array.Copy(hash, b, 16);
            b[7] = (byte)((b[7] & 0x0F) | 0x50); // version-5-style marks it as derived
            b[8] = (byte)((b[8] & 0x3F) | 0x80);
            return new Guid(b).ToString("D");
        }

        /// <summary>Uids that more than one folder in <paramref name="mapsDir"/> carries, with their folders (sorted).</summary>
        public static Dictionary<string, List<string>> FindCollisions(string mapsDir)
        {
            var byUid = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            if (!Directory.Exists(mapsDir)) return byUid;
            foreach (string d in Directory.GetDirectories(mapsDir).OrderBy(x => x, StringComparer.Ordinal))
            {
                if (Path.GetFileName(d).StartsWith(".", StringComparison.Ordinal)) continue;
                string? uid = UidOf(d);
                if (string.IsNullOrEmpty(uid)) continue;
                if (!byUid.TryGetValue(uid!, out List<string>? list)) byUid[uid!] = list = new List<string>();
                list.Add(Path.GetFileName(d));
            }
            return byUid.Where(kv => kv.Value.Count > 1).ToDictionary(kv => kv.Key, kv => kv.Value);
        }

        /// <summary>
        /// Save-as / duplicate: copies srcFolder to destFolder, drops the hub link, and gives the copy a fresh uid
        /// (distinct from every uid in the maps folder). Returns the new uid.
        /// </summary>
        public static string SaveAs(string mapsDir, string srcFolder, string destFolder)
        {
            string src = Path.Combine(mapsDir, srcFolder), dest = Path.Combine(mapsDir, destFolder);
            if (!Directory.Exists(src)) throw new DirectoryNotFoundException(src);
            if (Directory.Exists(dest)) throw new IOException("the folder " + destFolder + " already exists");
            Copy(src, dest);
            File.Delete(Path.Combine(dest, "hub.json"));
            return Reassign(mapsDir, destFolder, UidOf(src));
        }

        /// <summary>
        /// For a folder about to be opened or saved: if another local folder has the same uid, this one gets a fresh uid.
        /// Returns the (possibly new) uid. Nothing is deleted.
        /// </summary>
        public static string? EnsureUnique(string mapsDir, string folder)
        {
            string? uid = UidOf(Path.Combine(mapsDir, folder));
            if (string.IsNullOrEmpty(uid)) return uid;
            bool taken = Directory.GetDirectories(mapsDir).Any(d => Path.GetFileName(d) != folder
                && !Path.GetFileName(d).StartsWith(".", StringComparison.Ordinal) && UidOf(d) == uid);
            return taken ? Reassign(mapsDir, folder, uid) : uid;
        }

        private static string Reassign(string mapsDir, string folder, string? sourceUid)
        {
            var used = new HashSet<string>(Directory.GetDirectories(mapsDir).Select(UidOf).Where(u => !string.IsNullOrEmpty(u))!, StringComparer.Ordinal);
            string fresh = NewUid(sourceUid, folder);
            for (int n = 1; used.Contains(fresh); n++) fresh = NewUid(sourceUid, folder, n);
            string file = Path.Combine(mapsDir, folder, "map.json");
            File.WriteAllText(file, SetTopLevelString(File.ReadAllText(file), "uid", fresh), new UTF8Encoding(false));
            return fresh;
        }

        /// <summary>Replaces (or inserts) the top-level string member <paramref name="key"/> in a JSON object text; the rest is left byte for byte.</summary>
        public static string SetTopLevelString(string json, string key, string value)
        {
            string quoted = "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
            int depth = 0;
            for (int i = 0; i < json.Length; i++)
            {
                char c = json[i];
                if (c == '"')
                {
                    int start = i;
                    var sb = new StringBuilder();
                    for (i++; i < json.Length && json[i] != '"'; i++)
                    {
                        if (json[i] == '\\' && i + 1 < json.Length) i++;
                        sb.Append(json[i]);
                    }
                    if (depth == 1 && sb.ToString() == key)
                    {
                        int j = i + 1;
                        while (j < json.Length && char.IsWhiteSpace(json[j])) j++;
                        if (j < json.Length && json[j] == ':')
                        {
                            j++;
                            while (j < json.Length && char.IsWhiteSpace(json[j])) j++;
                            if (j < json.Length && json[j] == '"')
                            {
                                int end = j + 1;
                                while (end < json.Length && json[end] != '"') end += json[end] == '\\' ? 2 : 1;
                                return json.Substring(0, j) + quoted + json.Substring(Math.Min(end + 1, json.Length));
                            }
                        }
                    }
                    continue;
                }
                if (c == '{' || c == '[') depth++;
                else if (c == '}' || c == ']') depth--;
            }
            int brace = json.IndexOf('{');
            if (brace < 0) throw new InvalidOperationException("map.json is not an object");
            bool empty = json.Substring(brace + 1).TrimStart().StartsWith("}", StringComparison.Ordinal);
            return json.Substring(0, brace + 1) + "\"" + key + "\":" + quoted + (empty ? "" : ",") + json.Substring(brace + 1);
        }

        private static void Copy(string from, string to)
        {
            Directory.CreateDirectory(to);
            foreach (string f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)));
            foreach (string d in Directory.GetDirectories(from)) Copy(d, Path.Combine(to, Path.GetFileName(d)));
        }
    }
}

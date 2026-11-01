using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using Recharge.Core.Json;

namespace Recharge.App.Library
{
    /// <summary>
    /// Installs or updates a hub map package in the game's maps folder.
    /// The only thing that ties a folder to a hub entry is the hub id in its hub.json, written at install time:
    /// - the folder that holds this hub id is reused (replaced), whatever the map is called now;
    /// - otherwise the folder is a new one: a slug of the name, made unique when anything already lives there.
    ///   A folder is never reused because it has the same map.json uid or the same name: copies of a map share its uid, and
    ///   the current app overwrote the original that way (Cosmic Ocean installed over igtech). Local-only folders are never touched.
    /// - legacy collision: a folder stamped with this hub id whose recorded name is another hub entry's name was installed from that
    ///   other entry; it is not reused here.
    /// The package is extracted into a scratch folder beside the target first, so a bad package never damages what's installed.
    /// Every folder that gets replaced is moved to a backup first (the last few per folder are kept).
    /// </summary>
    public sealed class MapInstaller
    {
        public const long MaxPackageBytes = 200L * 1024 * 1024;
        public const int BackupsKept = FolderStore.BackupsKept;

        private readonly string _mapsDir;
        private readonly string _backupDir;
        private readonly Func<DateTime> _now;

        public MapInstaller(string mapsDir, string backupDir, Func<DateTime>? now = null)
        {
            _mapsDir = mapsDir;
            _backupDir = backupDir;
            _now = now ?? (() => DateTime.Now);
        }

        public sealed class Result
        {
            public string Folder = "";
            public string? BackedUp;
        }

        public Result Install(byte[] package, string hubId, string name, long revision, string? updatedAt, IReadOnlyCollection<string>? otherHubNames = null)
        {
            if (package.LongLength > MaxPackageBytes) throw new InvalidOperationException("the package is larger than 200 MB");
            if (!SafeId(hubId)) throw new ArgumentException("bad hub id", nameof(hubId));
            Directory.CreateDirectory(_mapsDir);

            string target = LinkedFolder(FolderStore.Folders(_mapsDir), hubId, name, otherHubNames) ?? FolderStore.NewFolder(_mapsDir, name, hubId);

            var result = new Result { Folder = Path.GetFileName(target) };
            string tmp = FolderStore.NewScratch(_mapsDir);
            try
            {
                Directory.CreateDirectory(tmp);
                using (var zip = FolderStore.OpenZip(new MemoryStream(package, false))) ExtractSafely(zip, tmp);
                if (!File.Exists(Path.Combine(tmp, "map.json"))) throw new InvalidOperationException("the package has no map.json");
                File.WriteAllText(Path.Combine(tmp, "hub.json"), HubJson(hubId, name, revision, updatedAt));
                if (Directory.Exists(target)) result.BackedUp = FolderStore.Backup(target, _backupDir, _now);
                Directory.Move(tmp, target);
            }
            catch
            {
                TryDelete(tmp);
                throw;
            }
            return result;
        }

        /// <summary>hub.json as the current app writes it (serde_json's json! macro: keys in alphabetical order, compact).</summary>
        public static string HubJson(string hubId, string name, long revision, string? updatedAt)
        {
            var o = new JsonObject();
            o["id"] = new JsonString(hubId);
            o["name"] = new JsonString(name);
            o["revision"] = JsonNumber.From(revision);
            o["updatedAt"] = updatedAt == null ? (JsonNode)JsonNull.Instance : new JsonString(updatedAt);
            return JsonWriter.Write(o, 0);
        }

        public static string Slugify(string name) => FolderStore.Slugify(name);

        /// <summary>The existing folder this hub id was installed into, or null. Folders claiming the id under another hub entry's name are skipped.</summary>
        public static string? LinkedFolder(IEnumerable<string> folders, string hubId, string name, IReadOnlyCollection<string>? otherHubNames)
        {
            var claims = folders.Where(d => HubIdOf(d) == hubId).ToList();
            if (otherHubNames != null)
                claims = claims.Where(d =>
                {
                    string? recorded = RecordedName(d);
                    return recorded == null || Same(recorded, name) || !otherHubNames.Any(o => Same(o, recorded));
                }).ToList();
            return claims.FirstOrDefault(d => { string? r = RecordedName(d); return r != null && Same(r, name); }) ?? claims.FirstOrDefault();
        }

        private static bool Same(string a, string b) => string.Equals(a.Trim(), b.Trim(), StringComparison.OrdinalIgnoreCase);

        /// <summary>The name a folder was installed under: hub.json's, else map.json's.</summary>
        private static string? RecordedName(string folder)
        {
            try
            {
                string file = Path.Combine(folder, "hub.json");
                if (File.Exists(file) && JsonReader.Parse(File.ReadAllText(file)) is JsonObject o && o.TryGetValue("name", out JsonNode v) && v is JsonString s && s.Value.Length > 0) return s.Value;
            }
            catch { /* fall through */ }
            return NameOf(folder);
        }

        public static void ExtractSafely(ZipArchive zip, string root) => FolderStore.ExtractSafely(zip, root);

        private static string? HubIdOf(string folder)
        {
            try
            {
                string file = Path.Combine(folder, "hub.json");
                if (!File.Exists(file)) return null;
                return JsonReader.Parse(File.ReadAllText(file)) is JsonObject o && o.TryGetValue("id", out JsonNode v) && v is JsonString s ? s.Value : null;
            }
            catch { return null; }
        }

        private static string? NameOf(string folder) => ReadTop(folder, "name");

        private static string? ReadTop(string folder, string key)
        {
            string file = Path.Combine(folder, "map.json");
            if (!File.Exists(file)) return null;
            try { using var reader = new StreamReader(file); return TopLevelString(reader, key); }
            catch { return null; }
        }

        /// <summary>A top-level string field read by a light scan (map.json can be 80 MB, so it's never parsed whole).</summary>
        public static string? TopLevelString(TextReader reader, string key) => InstalledScanner.ScanTopLevelString(reader, key);

        private static bool SafeId(string id) => FolderStore.SafeId(id);

        private static void TryDelete(string dir) => FolderStore.TryDelete(dir);
    }
}

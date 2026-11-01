using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using Recharge.Core.Json;

namespace Recharge.App.Library
{
    public enum ContentKind { Mod, Skin, Background, Playlist }

    /// <summary>
    /// Installs, updates and removes hub mods, skins, backgrounds and playlists, each as a folder under one root, following the
    /// current app's rules (hub.rs install_mod_into / install_skin_into, backgrounds.rs install_hub_*):
    /// - the only link between a folder and a hub entry is the hub id in its HUB_META_FILE; the folder holding the id is reused
    ///   (replaced), anything else is a new folder (slug of the name, made unique); another entry's folder is never written into;
    /// - mods live in a folder named by their mod.json id (the id is global); a hub entry that changed its mod id moves to the new
    ///   folder and the old copy is backed up; a mod folder with the same id but no/another hub link is refused, not overwritten;
    /// - the package is unpacked into a scratch folder beside the target first, so a bad package never touches what's installed;
    /// - whatever gets replaced or removed goes to the backup store first (the last few per folder are kept);
    /// - user data inside a mod or skin (data/, maps/, saves/) is carried over to the updated folder and left in place by Remove.
    /// A background is one media file (the hub serves it raw); a playlist is a zip of pictures, videos, sounds and video posters,
    /// unpacked flat with the current app's limits.
    /// </summary>
    public sealed class ContentInstaller
    {
        public const string MetaFile = ".recharge-hub-meta.json";
        public const long MaxPackageBytes = 200L * 1024 * 1024;
        public const long MaxBackgroundBytes = 95L * 1024 * 1024;
        public const long MaxPlaylistBytes = 5L * 1024 * 1024 * 1024;
        public const int MaxPlaylistFiles = 50;
        public const int MaxPosterBytes = 2 * 1024 * 1024;
        private const long MaxImageBytes = 15L * 1024 * 1024, MaxVideoBytes = 90L * 1024 * 1024, MaxAudioBytes = 20L * 1024 * 1024;

        private static readonly string[] ImageExts = { "png", "jpg", "jpeg", "webp", "gif" };
        private static readonly string[] VideoExts = { "mp4", "webm" };
        private static readonly string[] AudioExts = { "mp3", "ogg", "wav" };
        private static readonly HashSet<string> UserData = new HashSet<string>(StringComparer.Ordinal) { "data", "maps", "saves" };

        private readonly ContentKind _kind;
        private readonly string _root;
        private readonly string _backupDir;
        private readonly Func<DateTime> _now;

        public ContentInstaller(ContentKind kind, string root, string backupDir, Func<DateTime>? now = null)
        {
            _kind = kind;
            _root = root;
            _backupDir = backupDir;
            _now = now ?? (() => DateTime.Now);
        }

        public sealed class Result
        {
            public string Folder = "";
            public string? BackedUp;
            public int Files;
        }

        public long PackageLimit => _kind == ContentKind.Playlist ? MaxPlaylistBytes : _kind == ContentKind.Background ? MaxBackgroundBytes : MaxPackageBytes;

        public Result Install(byte[] package, string hubId, string name, long revision, string? updatedAt, string author = "") =>
            Install(new MemoryStream(package, false), hubId, name, revision, updatedAt, author);

        /// <summary>Installs or updates. The stream must be seekable (a playlist is read from its downloaded file).</summary>
        public Result Install(Stream package, string hubId, string name, long revision, string? updatedAt, string author = "")
        {
            if (package.Length > PackageLimit) throw new InvalidOperationException("the package is larger than " + PackageLimit / (1024 * 1024) + " MB");
            if (!FolderStore.SafeId(hubId)) throw new ArgumentException("bad hub id", nameof(hubId));
            Directory.CreateDirectory(_root);

            string tmp = FolderStore.NewScratch(_root);
            var result = new Result();
            var moved = new List<(string From, string To)>();
            string? backedUp = null;
            string? target = null;
            try
            {
                Directory.CreateDirectory(tmp);
                string? modId = Prepare(package, tmp, name, result);

                List<string> folders = FolderStore.Folders(_root);
                var oldCopies = new List<string>();
                if (_kind == ContentKind.Mod)
                {
                    target = Path.Combine(_root, modId!);
                    string? existing = HubIdOf(target);
                    if (Directory.Exists(target) && existing != null && existing != hubId)
                        throw new InvalidOperationException("the mod \"" + modId + "\" is already installed from another hub entry");
                    oldCopies = folders.Where(d => d != target && HubIdOf(d) == hubId).ToList();
                    KeepEnabled(target, tmp);
                }
                else
                {
                    target = folders.FirstOrDefault(d => HubIdOf(d) == hubId) ?? FolderStore.NewFolder(_root, name, hubId);
                }

                File.WriteAllText(Path.Combine(tmp, MetaFile), MetaJson(hubId, name, revision, updatedAt, _kind == ContentKind.Playlist ? author : null));
                if (_kind == ContentKind.Mod || _kind == ContentKind.Skin) CarryUserData(target, tmp, moved);
                if (Directory.Exists(target)) { backedUp = FolderStore.Backup(target, _backupDir, _now); result.BackedUp = backedUp; }
                Directory.Move(tmp, target);
                foreach (string old in oldCopies) { try { FolderStore.Backup(old, _backupDir, _now); } catch { /* the new copy is in; a stale old folder is only clutter */ } }
                result.Folder = Path.GetFileName(target);
            }
            catch
            {
                // put everything back: the replaced folder first, then any user data that was moved into the scratch folder
                if (backedUp != null && target != null && !Directory.Exists(target)) { try { Directory.Move(backedUp, target); } catch { /* the backup still holds it */ } }
                if (target != null && Directory.Exists(target)) foreach (var m in Enumerable.Reverse(moved)) TryMoveBack(m.To, m.From, target, tmp);
                FolderStore.TryDelete(tmp);
                throw;
            }
            return result;
        }

        /// <summary>Removes the folder linked to this hub id (to the backup store). User data in a mod or skin stays where it is. Returns null when nothing is linked.</summary>
        public Result? Remove(string hubId)
        {
            if (!FolderStore.SafeId(hubId)) throw new ArgumentException("bad hub id", nameof(hubId));
            string? target = FolderStore.Folders(_root).FirstOrDefault(d => HubIdOf(d) == hubId);
            if (target == null) return null;
            var result = new Result { Folder = Path.GetFileName(target) };
            bool keepsData = (_kind == ContentKind.Mod || _kind == ContentKind.Skin) && Directory.GetFileSystemEntries(target).Any(e => UserData.Contains(Path.GetFileName(e)));
            if (!keepsData)
            {
                result.BackedUp = FolderStore.Backup(target, _backupDir, _now);
                return result;
            }
            // everything but the user data goes; the data stays in place
            string split = FolderStore.NewScratch(_root);
            Directory.CreateDirectory(split);
            try
            {
                foreach (string entry in Directory.GetFileSystemEntries(target))
                {
                    string entryName = Path.GetFileName(entry);
                    if (UserData.Contains(entryName) && Directory.Exists(entry)) continue;
                    Move(entry, Path.Combine(split, entryName));
                }
                result.BackedUp = FolderStore.Backup(split, _backupDir, _now, result.Folder);
            }
            finally { FolderStore.TryDelete(split); }
            return result;
        }

        /// <summary>The hub id a folder was installed as (its meta file's "hubId"), or null.</summary>
        public static string? HubIdOf(string folder) => ReadMeta(folder)?.Id;

        public sealed class Meta
        {
            public string? Id;
            public string? Name;
            public long? Revision;
            public string? UpdatedAt;
        }

        public static Meta? ReadMeta(string folder)
        {
            try
            {
                string file = Path.Combine(folder, MetaFile);
                if (!File.Exists(file) || JsonReader.Parse(File.ReadAllText(file)) is not JsonObject o) return null;
                var m = new Meta();
                if (o.TryGetValue("hubId", out JsonNode a) && a is JsonString id) m.Id = id.Value;
                if (o.TryGetValue("name", out JsonNode b) && b is JsonString nm) m.Name = nm.Value;
                if (o.TryGetValue("revision", out JsonNode c) && c is JsonNumber rev && long.TryParse(rev.Raw, out long r)) m.Revision = r;
                if (o.TryGetValue("updatedAt", out JsonNode d) && d is JsonString up) m.UpdatedAt = up.Value;
                return m;
            }
            catch { return null; }
        }

        /// <summary>The meta file as the current app writes it (serde_json's json! macro: keys in alphabetical order, compact).</summary>
        public static string MetaJson(string hubId, string name, long revision, string? updatedAt, string? author = null)
        {
            var o = new JsonObject();
            if (author != null) o["author"] = new JsonString(author);
            o["hubId"] = new JsonString(hubId);
            o["name"] = new JsonString(name);
            o["revision"] = JsonNumber.From(revision);
            o["updatedAt"] = updatedAt == null ? (JsonNode)JsonNull.Instance : new JsonString(updatedAt);
            return JsonWriter.Write(o, 0);
        }

        // ---- per-kind unpacking into the scratch folder ----

        /// <summary>Unpacks and validates the package into tmp. Returns the mod id for mods.</summary>
        private string? Prepare(Stream package, string tmp, string name, Result result)
        {
            switch (_kind)
            {
                case ContentKind.Mod:
                {
                    using ZipArchive zip = FolderStore.OpenZip(package);
                    FolderStore.ExtractSafely(zip, tmp);
                    string manifest = Path.Combine(tmp, "mod.json");
                    if (!File.Exists(manifest)) throw new InvalidOperationException("the package is missing mod.json");
                    string id;
                    try { id = JsonReader.Parse(File.ReadAllText(manifest)) is JsonObject o && o.TryGetValue("id", out JsonNode v) && v is JsonString s ? s.Value : ""; }
                    catch (Exception e) { throw new InvalidOperationException("mod.json is not valid: " + e.Message); }
                    if (!SafeModId(id)) throw new InvalidOperationException("the package's mod id is not usable: '" + id + "'");
                    return id;
                }
                case ContentKind.Skin:
                {
                    using ZipArchive zip = FolderStore.OpenZip(package);
                    FolderStore.ExtractSafely(zip, tmp);
                    if (Directory.GetFiles(tmp, "*", SearchOption.AllDirectories).Length == 0) throw new InvalidOperationException("the skin package is empty");
                    return null;
                }
                case ContentKind.Background:
                {
                    var bytes = new byte[package.Length];
                    package.Position = 0;
                    package.ReadExactly(bytes, 0, bytes.Length);
                    string ext = SniffExt(bytes) ?? throw new InvalidOperationException("that file isn't a supported image, video or audio file");
                    File.WriteAllBytes(Path.Combine(tmp, BackgroundFileName(name, ext)), bytes);
                    result.Files = 1;
                    return null;
                }
                default:
                    result.Files = ExtractPlaylist(package, tmp);
                    if (result.Files == 0) throw new InvalidOperationException("that playlist has no usable pictures, videos or sounds");
                    return null;
            }
        }

        /// <summary>A mod id becomes a folder name: no separators, no dot names, nothing the file system would read as a path.</summary>
        public static bool SafeModId(string id) =>
            id.Length > 0 && id.Length <= 128 && id != "." && id != ".." && !id.StartsWith(".", StringComparison.Ordinal)
            && id.All(c => c >= ' ' && c != '/' && c != '\\' && c != ':' && c != '*' && c != '?' && c != '"' && c != '<' && c != '>' && c != '|');

        /// <summary>An update keeps whether the mod was switched on (install_mod_into).</summary>
        private static void KeepEnabled(string target, string tmp)
        {
            try
            {
                string oldFile = Path.Combine(target, "mod.json");
                if (!File.Exists(oldFile) || JsonReader.Parse(File.ReadAllText(oldFile)) is not JsonObject old) return;
                if (!old.TryGetValue("enabled", out JsonNode en) || en is not JsonBool b) return;
                string newFile = Path.Combine(tmp, "mod.json");
                if (JsonReader.Parse(File.ReadAllText(newFile)) is JsonObject fresh)
                {
                    fresh["enabled"] = b.Value ? JsonBool.True : JsonBool.False;
                    File.WriteAllText(newFile, JsonWriter.Write(fresh, 2));
                }
            }
            catch { /* an unreadable old mod.json just means the new one's default */ }
        }

        // ---- user data ----

        private static void CarryUserData(string target, string tmp, List<(string From, string To)> moved)
        {
            if (!Directory.Exists(target)) return;
            foreach (string entry in Directory.GetFileSystemEntries(target))
            {
                string n = Path.GetFileName(entry);
                if (!UserData.Contains(n) || !Directory.Exists(entry)) continue;
                string dest = Path.Combine(tmp, n);
                if (!Directory.Exists(dest) && !File.Exists(dest)) { Move(entry, dest); moved.Add((entry, dest)); }
                else if (Directory.Exists(dest)) MergeMissing(entry, dest, moved);
            }
        }

        private static void MergeMissing(string from, string into, List<(string From, string To)> moved)
        {
            foreach (string entry in Directory.GetFileSystemEntries(from))
            {
                string dest = Path.Combine(into, Path.GetFileName(entry));
                if (Directory.Exists(entry) && Directory.Exists(dest)) MergeMissing(entry, dest, moved);
                else if (!Directory.Exists(dest) && !File.Exists(dest)) { Move(entry, dest); moved.Add((entry, dest)); }
            }
        }

        private static void Move(string from, string to)
        {
            if (Directory.Exists(from)) Directory.Move(from, to); else File.Move(from, to);
        }

        private static void TryMoveBack(string from, string to, string target, string tmp)
        {
            try
            {
                if (!Directory.Exists(from) && !File.Exists(from)) return;
                Directory.CreateDirectory(Path.GetDirectoryName(to)!);
                Move(from, to);
            }
            catch { /* best effort; the data is still in the scratch folder / backup */ }
        }

        // ---- backgrounds and playlists (backgrounds.rs) ----

        private static string? ExtOf(string file)
        {
            int dot = file.LastIndexOf('.');
            return dot < 0 || dot == file.Length - 1 ? null : file.Substring(dot + 1).ToLowerInvariant();
        }

        /// <summary>"image" / "video" / "audio" by file extension; null for anything else.</summary>
        public static string? MediaKind(string file)
        {
            string? ext = ExtOf(file);
            if (ext == null) return null;
            return ImageExts.Contains(ext) ? "image" : VideoExts.Contains(ext) ? "video" : AudioExts.Contains(ext) ? "audio" : null;
        }

        private static bool IsPosterName(string name)
        {
            string l = name.ToLowerInvariant();
            return l.EndsWith(".poster.jpg", StringComparison.Ordinal) || l.EndsWith(".poster.png", StringComparison.Ordinal);
        }

        private static long CapFor(string file) => MediaKind(file) == "video" ? MaxVideoBytes : MediaKind(file) == "audio" ? MaxAudioBytes : MaxImageBytes;

        private static string? PosterExt(byte[] b) =>
            b.Length > 8 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF ? "jpg"
            : b.Length > 8 && b[0] == 0x89 && b[1] == (byte)'P' && b[2] == (byte)'N' && b[3] == (byte)'G' ? "png" : null;

        /// <summary>The real type of a downloaded file by its first bytes, or null.</summary>
        public static string? SniffExt(byte[] b)
        {
            bool Str(int at, string s) { if (b.Length < at + s.Length) return false; for (int i = 0; i < s.Length; i++) if (b[at + i] != s[i]) return false; return true; }
            if (b.Length > 12 && Str(4, "ftyp")) return "mp4";
            if (b.Length > 4 && b[0] == 0x1A && b[1] == 0x45 && b[2] == 0xDF && b[3] == 0xA3) return "webm";
            if (Str(0, "OggS")) return "ogg";
            if (b.Length > 12 && Str(0, "RIFF") && Str(8, "WAVE")) return "wav";
            if (Str(0, "ID3") || (b.Length > 2 && b[0] == 0xFF && (b[1] & 0xE0) == 0xE0)) return "mp3";
            if (b.Length > 4 && b[0] == 0x89 && b[1] == (byte)'P' && b[2] == (byte)'N' && b[3] == (byte)'G') return "png";
            if (b.Length > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "jpg";
            if (Str(0, "GIF8")) return "gif";
            if (b.Length > 12 && Str(0, "RIFF") && Str(8, "WEBP")) return "webp";
            return null;
        }

        /// <summary>File name for a downloaded hub image: the hub name as a safe stem + the real extension.</summary>
        public static string BackgroundFileName(string name, string ext)
        {
            var stem = new System.Text.StringBuilder();
            foreach (char c in name) stem.Append(char.IsLetterOrDigit(c) || c == '-' || c == '_' || c == ' ' ? c : '_');
            string s = stem.ToString().Trim().TrimStart('.');
            if (s.Length > 60) s = s.Substring(0, 60);
            if (s.Length == 0) s = "background";
            return s + "." + ext;
        }

        private static string UniqueName(string dir, string name)
        {
            string stem = Path.GetFileNameWithoutExtension(name), ext = Path.GetExtension(name);
            string candidate = name;
            for (int n = 2; File.Exists(Path.Combine(dir, candidate)); n++) candidate = stem + "-" + n + ext;
            return candidate;
        }

        private static string SafeFileName(string name)
        {
            var sb = new System.Text.StringBuilder();
            foreach (char c in name) sb.Append(c < ' ' || "\\/:*?\"<>|".IndexOf(c) >= 0 ? '_' : c);
            return sb.ToString();
        }

        /// <summary>
        /// extract_playlist_zip_mapped: entries are flattened to their file name (so no path can escape), dot files are skipped, only
        /// pictures, videos and sounds under the per-type size caps are kept (at most 50), and poster sidecars of videos
        /// (image-sniffed, 2 MB) are kept beside their video and don't count as items. Returns how many files were saved.
        /// </summary>
        private static int ExtractPlaylist(Stream source, string dir)
        {
            using ZipArchive zip = FolderStore.OpenZip(source);
            var posters = new Dictionary<string, byte[]>(StringComparer.Ordinal);
            var files = new List<(string Base, byte[] Data)>();
            foreach (ZipArchiveEntry entry in zip.Entries)
            {
                string full = entry.FullName.Replace('\\', '/');
                if (full.EndsWith("/", StringComparison.Ordinal)) continue;
                string baseName = SafeFileName(full.Substring(full.LastIndexOf('/') + 1));
                if (baseName.Length == 0 || baseName.StartsWith(".", StringComparison.Ordinal)) continue;
                if (IsPosterName(baseName))
                {
                    if (posters.Count < MaxPlaylistFiles && entry.Length <= MaxPosterBytes)
                    {
                        byte[] p = ReadCapped(entry, MaxPosterBytes);
                        if (p.Length <= MaxPosterBytes && PosterExt(p) != null) posters[baseName.ToLowerInvariant()] = p;
                    }
                    continue;
                }
                if (files.Count >= MaxPlaylistFiles || MediaKind(baseName) == null) continue;
                long cap = CapFor(baseName);
                if (entry.Length > cap) continue;
                byte[] data = ReadCapped(entry, cap);
                if (data.Length > cap) continue;
                files.Add((baseName, data));
            }
            foreach (var (baseName, data) in files)
            {
                string saved = UniqueName(dir, baseName);
                File.WriteAllBytes(Path.Combine(dir, saved), data);
                if (MediaKind(saved) == "video")
                {
                    foreach (string ext in new[] { "jpg", "png" })
                        if (posters.TryGetValue((baseName + ".poster." + ext).ToLowerInvariant(), out byte[]? pb))
                        {
                            File.WriteAllBytes(Path.Combine(dir, saved + ".poster." + (PosterExt(pb) ?? ext)), pb);
                            break;
                        }
                }
            }
            return files.Count;
        }

        private static byte[] ReadCapped(ZipArchiveEntry entry, long cap)
        {
            using Stream s = entry.Open();
            using var memory = new MemoryStream();
            var buffer = new byte[81920];
            int read;
            while ((read = s.Read(buffer, 0, buffer.Length)) > 0)
            {
                memory.Write(buffer, 0, read);
                if (memory.Length > cap) break; // the caller sees length > cap and skips the entry
            }
            return memory.ToArray();
        }
    }
}

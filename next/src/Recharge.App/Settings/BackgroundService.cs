using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using Recharge.App.Library;
using Recharge.App.Scheme;

namespace Recharge.App.Settings
{
    /// <summary>One picture or video of a background or playlist.</summary>
    public sealed class MediaEntry
    {
        public string File { get; set; } = "";
        /// <summary>"image" or "video".</summary>
        public string Kind { get; set; } = "image";
        /// <summary>A still shown before a video plays (a sidecar picture), or null.</summary>
        public string? Poster { get; set; }
    }

    public sealed class BackgroundRow
    {
        public string Folder { get; set; } = "";
        public string Name { get; set; } = "";
        public string? HubId { get; set; }
        public MediaEntry? Media { get; set; }
    }

    public sealed class PlaylistRow
    {
        public string Folder { get; set; } = "";
        public string Name { get; set; } = "";
        public string? HubId { get; set; }
        /// <summary>A playlist the user built (editable); false for one installed from the hub.</summary>
        public bool Own { get; set; }
        public List<MediaEntry> Items { get; set; } = new List<MediaEntry>();
    }

    /// <summary>
    /// The backgrounds the app can show, and the user's own playlists. Layout under [data]/backgrounds:
    ///   backgrounds/[slug]/  one picture or video (+ an optional poster)
    ///   playlists/[slug]/    pictures and videos (+ posters), and for the user's own playlists playlist.json {"order":[files]}
    /// Files are always copied in, never linked, so removing the original loses nothing.
    /// </summary>
    public sealed class BackgroundService
    {
        public const string OrderFile = "playlist.json";
        public const long MaxImageBytes = 40L * 1024 * 1024;
        public const long MaxVideoBytes = 500L * 1024 * 1024;
        public const int MaxItems = 100;

        private readonly string _data;

        public BackgroundService(string dataDir) => _data = dataDir;

        public string Root(string kind) => Path.Combine(_data, "backgrounds", kind);

        // ---- reading ----

        public List<BackgroundRow> Backgrounds()
        {
            var rows = new List<BackgroundRow>();
            foreach (string dir in FolderStore.Folders(Root("backgrounds")))
            {
                ContentInstaller.Meta? meta = ContentInstaller.ReadMeta(dir);
                List<MediaEntry> media = MediaIn(dir, true);
                // A video background may ship a poster picture: the video wins, and its poster is not an item of its own.
                MediaEntry? main = media.FirstOrDefault(m => m.Kind == "video") ?? media.FirstOrDefault();
                rows.Add(new BackgroundRow
                {
                    Folder = Path.GetFileName(dir),
                    Name = string.IsNullOrEmpty(meta?.Name) ? Path.GetFileName(dir) : meta!.Name!,
                    HubId = meta?.Id,
                    Media = main,
                });
            }
            return rows;
        }

        public List<PlaylistRow> Playlists()
        {
            var rows = new List<PlaylistRow>();
            foreach (string dir in FolderStore.Folders(Root("playlists")))
            {
                ContentInstaller.Meta? meta = ContentInstaller.ReadMeta(dir);
                rows.Add(new PlaylistRow
                {
                    Folder = Path.GetFileName(dir),
                    Name = string.IsNullOrEmpty(meta?.Name) ? Path.GetFileName(dir) : meta!.Name!,
                    HubId = meta?.Id,
                    Own = meta != null && meta.Id == null,
                    Items = Ordered(dir, MediaIn(dir)),
                });
            }
            return rows;
        }

        /// <summary>The pictures and videos in a folder (name order). A picture used as a video's poster isn't an item.</summary>
        public static List<MediaEntry> MediaIn(string dir, bool loosePoster = false)
        {
            var files = Directory.EnumerateFiles(dir).Select(Path.GetFileName).Where(f => f != null && !f!.StartsWith(".", StringComparison.Ordinal))
                .Select(f => f!).OrderBy(f => f, StringComparer.Ordinal).ToList();
            var posterOf = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (string f in files)
            {
                string lower = f.ToLowerInvariant();
                if (!lower.EndsWith(".poster.jpg", StringComparison.Ordinal) && !lower.EndsWith(".poster.png", StringComparison.Ordinal)) continue;
                string owner = f.Substring(0, f.Length - ".poster.jpg".Length);
                posterOf[owner] = f;
            }
            var items = new List<MediaEntry>();
            foreach (string f in files)
            {
                if (posterOf.ContainsValue(f)) continue;
                string? kind = ContentInstaller.MediaKind(f);
                if (kind != "image" && kind != "video") continue;
                items.Add(new MediaEntry { File = f, Kind = kind, Poster = kind == "video" && posterOf.TryGetValue(f, out string? p) ? p : null });
            }
            // A video that ships a loose poster picture of another name (a hub background): use the one unused picture.
            if (loosePoster)
            {
                MediaEntry[] pictures = items.Where(i => i.Kind == "image").ToArray();
                MediaEntry[] videos = items.Where(i => i.Kind == "video" && i.Poster == null).ToArray();
                if (pictures.Length == 1 && videos.Length == 1 && items.Count(i => i.Kind == "video") == 1)
                {
                    MediaEntry video = videos[0];
                    video.Poster = pictures[0].File;
                    items.Remove(pictures[0]);
                }
            }
            return items;
        }

        private static List<MediaEntry> Ordered(string dir, List<MediaEntry> media)
        {
            string[] order = ReadOrder(dir);
            var result = new List<MediaEntry>();
            foreach (string f in order)
            {
                MediaEntry? m = media.FirstOrDefault(x => x.File == f);
                if (m != null && !result.Contains(m)) result.Add(m);
            }
            result.AddRange(media.Where(m => !result.Contains(m)));
            return result;
        }

        public static string[] ReadOrder(string dir)
        {
            try
            {
                string file = Path.Combine(dir, OrderFile);
                if (!File.Exists(file)) return new string[0];
                using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(file));
                if (!doc.RootElement.TryGetProperty("order", out JsonElement order) || order.ValueKind != JsonValueKind.Array) return new string[0];
                return order.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).ToArray();
            }
            catch (Exception e) when (e is IOException || e is JsonException || e is UnauthorizedAccessException)
            {
                return new string[0];
            }
        }

        // ---- the user's own playlists ----

        /// <summary>Makes an empty playlist and returns its folder name.</summary>
        public string CreatePlaylist(string name)
        {
            string clean = (name ?? "").Trim();
            if (clean.Length == 0) throw new ArgumentException("Give the playlist a name.");
            if (clean.Length > 60) clean = clean.Substring(0, 60);
            string root = Root("playlists");
            Directory.CreateDirectory(root);
            string slug = Slug(clean), folder = slug;
            for (int n = 2; Directory.Exists(Path.Combine(root, folder)); n++) folder = slug + "-" + n;
            string dir = Path.Combine(root, folder);
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, ContentInstaller.MetaFile), JsonSerializer.Serialize(new { name = clean, own = true }));
            WriteOrder(dir, new string[0]);
            return folder;
        }

        /// <summary>Copies one of the user's own pictures or videos into one of their playlists; returns the saved file name.</summary>
        public string AddFile(string playlist, string sourcePath)
        {
            string dir = OwnPlaylistDir(playlist);
            if (string.IsNullOrWhiteSpace(sourcePath) || !Path.IsPathRooted(sourcePath)) throw new ArgumentException("Choose a file.");
            var info = new FileInfo(sourcePath);
            if (!info.Exists) throw new FileNotFoundException("That file doesn't exist.");
            string saved = CopyIn(info, dir);
            List<string> order = ReadOrder(dir).ToList();
            order.Add(saved);
            WriteOrder(dir, order);
            return saved;
        }

        /// <summary>Copies the media of an installed background into one of the user's playlists.</summary>
        public string AddInstalled(string playlist, string backgroundFolder)
        {
            string dir = OwnPlaylistDir(playlist);
            if (!MapPathResolver.IsPlainName(backgroundFolder)) throw new ArgumentException("not a background folder name");
            string src = Path.Combine(Root("backgrounds"), backgroundFolder);
            MediaEntry media = (Directory.Exists(src) ? MediaIn(src, true).FirstOrDefault(m => m.Kind == "video") ?? MediaIn(src, true).FirstOrDefault() : null)
                ?? throw new FileNotFoundException("That background isn't installed.");
            string saved = CopyIn(new FileInfo(Path.Combine(src, media.File)), dir);
            if (media.Poster != null)
            {
                string ext = Path.GetExtension(media.Poster);
                File.Copy(Path.Combine(src, media.Poster), Path.Combine(dir, saved + ".poster" + (ext.Length > 0 ? ext : ".jpg")), true);
            }
            List<string> order = ReadOrder(dir).ToList();
            order.Add(saved);
            WriteOrder(dir, order);
            return saved;
        }

        /// <summary>Saves the order of the files (and deletes the files that were taken out of the list).</summary>
        public void SaveOrder(string playlist, IReadOnlyList<string> files)
        {
            string dir = OwnPlaylistDir(playlist);
            List<MediaEntry> media = MediaIn(dir);
            var keep = new List<string>();
            foreach (string f in files)
                if (media.Any(m => m.File == f) && !keep.Contains(f)) keep.Add(f);
            foreach (MediaEntry m in media)
            {
                if (keep.Contains(m.File)) continue;
                TryDelete(Path.Combine(dir, m.File));
                if (m.Poster != null) TryDelete(Path.Combine(dir, m.Poster));
            }
            WriteOrder(dir, keep);
        }

        public void RenamePlaylist(string playlist, string name)
        {
            string dir = OwnPlaylistDir(playlist);
            string clean = (name ?? "").Trim();
            if (clean.Length == 0 || clean.Length > 60) throw new ArgumentException("The name must be 1 to 60 characters.");
            File.WriteAllText(Path.Combine(dir, ContentInstaller.MetaFile), JsonSerializer.Serialize(new { name = clean, own = true }));
        }

        public void DeletePlaylist(string playlist)
        {
            Directory.Delete(OwnPlaylistDir(playlist), true);
        }

        /// <summary>Copies one of the user's own pictures or videos in as a background of its own.</summary>
        public string ImportBackground(string sourcePath, string? name)
        {
            if (string.IsNullOrWhiteSpace(sourcePath) || !Path.IsPathRooted(sourcePath)) throw new ArgumentException("Choose a file.");
            var info = new FileInfo(sourcePath);
            if (!info.Exists) throw new FileNotFoundException("That file doesn't exist.");
            string display = string.IsNullOrWhiteSpace(name) ? Path.GetFileNameWithoutExtension(info.Name) : name!.Trim();
            if (display.Length > 60) display = display.Substring(0, 60);
            string root = Root("backgrounds");
            Directory.CreateDirectory(root);
            string slug = Slug(display), folder = slug;
            for (int n = 2; Directory.Exists(Path.Combine(root, folder)); n++) folder = slug + "-" + n;
            string dir = Path.Combine(root, folder);
            Directory.CreateDirectory(dir);
            try
            {
                CopyIn(info, dir);
                File.WriteAllText(Path.Combine(dir, ContentInstaller.MetaFile), JsonSerializer.Serialize(new { name = display, own = true }));
            }
            catch
            {
                try { Directory.Delete(dir, true); } catch (IOException) { }
                throw;
            }
            return folder;
        }

        // ---- helpers ----

        private string OwnPlaylistDir(string playlist)
        {
            if (!MapPathResolver.IsPlainName(playlist ?? "")) throw new ArgumentException("not a playlist folder name");
            string dir = Path.Combine(Root("playlists"), playlist!);
            if (!Directory.Exists(dir)) throw new FileNotFoundException("That playlist doesn't exist.");
            ContentInstaller.Meta? meta = ContentInstaller.ReadMeta(dir);
            if (meta == null || meta.Id != null) throw new InvalidOperationException("That playlist came from the Library; only your own playlists can be changed.");
            return dir;
        }

        private static string CopyIn(FileInfo source, string dir)
        {
            string? kind = ContentInstaller.MediaKind(source.Name);
            if (kind != "image" && kind != "video") throw new ArgumentException("Use a picture (png, jpg, webp, gif) or a video (mp4, webm).");
            long cap = kind == "video" ? MaxVideoBytes : MaxImageBytes;
            if (source.Length > cap) throw new InvalidOperationException("That file is too big (over " + cap / (1024 * 1024) + " MB).");
            if (MediaIn(dir).Count >= MaxItems) throw new InvalidOperationException("A playlist holds at most " + MaxItems + " items.");
            // The bytes must match the extension, so a renamed file can't end up in the folder.
            byte[] head = new byte[32];
            int got;
            using (var fs = source.OpenRead()) got = fs.Read(head, 0, head.Length);
            Array.Resize(ref head, got);
            string? sniffed = ContentInstaller.SniffExt(head);
            string? sniffedKind = sniffed == null ? null : ContentInstaller.MediaKind("x." + sniffed);
            if (sniffedKind != kind) throw new ArgumentException("That file isn't really a " + kind + ".");
            string stem = Slug(Path.GetFileNameWithoutExtension(source.Name));
            string ext = Path.GetExtension(source.Name).ToLowerInvariant();
            string name = stem + ext;
            for (int n = 2; File.Exists(Path.Combine(dir, name)); n++) name = stem + "-" + n + ext;
            source.CopyTo(Path.Combine(dir, name), false);
            return name;
        }

        private static void WriteOrder(string dir, IEnumerable<string> order)
        {
            string file = Path.Combine(dir, OrderFile);
            string temp = file + "." + Environment.ProcessId + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(new { order = order.ToArray() }));
            File.Move(temp, file, true);
        }

        private static void TryDelete(string path)
        {
            try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }

        public static string Slug(string name)
        {
            var sb = new StringBuilder();
            bool dash = false;
            foreach (char c in name.ToLowerInvariant())
            {
                if (char.IsLetterOrDigit(c)) { sb.Append(c); dash = false; }
                else if (!dash && sb.Length > 0) { sb.Append('-'); dash = true; }
            }
            string s = sb.ToString().Trim('-');
            if (s.Length > 48) s = s.Substring(0, 48).Trim('-');
            return s.Length == 0 ? "item" : s;
        }
    }
}

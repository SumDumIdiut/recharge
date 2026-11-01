using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;

namespace Recharge.App.Library
{
    /// <summary>
    /// The folder mechanics every hub install shares (maps, mods, skins, backgrounds, playlists): slugs, unique folder names,
    /// backups that keep the last few, safe extraction. No kind-specific rules live here.
    /// </summary>
    public static class FolderStore
    {
        public const int BackupsKept = 3;

        /// <summary>The same slug rule as hub.rs slugify: lowercase ASCII letters and digits, runs of anything else become one dash.</summary>
        public static string Slugify(string name)
        {
            var sb = new System.Text.StringBuilder(name.Length);
            bool dash = false;
            foreach (char raw in name)
            {
                char c = raw < 128 ? char.ToLowerInvariant(raw) : raw;
                if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) { sb.Append(c); dash = false; }
                else if (!dash && sb.Length > 0) { sb.Append('-'); dash = true; }
            }
            while (sb.Length > 0 && sb[sb.Length - 1] == '-') sb.Length--;
            return sb.ToString();
        }

        public static bool SafeId(string id) => id.Length > 0 && id.Length <= 64 && id.All(c => char.IsAsciiLetterOrDigit(c) || c == '-' || c == '_');

        /// <summary>A folder path under root nothing lives at yet: the slug, else slug-hubid8, else with a counter.</summary>
        public static string NewFolder(string root, string name, string hubId)
        {
            string slug = Slugify(name);
            if (slug.Length == 0) slug = hubId;
            string t = Path.Combine(root, slug);
            if (!Directory.Exists(t) && !File.Exists(t)) return t;
            string withId = slug + "-" + hubId.Substring(0, Math.Min(8, hubId.Length));
            t = Path.Combine(root, withId);
            for (int n = 2; Directory.Exists(t) || File.Exists(t); n++) t = Path.Combine(root, withId + "-" + n);
            return t;
        }

        /// <summary>Visible sub-folders of root, in a stable order. Empty when root doesn't exist.</summary>
        public static List<string> Folders(string root)
        {
            if (!Directory.Exists(root)) return new List<string>();
            return Directory.GetDirectories(root)
                .Where(d => !Path.GetFileName(d).StartsWith(".", StringComparison.Ordinal))
                .OrderBy(d => d, StringComparer.Ordinal).ToList();
        }

        /// <summary>A scratch folder beside the target, so the final move stays on one filesystem.</summary>
        public static string NewScratch(string root) =>
            Path.Combine(root, ".rn-tmp-" + Environment.ProcessId + "-" + Guid.NewGuid().ToString("N").Substring(0, 8));

        /// <summary>Moves a folder into the backup store (copying when it's on another drive) and trims old backups. Returns where it went.</summary>
        public static string Backup(string folder, string backupDir, Func<DateTime> now, string? label = null)
        {
            string name = label ?? Path.GetFileName(folder);
            Directory.CreateDirectory(backupDir);
            string stamp = now().ToString("yyyyMMdd-HHmmss");
            string dest = Path.Combine(backupDir, name + "-" + stamp);
            for (int n = 2; Directory.Exists(dest); n++) dest = Path.Combine(backupDir, name + "-" + stamp + "-" + n);
            try
            {
                Directory.Move(folder, dest);
            }
            catch (IOException)
            {
                CopyDirectory(folder, dest); // a different filesystem: copy, then remove the original
                Directory.Delete(folder, true);
            }
            var old = Directory.GetDirectories(backupDir, name + "-*")
                .Where(d => IsBackupOf(Path.GetFileName(d), name))
                .OrderByDescending(d => Path.GetFileName(d), StringComparer.Ordinal).Skip(BackupsKept);
            foreach (string d in old) TryDelete(d);
            return dest;
        }

        private static bool IsBackupOf(string backupName, string folder)
        {
            string rest = backupName.Substring(folder.Length + 1);
            return rest.Length >= 15 && char.IsDigit(rest[0]) && rest[8] == '-';
        }

        public static ZipArchive OpenZip(Stream package)
        {
            try { return new ZipArchive(package, ZipArchiveMode.Read, true); }
            catch (InvalidDataException e) { throw new InvalidOperationException("not a valid package: " + e.Message); }
        }

        public const long MaxUnpackedBytes = 2L * 1024 * 1024 * 1024;

        /// <summary>Extracts every entry under root, refusing absolute paths, anything that would land outside it (zip slip) and zip bombs.</summary>
        public static void ExtractSafely(ZipArchive zip, string root, long maxUnpacked = MaxUnpackedBytes)
        {
            string full = Path.GetFullPath(root) + Path.DirectorySeparatorChar;
            long total = 0;
            foreach (ZipArchiveEntry entry in zip.Entries)
            {
                total += entry.Length;
                if (total > maxUnpacked) throw new InvalidOperationException("the package unpacks to more than " + maxUnpacked / (1024 * 1024) + " MB");
                string rel = entry.FullName.Replace('\\', '/');
                if (rel.Length == 0) continue;
                if (rel.StartsWith("/", StringComparison.Ordinal) || rel.Contains(':'))
                    throw new InvalidOperationException("the package has an unsafe path: " + entry.FullName);
                string dest = Path.GetFullPath(Path.Combine(root, rel));
                if (!dest.StartsWith(full, StringComparison.Ordinal))
                    throw new InvalidOperationException("the package has an unsafe path: " + entry.FullName);
                if (rel.EndsWith("/", StringComparison.Ordinal)) { Directory.CreateDirectory(dest); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                entry.ExtractToFile(dest, false);
            }
        }

        public static void CopyDirectory(string from, string to)
        {
            Directory.CreateDirectory(to);
            foreach (string f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)));
            foreach (string d in Directory.GetDirectories(from)) CopyDirectory(d, Path.Combine(to, Path.GetFileName(d)));
        }

        public static void TryDelete(string dir)
        {
            try { if (Directory.Exists(dir)) Directory.Delete(dir, true); } catch { /* best effort */ }
        }
    }
}

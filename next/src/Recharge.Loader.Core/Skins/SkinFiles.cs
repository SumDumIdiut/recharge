using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Recharge.Core.Json;

namespace Recharge.Loader.Core.Skins
{
    public enum IndicatorKind { Dash, DoubleJump }

    /// <summary>One skin folder with a usable player image.</summary>
    public sealed class SkinFolder
    {
        public SkinFolder(string folderName, string displayName, string imagePath)
        {
            FolderName = folderName;
            DisplayName = displayName;
            ImagePath = imagePath;
        }

        public string FolderName { get; }
        public string DisplayName { get; }
        public string ImagePath { get; }
    }

    /// <summary>
    /// What is in a skin folder: the player image plus optional dash / double-jump indicator images,
    /// which must never be mistaken for the player image (ported from SkinMod's SkinFiles).
    /// </summary>
    public static class SkinFiles
    {
        public const string HubMetaFile = ".recharge-hub-meta.json";

        private static readonly string[] ImageExtensions = { ".png", ".jpg", ".jpeg" };
        private static readonly string[] DashNames = { "dash" };
        private static readonly string[] DoubleJumpNames = { "doublejump", "double-jump", "double_jump", "jump" };

        private static bool IsImage(string path) =>
            ImageExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);

        private static string[] NamesFor(IndicatorKind kind) => kind == IndicatorKind.Dash ? DashNames : DoubleJumpNames;

        private static bool IsIndicatorImage(string path)
        {
            var stem = Path.GetFileNameWithoutExtension(path);
            return DashNames.Concat(DoubleJumpNames).Contains(stem, StringComparer.OrdinalIgnoreCase);
        }

        public static string? FindPlayerImage(string folder) =>
            Directory.EnumerateFiles(folder).OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault(f => IsImage(f) && !IsIndicatorImage(f));

        public static string? FindIndicatorImage(string folder, IndicatorKind kind)
        {
            var names = NamesFor(kind);
            return Directory.EnumerateFiles(folder).OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault(f => IsImage(f) && names.Contains(Path.GetFileNameWithoutExtension(f), StringComparer.OrdinalIgnoreCase));
        }

        /// <summary>
        /// Skins downloaded by the app live in a slugged folder ("Colon (:)" becomes "colon"); the name they were
        /// published under is kept in a meta file next to them. Null when there is none or it is unreadable.
        /// </summary>
        public static string? ReadDisplayName(string folder)
        {
            try
            {
                var path = Path.Combine(folder, HubMetaFile);
                if (!File.Exists(path)) return null;
                if (!(JsonReader.Parse(File.ReadAllText(path)) is JsonObject o)) return null;
                if (!o.TryGetValue("name", out var n) || !(n is JsonString s)) return null;
                return string.IsNullOrWhiteSpace(s.Value) ? null : s.Value.Trim();
            }
            catch (Exception)
            {
                return null; // unreadable meta: fall back to the folder name
            }
        }

        /// <summary>
        /// The skins in a skins directory that have a player image, ordered by display name then path, as the
        /// pause menu lists them. Folders without an image are reported through <paramref name="skipped"/>.
        /// </summary>
        public static List<SkinFolder> List(string skinsDir, Action<string>? skipped = null)
        {
            var found = new List<(string path, string display)>();
            foreach (var folder in Directory.EnumerateDirectories(skinsDir))
                found.Add((folder, ReadDisplayName(folder) ?? Path.GetFileName(folder)));
            var result = new List<SkinFolder>();
            foreach (var (path, display) in found
                .OrderBy(f => f.display, StringComparer.OrdinalIgnoreCase)
                .ThenBy(f => f.path, StringComparer.OrdinalIgnoreCase))
            {
                var image = FindPlayerImage(path);
                var name = Path.GetFileName(path);
                if (image == null)
                {
                    skipped?.Invoke(name);
                    continue;
                }
                result.Add(new SkinFolder(name, display, image));
            }
            return result;
        }

        /// <summary>The index in <paramref name="skins"/> of the named folder (exact match), or -1.</summary>
        public static int IndexOf(IReadOnlyList<SkinFolder> skins, string? folder)
        {
            if (folder == null) return -1;
            for (int i = 0; i < skins.Count; i++)
                if (skins[i].FolderName == folder) return i;
            return -1;
        }
    }
}

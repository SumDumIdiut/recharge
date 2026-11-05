using System;
using System.IO;
using Recharge.Core.Json;

namespace Recharge.App.Library
{
    /// <summary>
    /// Remembers the last installed-content scan. A repeat library.installed answers it again when nothing it read has changed: the
    /// folders it lists (mods, maps, skins, backgrounds, playlists) and the small files it parses (mod.json, hub.json, map.json,
    /// the hub meta file) are compared by modified time and size, which costs a few stats instead of parsing every file. Every
    /// command that changes what is installed also calls <see cref="Invalidate"/>, so a change is never served late even on a
    /// filesystem with coarse timestamps.
    /// </summary>
    public static class InstalledCache
    {
        private static readonly object Lock = new object();
        private static string? _key;
        private static long _signature;
        private static JsonObject? _value;
        private static int _hits;

        /// <summary>How many calls were answered from the memo (for tests).</summary>
        public static int Hits { get { lock (Lock) return _hits; } }

        public static void Invalidate()
        {
            lock (Lock) { _value = null; _key = null; }
        }

        /// <summary>The memoised scan for <paramref name="key"/> (game folder + data folder) when its signature still matches; otherwise runs <paramref name="scan"/>.</summary>
        public static JsonObject Get(string key, string[] roots, Func<JsonObject> scan)
        {
            long signature = Signature(roots);
            lock (Lock)
            {
                if (_value != null && _key == key && _signature == signature)
                {
                    _hits++;
                    return _value;
                }
            }
            JsonObject fresh = scan();
            // sign again after the scan: a change made while it ran leaves the stored signature stale, so the next call rescans
            lock (Lock) { _value = fresh; _key = key; _signature = signature; }
            return fresh;
        }

        private static readonly string[] Watched = { "mod.json", ContentInstaller.MetaFile, "hub.json", "map.json" };

        /// <summary>A hash of the roots, their child folders, and the watched files in those folders (modified time and size).</summary>
        public static long Signature(string[] roots)
        {
            long h = 1469598103934665603L;
            foreach (string root in roots)
            {
                h = Mix(h, root);
                if (!Directory.Exists(root)) { h = Mix(h, -1); continue; }
                h = Mix(h, Directory.GetLastWriteTimeUtc(root).Ticks);
                string[] children;
                try { children = Directory.GetDirectories(root); }
                catch (Exception) { h = Mix(h, -2); continue; }
                Array.Sort(children, StringComparer.Ordinal);
                foreach (string dir in children)
                {
                    h = Mix(h, dir);
                    h = Mix(h, Directory.GetLastWriteTimeUtc(dir).Ticks);
                    foreach (string name in Watched)
                    {
                        var info = new FileInfo(Path.Combine(dir, name));
                        if (!info.Exists) { h = Mix(h, 0); continue; }
                        h = Mix(h, info.LastWriteTimeUtc.Ticks);
                        h = Mix(h, info.Length);
                    }
                }
            }
            return h;
        }

        private static long Mix(long h, long v) => unchecked((h ^ v) * 1099511628211L);

        private static long Mix(long h, string s)
        {
            foreach (char c in s) h = Mix(h, c);
            return h;
        }
    }
}

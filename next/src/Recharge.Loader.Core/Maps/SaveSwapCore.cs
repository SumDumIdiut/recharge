#nullable disable
using System;
using System.IO;

namespace Recharge.Loader.Core.Maps
{
    /// <summary>
    /// The file side of map saves, Unity-free. The game only loads /Savedata (and /Savedatabackup) as a scene starts,
    /// so a map's save is loaded the game's own way: the real folders are set aside, the map's save is copied in
    /// their place, and the real folders go back. Crash-safe with no bookkeeping: a set-aside folder is always
    /// "&lt;name&gt;.navigator-hold", and anything copied in carries a marker file.
    /// </summary>
    public sealed class SaveSwapCore
    {
        public const string Game = "/Savedata";
        public const string GameBackup = "/Savedatabackup";
        public const string HoldSuffix = ".navigator-hold";
        public const string Marker = "/navigator-swapped";

        // Older versions set these aside too; SwapOut still returns them.
        private static readonly string[] LegacyHeld = { "/Savedatahard", "/Savedatahardbackup" };

        private readonly string _root;
        private readonly Action<string> _log;
        private readonly Action<string> _error;
        private readonly Action<string> _warn;

        /// <param name="root">The persistent data path the folders hang off.</param>
        public SaveSwapCore(string root, Action<string> log = null, Action<string> error = null, Action<string> warn = null)
        {
            _root = root ?? throw new ArgumentNullException(nameof(root));
            _log = log ?? (_ => { });
            _error = error ?? (_ => { });
            _warn = warn ?? (_ => { });
        }

        public string Full(string folder) => _root + folder;

        public bool HasSave(string folder) => File.Exists(Full(folder) + "/playerdata.txt");

        public bool IsSwapped => Directory.Exists(Full(Game) + HoldSuffix) || File.Exists(Full(Game) + Marker);

        public string Describe(string folder)
        {
            try
            {
                var dir = Full(folder);
                if (!Directory.Exists(dir)) return folder + ": missing";
                var courses = Directory.GetFiles(dir, "course*data.txt").Length;
                return folder + ": playerdata " + (File.Exists(dir + "/playerdata.txt") ? "yes" : "no") + ", " + courses + " course files" + (File.Exists(dir + Marker) ? ", swapped copy" : "");
            }
            catch (Exception e) { return folder + ": " + e.Message; }
        }

        /// <summary>Puts the map save in <paramref name="folder"/> (and folder+"backup") where the game loads from. Null means a brand-new game.</summary>
        public void SwapIn(string folder)
        {
            SwapOut();
            Hold(Game);
            Hold(GameBackup);
            Place(folder, Game);
            Place(folder != null ? folder + "backup" : null, GameBackup);
            _log("save swapped in: " + (folder != null && HasSave(folder) ? folder : "a new game"));
        }

        /// <summary>Puts the real save back, whatever state a swap (or a crash mid-swap) left.</summary>
        public void SwapOut()
        {
            var any = false;
            foreach (var name in new[] { Game, GameBackup })
            {
                var dir = Full(name);
                try
                {
                    var held = Directory.Exists(dir + HoldSuffix);
                    if (Directory.Exists(dir) && (held || File.Exists(dir + Marker))) { Directory.Delete(dir, true); any = true; }
                    if (held) { Directory.Move(dir + HoldSuffix, dir); any = true; }
                }
                catch (Exception e) { _error("couldn't put " + name + " back: " + e.Message); }
            }
            foreach (var name in LegacyHeld)
            {
                var dir = Full(name);
                try
                {
                    if (!Directory.Exists(dir + HoldSuffix)) continue;
                    if (Directory.Exists(dir)) Directory.Delete(dir, true);
                    Directory.Move(dir + HoldSuffix, dir);
                    any = true;
                }
                catch (Exception e) { _error("couldn't put " + name + " back: " + e.Message); }
            }
            if (any) _log("real save back in place");
        }

        public void CopyFolder(string from, string to)
        {
            var src = Full(from);
            if (!Directory.Exists(src)) return;
            var dst = Full(to);
            Directory.CreateDirectory(dst);
            foreach (var file in Directory.GetFiles(src))
            {
                var name = Path.GetFileName(file);
                if ("/" + name == Marker) continue;
                File.Copy(file, Path.Combine(dst, name), true);
            }
        }

        public void DeleteFolder(string folder)
        {
            try { if (Directory.Exists(Full(folder))) Directory.Delete(Full(folder), true); }
            catch (Exception e) { _warn("couldn't delete " + folder + ": " + e.Message); }
        }

        private void Hold(string name)
        {
            var dir = Full(name);
            if (Directory.Exists(dir)) Directory.Move(dir, dir + HoldSuffix);
        }

        private void Place(string from, string name)
        {
            CopyFolder(from, name);
            Directory.CreateDirectory(Full(name));
            File.WriteAllText(Full(name) + Marker, "");
        }
    }
}

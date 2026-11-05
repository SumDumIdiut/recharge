using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Recharge.App.Library
{
    /// <summary>
    /// Is IGTAP running? Read-only: scans /proc command lines the way the current app does (play.rs matching_game_pids), so
    /// content isn't replaced under a running game. Viewers and shells that merely mention the file are not the game.
    /// </summary>
    public static class GameProcess
    {
        private static readonly HashSet<string> NotGame = new HashSet<string>(StringComparer.Ordinal)
        {
            "vim", "nvim", "vi", "nano", "less", "more", "cat", "grep", "rg", "pgrep", "pkill", "ls", "tail", "head", "stat", "file", "cp", "mv", "rm",
            "code", "kate", "gedit", "xdg-open", "sh", "bash", "zsh", "fish", "node", "git", "strings", "sha256sum", "md5sum", "tar", "zip", "unzip",
        };

        /// <summary>The game's .exe in its folder (not the crash handler), or null.</summary>
        public static string? ExeName(string gameDir)
        {
            try
            {
                return Directory.GetFiles(gameDir, "*.exe")
                    .Select(Path.GetFileName)
                    .FirstOrDefault(n => n != null && !n.StartsWith("UnityCrashHandler", StringComparison.OrdinalIgnoreCase));
            }
            catch { return null; }
        }

        private static List<int> PidsWindows(string gameDir, string exe)
        {
            var found = new List<int>();
            string full = Path.GetFullPath(gameDir).TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
            foreach (var p in System.Diagnostics.Process.GetProcessesByName(Path.GetFileNameWithoutExtension(exe)))
            {
                try
                {
                    string? path = p.MainModule?.FileName;
                    if (path != null && path.StartsWith(full, StringComparison.OrdinalIgnoreCase)) found.Add(p.Id);
                }
                catch (Exception) { /* an elevated process we can't inspect */ }
                finally { p.Dispose(); }
            }
            return found;
        }

        /// <summary>
        /// The game's own processes for this game folder. A process counts only when it is the game's exe AND it runs from this
        /// folder (its working directory, or a path argument, is inside it): another copy of the game elsewhere (a test copy,
        /// a second install) is not this game.
        /// </summary>
        public static IReadOnlyList<int> Pids(string gameDir)
        {
            string? exe = ExeName(gameDir);
            if (exe == null) return Array.Empty<int>();
            if (OperatingSystem.IsWindows()) return PidsWindows(gameDir, exe);
            var found = new List<int>();
            if (!Directory.Exists("/proc")) return found;
            string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(gameDir));
            int self = Environment.ProcessId;
            foreach (string dir in Directory.GetDirectories("/proc"))
            {
                if (!int.TryParse(Path.GetFileName(dir), out int pid) || pid <= 1 || pid == self) continue;
                string[] args;
                try { args = File.ReadAllText(Path.Combine(dir, "cmdline")).Split('\0', StringSplitOptions.RemoveEmptyEntries); }
                catch { continue; }
                if (!Matches(args, exe)) continue;
                string? cwd = null;
                try { cwd = new DirectoryInfo(Path.Combine(dir, "cwd")).ResolveLinkTarget(false)?.FullName; } catch { /* not ours to read */ }
                if (BelongsTo(args, cwd, root)) found.Add(pid);
            }
            return found;
        }

        public static bool IsRunning(string gameDir) => Pids(gameDir).Count > 0;

        /// <summary>A matching command line is this game folder's when its working directory or one of its path arguments is inside the folder.</summary>
        public static bool BelongsTo(IReadOnlyList<string> args, string? cwd, string gameRoot)
        {
            string root = Path.TrimEndingDirectorySeparator(gameRoot);
            bool Inside(string? p) => !string.IsNullOrEmpty(p) &&
                (string.Equals(Path.TrimEndingDirectorySeparator(p!), root, StringComparison.Ordinal) || p!.StartsWith(root + "/", StringComparison.Ordinal));
            return Inside(cwd) || args.Any(a => a.StartsWith("/", StringComparison.Ordinal) && Inside(a));
        }

        /// <summary>Closes this game folder's game processes (only those, by PID). Returns how many were asked to stop.</summary>
        public static int Close(string gameDir)
        {
            int n = 0;
            foreach (int pid in Pids(gameDir))
            {
                try
                {
                    using var p = System.Diagnostics.Process.GetProcessById(pid);
                    p.Kill();
                    n++;
                }
                catch (Exception) { /* already gone */ }
            }
            return n;
        }

        /// <summary>A command line belongs to the game when one argument's file name is the game's exe (Windows or Unix separators).</summary>
        public static bool Matches(IReadOnlyList<string> args, string exeName)
        {
            if (args.Count == 0 || NotGame.Contains(BaseName(args[0]))) return false;
            string exe = exeName.ToLowerInvariant();
            return args.Any(a => BaseName(a) == exe);
        }

        private static string BaseName(string arg)
        {
            string a = arg.Replace('\\', '/');
            int slash = a.LastIndexOf('/');
            return (slash >= 0 ? a.Substring(slash + 1) : a).ToLowerInvariant();
        }
    }
}

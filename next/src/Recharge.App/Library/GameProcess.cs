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

        private static bool IsRunningWindows(string gameDir, string exe)
        {
            string full = Path.GetFullPath(gameDir).TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
            foreach (var p in System.Diagnostics.Process.GetProcessesByName(Path.GetFileNameWithoutExtension(exe)))
            {
                try
                {
                    string? path = p.MainModule?.FileName;
                    if (path != null && path.StartsWith(full, StringComparison.OrdinalIgnoreCase)) return true;
                }
                catch (Exception) { /* an elevated process we can't inspect */ }
                finally { p.Dispose(); }
            }
            return false;
        }

        public static bool IsRunning(string gameDir)
        {
            string? exe = ExeName(gameDir);
            if (exe == null) return false;
            if (OperatingSystem.IsWindows()) return IsRunningWindows(gameDir, exe);
            if (!Directory.Exists("/proc")) return false;
            int self = Environment.ProcessId;
            foreach (string dir in Directory.GetDirectories("/proc"))
            {
                if (!int.TryParse(Path.GetFileName(dir), out int pid) || pid <= 1 || pid == self) continue;
                string[] args;
                try { args = File.ReadAllText(Path.Combine(dir, "cmdline")).Split('\0', StringSplitOptions.RemoveEmptyEntries); }
                catch { continue; }
                if (Matches(args, exe)) return true;
            }
            return false;
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

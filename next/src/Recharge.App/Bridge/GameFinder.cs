using System;
using System.IO;

namespace Recharge.App.Bridge
{
    /// <summary>Finds the IGTAP installation in the Steam libraries.</summary>
    public static class GameFinder
    {
        public const string InstallName = "IGTAP an Incremental Game That's Also a Platformer";

        /// <summary>Set to a folder to use it as the game folder (tests and snapshots point this at a temp copy).</summary>
        public const string OverrideVariable = "RECHARGE_GAME_DIR";

        public static string? Find()
        {
            string? forced = Environment.GetEnvironmentVariable(OverrideVariable);
            if (!string.IsNullOrEmpty(forced))
            {
                return Directory.Exists(forced) ? forced : null;
            }
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string steamRoot = Path.Combine(home, ".local", "share", "Steam");
            if (OperatingSystem.IsWindows())
            {
                steamRoot = WindowsSteamRoot() ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Steam");
            }
            var roots = new System.Collections.Generic.List<string> { steamRoot };
            var seen = new System.Collections.Generic.HashSet<string>(StringComparer.Ordinal)
            {
                steamRoot,
            };

            string libraryFile = Path.Combine(steamRoot, "steamapps", "libraryfolders.vdf");
            if (File.Exists(libraryFile))
            {
                try
                {
                    foreach (string path in VdfPaths.Parse(File.ReadAllText(libraryFile)))
                    {
                        if (seen.Add(path))
                        {
                            roots.Add(path);
                        }
                    }
                }
                catch (IOException)
                {
                    // A broken library file should not stop the default lookup.
                }
                catch (UnauthorizedAccessException)
                {
                    // Same as above.
                }
            }

            foreach (string root in roots)
            {
                string candidate = Path.Combine(root, "steamapps", "common", InstallName);
                if (Directory.Exists(candidate))
                {
                    return candidate;
                }
            }

            return null;
        }

        /// <summary>The Steam install folder on Windows: HKCU\Software\Valve\Steam SteamPath, then HKLM (WOW6432Node) InstallPath.</summary>
        public static string? WindowsSteamRoot()
        {
            if (!OperatingSystem.IsWindows()) return null;
            try
            {
                using var user = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam");
                if (user?.GetValue("SteamPath") is string p && p.Length > 0 && Directory.Exists(p)) return Path.GetFullPath(p);
                using var machine = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\WOW6432Node\Valve\Steam");
                if (machine?.GetValue("InstallPath") is string q && q.Length > 0 && Directory.Exists(q)) return q;
            }
            catch (Exception ex) when (ex is System.Security.SecurityException || ex is UnauthorizedAccessException || ex is IOException)
            {
                // fall back to the default location
            }
            return null;
        }
    }
}

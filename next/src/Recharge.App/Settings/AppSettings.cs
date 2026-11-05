using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Recharge.App.Settings
{
    /// <summary>What Recharge Next remembers between runs (settings.json in the app-data folder).</summary>
    public sealed class AppSettings
    {
        /// <summary>A game folder the user chose; null means "use the detected one".</summary>
        public string? GamePath { get; set; }
        public bool SidebarCollapsed { get; set; }
        /// <summary>"auto" (Halloween while the hub's event runs, else Classic), "classic" or "halloween".</summary>
        public string Theme { get; set; } = "auto";
        /// <summary>
        /// True once the theme was picked in the Automatic / Classic / Halloween picker. Older files saved "classic" as a plain default,
        /// so without this a theme nobody chose would hide the Halloween event.
        /// </summary>
        public bool ThemePicked { get; set; }
        /// <summary>Folder name of an installed background (an image), or null for none.</summary>
        public string? Background { get; set; }
        /// <summary>What sits behind the app: "none", "background" (the folder in <see cref="Background"/>) or "playlist" (<see cref="BackgroundPlaylist"/>).</summary>
        public string? BackgroundSource { get; set; }
        /// <summary>Folder name of the playlist that rotates behind the app.</summary>
        public string? BackgroundPlaylist { get; set; }
        /// <summary>"cover", "contain" or "center" (centred at its own size).</summary>
        public string BgFit { get; set; } = "cover";
        /// <summary>"center", "top", "bottom", "left" or "right".</summary>
        public string BgPosition { get; set; } = "center";
        /// <summary>How dark the picture is made, 0 to 90 percent.</summary>
        public int BgDim { get; set; } = 35;
        /// <summary>Background strength (0 to 100): how much of the picture shows through the adaptive dim; 0 hides it, 100 is the most visible the app allows.</summary>
        public int BgStrength { get; set; } = 50;
        /// <summary>The colour the dimming layer uses (#rrggbb); null means black.</summary>
        public string? BgTint { get; set; }
        /// <summary>Blur in pixels, 0 to 24. Costly for the video decoder and the compositor: off by default.</summary>
        public int BgBlur { get; set; }
        /// <summary>Seconds each playlist item stays, 5 to 86400.</summary>
        public int BgInterval { get; set; } = 300;
        public bool BgShuffle { get; set; }
        /// <summary>Crossfade length in milliseconds, 0 to 5000.</summary>
        public int BgFadeMs { get; set; } = 1000;
        /// <summary>Pause a video while the window isn't focused.</summary>
        public bool BgPauseUnfocused { get; set; } = true;
        /// <summary>Low-power mode: videos show their poster or first frame and never play.</summary>
        public bool BgStillOnly { get; set; }
        /// <summary>Extra dimming per page (0 to 90 percent), on top of <see cref="BgDim"/>, so text stays readable.</summary>
        public System.Collections.Generic.Dictionary<string, int> BgPageDim { get; set; } = new System.Collections.Generic.Dictionary<string, int>();
        /// <summary>"stable" or "beta".</summary>
        public string UpdateChannel { get; set; } = "stable";
        /// <summary>Check for updates at start-up and every 6 hours, and download them in the background.</summary>
        public bool AutoUpdate { get; set; } = true;
        /// <summary>Overrides the update manifest URL; null means the default for the channel.</summary>
        public string? UpdateUrl { get; set; }
    }

    /// <summary>The allowed values of the background settings (the page script has the same lists).</summary>
    public static class BgRules
    {
        public static readonly string[] Fits = { "cover", "contain", "center" };
        public static readonly string[] Positions = { "center", "top", "bottom", "left", "right" };
        public static readonly string[] Pages = { "home", "lobbies", "library", "amplifier", "community", "notebook", "create", "settings" };
        public const int MaxDim = 90, MaxBlur = 24, MinInterval = 5, MaxInterval = 86400, MaxFadeMs = 5000;

        public static bool IsHexColor(string v)
        {
            if (v.Length != 7 || v[0] != '#') return false;
            for (int i = 1; i < 7; i++) if (!Uri.IsHexDigit(v[i])) return false;
            return true;
        }
    }

    /// <summary>Reads and writes settings.json; writes go through a temp file and a rename.</summary>
    public static class SettingsStore
    {
        public const string DataVariable = "RECHARGE_NEXT_DATA";
        public const string FileName = "settings.json";

        internal static readonly JsonSerializerOptions Options = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        };

        /// <summary>~/.local/share/recharge-next, or RECHARGE_NEXT_DATA when set.</summary>
        public static string DataDir()
        {
            string? forced = Environment.GetEnvironmentVariable(DataVariable);
            return !string.IsNullOrEmpty(forced)
                ? forced!
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "recharge-next");
        }

        public static string FilePath(string dataDir) => Path.Combine(dataDir, FileName);

        /// <summary>The saved settings; a missing or unreadable file gives the defaults.</summary>
        public static AppSettings Load(string dataDir)
        {
            try
            {
                string file = FilePath(dataDir);
                if (!File.Exists(file)) return Normalize(new AppSettings());
                AppSettings? loaded = JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(file), Options);
                return Normalize(loaded ?? new AppSettings());
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is JsonException)
            {
                return Normalize(new AppSettings());
            }
        }

        public static void Save(string dataDir, AppSettings settings)
        {
            Directory.CreateDirectory(dataDir);
            string file = FilePath(dataDir);
            string temp = file + "." + Environment.ProcessId + ".tmp";
            try
            {
                File.WriteAllText(temp, JsonSerializer.Serialize(settings, Options));
                File.Move(temp, file, overwrite: true);
            }
            finally
            {
                try { if (File.Exists(temp)) File.Delete(temp); } catch (IOException) { }
            }
        }

        private static AppSettings Normalize(AppSettings s)
        {
            if ((s.Theme != "halloween" && s.Theme != "classic") || !s.ThemePicked) s.Theme = "auto";
            if (s.UpdateChannel != "beta") s.UpdateChannel = "stable";
            if (string.IsNullOrWhiteSpace(s.GamePath)) s.GamePath = null;
            if (string.IsNullOrWhiteSpace(s.Background)) s.Background = null;
            if (string.IsNullOrWhiteSpace(s.UpdateUrl)) s.UpdateUrl = null;
            if (string.IsNullOrWhiteSpace(s.BackgroundPlaylist)) s.BackgroundPlaylist = null;
            if (s.BackgroundSource != "none" && s.BackgroundSource != "background" && s.BackgroundSource != "playlist")
                s.BackgroundSource = s.Background != null ? "background" : "none";
            if (Array.IndexOf(BgRules.Fits, s.BgFit) < 0) s.BgFit = "cover";
            if (Array.IndexOf(BgRules.Positions, s.BgPosition) < 0) s.BgPosition = "center";
            s.BgDim = Math.Clamp(s.BgDim, 0, BgRules.MaxDim);
            s.BgStrength = Math.Clamp(s.BgStrength, 0, 100);
            s.BgBlur = Math.Clamp(s.BgBlur, 0, BgRules.MaxBlur);
            s.BgInterval = Math.Clamp(s.BgInterval, BgRules.MinInterval, BgRules.MaxInterval);
            s.BgFadeMs = Math.Clamp(s.BgFadeMs, 0, BgRules.MaxFadeMs);
            if (s.BgTint != null && !BgRules.IsHexColor(s.BgTint)) s.BgTint = null;
            var pages = new System.Collections.Generic.Dictionary<string, int>();
            if (s.BgPageDim != null)
                foreach (var kv in s.BgPageDim)
                    if (Array.IndexOf(BgRules.Pages, kv.Key) >= 0) pages[kv.Key] = Math.Clamp(kv.Value, 0, BgRules.MaxDim);
            s.BgPageDim = pages;
            return s;
        }
    }
}

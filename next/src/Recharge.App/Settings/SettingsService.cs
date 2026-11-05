using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Recharge.App.Bridge;
using Recharge.App.Library;
using Recharge.App.Scheme;

namespace Recharge.App.Settings
{
    /// <summary>The settings.* logic without the bridge: validated reads and writes, the game-folder override, background files.</summary>
    public sealed class SettingsService
    {
        /// <summary>Background pictures bigger than this are refused (they are sent to the page as one message).</summary>
        public const long MaxBackgroundBytes = 12L * 1024 * 1024;

        private static readonly object EnvLock = new object();
        private static string? _envOwnedValue;

        private readonly string _data;

        public SettingsService(string dataDir)
        {
            _data = dataDir;
        }

        public static SettingsService Default() => new SettingsService(SettingsStore.DataDir());

        public string DataDir => _data;

        public AppSettings Get() => SettingsStore.Load(_data);

        /// <summary>Why a folder can't be the game folder, or null when it looks like an IGTAP install.</summary>
        public static string? ValidateGameFolder(string? path)
        {
            if (string.IsNullOrWhiteSpace(path)) return "Enter a folder.";
            if (!Path.IsPathRooted(path)) return "Use a full path, starting with /.";
            if (!Directory.Exists(path)) return "That folder doesn't exist.";
            try
            {
                bool exe = Directory.EnumerateFiles(path, "*.exe").Any();
                bool data = Directory.EnumerateDirectories(path, "*_Data").Any();
                if (!exe && !data) return "That doesn't look like an IGTAP folder (no game .exe or _Data folder).";
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
            {
                return "That folder can't be read.";
            }
            return null;
        }

        /// <summary>Saves (or, with null, clears) the chosen game folder and makes <see cref="GameFinder"/> use it.</summary>
        public AppSettings SetGamePath(string? path)
        {
            string? clean = string.IsNullOrWhiteSpace(path) ? null : Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
            if (clean != null)
            {
                string? problem = ValidateGameFolder(clean);
                if (problem != null) throw new ArgumentException(problem);
            }
            AppSettings s = Get();
            s.GamePath = clean;
            SettingsStore.Save(_data, s);
            ApplyGameOverride();
            return s;
        }

        /// <summary>Points GameFinder at the saved folder (through RECHARGE_GAME_DIR) unless something else already set it.</summary>
        public void ApplyGameOverride()
        {
            lock (EnvLock)
            {
                string? current = Environment.GetEnvironmentVariable(GameFinder.OverrideVariable);
                bool ours = _envOwnedValue != null && current == _envOwnedValue;
                if (!string.IsNullOrEmpty(current) && !ours) return; // set from outside (tests, snapshots): leave it
                string? saved = Get().GamePath;
                if (saved != null && Directory.Exists(saved))
                {
                    Environment.SetEnvironmentVariable(GameFinder.OverrideVariable, saved);
                    _envOwnedValue = saved;
                }
                else if (ours)
                {
                    Environment.SetEnvironmentVariable(GameFinder.OverrideVariable, null);
                    _envOwnedValue = null;
                }
            }
        }

        /// <summary>Changes the simple settings. Unknown keys and bad values are refused before anything is saved.</summary>
        public AppSettings Patch(IReadOnlyDictionary<string, JsonElement> patch)
        {
            AppSettings s = Get();
            foreach (KeyValuePair<string, JsonElement> kv in patch)
            {
                JsonElement v = kv.Value;
                switch (kv.Key)
                {
                    case "sidebarCollapsed":
                        s.SidebarCollapsed = Bool(v, kv.Key);
                        break;
                    case "theme":
                        string theme = Str(v, kv.Key) ?? "";
                        if (theme != "auto" && theme != "classic" && theme != "halloween") throw new ArgumentException("theme must be auto, classic or halloween");
                        s.Theme = theme;
                        s.ThemePicked = true;
                        break;
                    case "updateChannel":
                        string channel = Str(v, kv.Key) ?? "";
                        if (channel != "stable" && channel != "beta") throw new ArgumentException("channel must be stable or beta");
                        s.UpdateChannel = channel;
                        break;
                    case "autoUpdate":
                        s.AutoUpdate = Bool(v, kv.Key);
                        break;
                    case "updateUrl":
                        string? url = Str(v, kv.Key);
                        if (string.IsNullOrWhiteSpace(url)) { s.UpdateUrl = null; break; }
                        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                            throw new ArgumentException("the update URL must be an http or https address");
                        s.UpdateUrl = url;
                        break;
                    case "background":
                        string? folder = Str(v, kv.Key);
                        if (string.IsNullOrEmpty(folder)) { s.Background = null; break; }
                        if (!MapPathResolver.IsPlainName(folder)) throw new ArgumentException("not a background folder name");
                        s.Background = folder;
                        break;
                    case "backgroundSource":
                        string source = Str(v, kv.Key) ?? "";
                        if (source != "none" && source != "background" && source != "playlist") throw new ArgumentException("backgroundSource must be none, background or playlist");
                        s.BackgroundSource = source;
                        break;
                    case "backgroundPlaylist":
                        string? list = Str(v, kv.Key);
                        if (string.IsNullOrEmpty(list)) { s.BackgroundPlaylist = null; break; }
                        if (!MapPathResolver.IsPlainName(list)) throw new ArgumentException("not a playlist folder name");
                        s.BackgroundPlaylist = list;
                        break;
                    case "bgFit":
                        s.BgFit = OneOf(Str(v, kv.Key), BgRules.Fits, kv.Key);
                        break;
                    case "bgPosition":
                        s.BgPosition = OneOf(Str(v, kv.Key), BgRules.Positions, kv.Key);
                        break;
                    case "bgDim":
                        s.BgDim = Int(v, kv.Key, 0, BgRules.MaxDim);
                        break;
                    case "bgStrength":
                        s.BgStrength = Int(v, kv.Key, 0, 100);
                        break;
                    case "bgBlur":
                        s.BgBlur = Int(v, kv.Key, 0, BgRules.MaxBlur);
                        break;
                    case "bgInterval":
                        s.BgInterval = Int(v, kv.Key, BgRules.MinInterval, BgRules.MaxInterval);
                        break;
                    case "bgFadeMs":
                        s.BgFadeMs = Int(v, kv.Key, 0, BgRules.MaxFadeMs);
                        break;
                    case "bgShuffle":
                        s.BgShuffle = Bool(v, kv.Key);
                        break;
                    case "bgPauseUnfocused":
                        s.BgPauseUnfocused = Bool(v, kv.Key);
                        break;
                    case "bgStillOnly":
                        s.BgStillOnly = Bool(v, kv.Key);
                        break;
                    case "bgTint":
                        string? tint = Str(v, kv.Key);
                        if (string.IsNullOrEmpty(tint)) { s.BgTint = null; break; }
                        if (!BgRules.IsHexColor(tint)) throw new ArgumentException("bgTint must be a colour like #1a2b3c");
                        s.BgTint = tint.ToLowerInvariant();
                        break;
                    case "bgPageDim":
                        if (v.ValueKind != JsonValueKind.Object) throw new ArgumentException("bgPageDim must be an object");
                        var dims = new Dictionary<string, int>();
                        foreach (JsonProperty p in v.EnumerateObject())
                        {
                            if (Array.IndexOf(BgRules.Pages, p.Name) < 0) throw new ArgumentException("unknown page: " + p.Name);
                            dims[p.Name] = Int(p.Value, "bgPageDim." + p.Name, 0, BgRules.MaxDim);
                        }
                        s.BgPageDim = dims;
                        break;
                    default:
                        throw new ArgumentException("unknown setting: " + kv.Key);
                }
            }
            SettingsStore.Save(_data, s);
            return s;
        }

        private static bool Bool(JsonElement v, string key)
        {
            if (v.ValueKind == JsonValueKind.True) return true;
            if (v.ValueKind == JsonValueKind.False) return false;
            throw new ArgumentException(key + " must be true or false");
        }

        private static int Int(JsonElement v, string key, int min, int max)
        {
            if (v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out int n) || n < min || n > max)
                throw new ArgumentException(key + " must be a whole number from " + min + " to " + max);
            return n;
        }

        private static string OneOf(string? value, string[] allowed, string key)
        {
            if (value == null || Array.IndexOf(allowed, value) < 0) throw new ArgumentException(key + " must be one of " + string.Join(", ", allowed));
            return value;
        }

        private static string? Str(JsonElement v, string key)
        {
            if (v.ValueKind == JsonValueKind.Null) return null;
            if (v.ValueKind == JsonValueKind.String) return v.GetString();
            throw new ArgumentException(key + " must be text");
        }

        public string BackgroundsRoot => Path.Combine(_data, "backgrounds", "backgrounds");

        /// <summary>The picture of an installed background: its media kind, mime type and bytes (null for video: not shown yet).</summary>
        public (string Kind, string Mime, byte[]? Data) ReadBackground(string folder)
        {
            if (!MapPathResolver.IsPlainName(folder)) throw new ArgumentException("not a background folder name");
            string dir = Path.Combine(BackgroundsRoot, folder);
            if (!Directory.Exists(dir)) throw new FileNotFoundException("That background isn't installed.");
            string[] files = Directory.EnumerateFiles(dir).OrderBy(f => f, StringComparer.Ordinal).ToArray();
            // A video background may ship a poster picture; the video wins.
            string? video = files.FirstOrDefault(f => ContentInstaller.MediaKind(f) == "video");
            if (video != null) return ("video", MimeOf(video), null);
            foreach (string file in files)
            {
                if (ContentInstaller.MediaKind(file) != "image") continue;
                long length = new FileInfo(file).Length;
                if (length > MaxBackgroundBytes) throw new InvalidOperationException("That picture is too big to use as a background (over 12 MB).");
                return ("image", MimeOf(file), File.ReadAllBytes(file));
            }
            throw new FileNotFoundException("That background has no picture in it.");
        }

        private static string MimeOf(string file)
        {
            switch (Path.GetExtension(file).ToLowerInvariant())
            {
                case ".png": return "image/png";
                case ".jpg":
                case ".jpeg": return "image/jpeg";
                case ".gif": return "image/gif";
                case ".webp": return "image/webp";
                case ".bmp": return "image/bmp";
                case ".avif": return "image/avif";
                case ".mp4": return "video/mp4";
                case ".webm": return "video/webm";
                default: return "application/octet-stream";
            }
        }
    }
}

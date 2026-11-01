using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Recharge.Core.Models;

namespace Recharge.App.Updates
{
    /// <summary>The update manifest was unreadable or not usable for this platform.</summary>
    public sealed class UpdateFormatException : Exception
    {
        public UpdateFormatException(string message) : base(message) { }
    }

    /// <summary>One platform's slice of a launcher-format manifest (format 1), validated: safe paths, hex checksums, a launch file that is listed.</summary>
    public sealed class ManifestInfo
    {
        public string Channel { get; set; } = "";
        public string Version { get; set; } = "";
        public int Build { get; set; }
        public int ApiLevel { get; set; }
        public string Launch { get; set; } = "";
        public IReadOnlyList<UpdateManifest.UpdateFile> Files { get; set; } = Array.Empty<UpdateManifest.UpdateFile>();

        /// <summary>Reads the manifest the launcher also reads: {format:1, channel, version, build, apiLevel, platforms:{id:{launch, files:[{path,size,sha256,component}]}}}.</summary>
        public static ManifestInfo Parse(string text, string platform)
        {
            UpdateManifest m;
            try { m = UpdateManifest.Load(text); }
            catch (Exception e) when (e is FormatException || e is KeyNotFoundException || e is Recharge.Core.Json.JsonParseException)
            {
                throw new UpdateFormatException(e.Message);
            }
            try
            {
                if (m.Format != 1) throw new UpdateFormatException("unsupported manifest format " + m.Format);
                string version = m.Version;
                int build = m.Build;
                if (build <= 0) throw new UpdateFormatException("the manifest has no build number");
                if (string.IsNullOrWhiteSpace(version)) throw new UpdateFormatException("the manifest has no version");
                if (!m.Platforms.TryGetValue(platform, out UpdateManifest.PlatformFiles? p)) throw new UpdateFormatException("no build for " + platform);
                if (string.IsNullOrEmpty(p.Launch) || Updater.SafePath("/x", p.Launch) == null) throw new UpdateFormatException("the manifest has no usable launch file");
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (UpdateManifest.UpdateFile f in p.Files)
                {
                    if (Updater.SafePath("/x", f.Path) == null) throw new UpdateFormatException("unsafe path " + f.Path);
                    if (f.Sha256.Length != 64 || !f.Sha256.All(Uri.IsHexDigit)) throw new UpdateFormatException("bad checksum for " + f.Path);
                    if (f.Size < 0) throw new UpdateFormatException("bad size for " + f.Path);
                    if (!seen.Add(f.Path)) throw new UpdateFormatException("duplicate path " + f.Path);
                }
                if (!seen.Contains(p.Launch)) throw new UpdateFormatException("the launch file " + p.Launch + " is not in the file list");
                string channel = "";
                try { channel = m.Channel; } catch (KeyNotFoundException) { }
                int api = 0;
                try { api = m.ApiLevel; } catch (KeyNotFoundException) { }
                return new ManifestInfo { Channel = channel, Version = version, Build = build, ApiLevel = api, Launch = p.Launch, Files = p.Files };
            }
            catch (Exception e) when (e is FormatException || e is KeyNotFoundException)
            {
                throw new UpdateFormatException(e.Message);
            }
        }
    }

    /// <summary>The pure decisions of the updater: what counts as newer, which channel manifest wins.</summary>
    public static class UpdateRules
    {
        /// <summary>
        /// Builds are one global CI counter, so when both sides know their build it decides (the launcher works the same way; version
        /// labels cannot, "0.1" replaces "4.0.1-beta10"). Without a known current build, fall back to the version labels.
        /// </summary>
        public static bool IsNewer(string manifestVersion, int manifestBuild, string currentVersion, int currentBuild)
        {
            if (currentBuild > 0 && manifestBuild > 0) return manifestBuild > currentBuild;
            if (RechargeVersion.TryParse(manifestVersion, out RechargeVersion? v) && RechargeVersion.TryParse(currentVersion, out RechargeVersion? c))
                return v!.CompareTo(c) > 0;
            return false;
        }

        /// <summary>Beta also takes stable releases: the channel with the higher build wins, a tie keeps the channel's own. A missing side loses.</summary>
        public static ManifestInfo? PickNewest(ManifestInfo? own, ManifestInfo? other)
        {
            if (own == null) return other;
            if (other == null) return own;
            return other.Build > own.Build ? other : own;
        }

        /// <summary>The launcher-side channel names; anything but beta is stable.</summary>
        public static string NormalizeChannel(string? channel) => string.Equals(channel?.Trim(), "beta", StringComparison.OrdinalIgnoreCase) ? "beta" : "stable";

        /// <summary>Bytes that still have to be fetched, given a predicate for files already in place.</summary>
        public static long DownloadBytes(IEnumerable<UpdateManifest.UpdateFile> files, Func<UpdateManifest.UpdateFile, bool> installed) =>
            files.Where(f => !installed(f)).Sum(f => f.Size);
    }

    /// <summary>How this copy of Recharge is installed: by the Recharge launcher (which then owns updates) or on its own.</summary>
    public sealed class InstallMode
    {
        public bool Managed { get; set; }
        /// <summary>"env" (launcher-started), "layout" (started from the install folder without the env), "" when not managed.</summary>
        public string Reason { get; set; } = "";
        public string Launcher { get; set; } = "";
        public string Root { get; set; } = "";
        public int Build { get; set; }
        public string Version { get; set; } = "";
        public string Channel { get; set; } = "stable";

        public static readonly InstallMode Standalone = new InstallMode();

        /// <summary>
        /// Same test as the launcher's own apps: RECHARGE_LAUNCHER + RECHARGE_INSTALL_ROOT in the environment (RECHARGE_BUILD, _VERSION, _CHANNEL
        /// alongside), or an executable in &lt;root&gt;/app/ whose root holds the launcher and state.json (a taskbar pin or shortcut start).
        /// </summary>
        public static InstallMode Detect(Func<string, string?> env, string? exePath, Func<string, bool> fileExists, Func<string, string?> readText)
        {
            string launcher = (env("RECHARGE_LAUNCHER") ?? "").Trim();
            string root = (env("RECHARGE_INSTALL_ROOT") ?? "").Trim();
            if (launcher.Length > 0 && root.Length > 0)
            {
                int.TryParse((env("RECHARGE_BUILD") ?? "").Trim(), out int build);
                return new InstallMode
                {
                    Managed = true, Reason = "env", Launcher = launcher, Root = root, Build = build,
                    Version = (env("RECHARGE_VERSION") ?? "").Trim(),
                    Channel = UpdateRules.NormalizeChannel(env("RECHARGE_CHANNEL")),
                };
            }
            if (string.IsNullOrEmpty(exePath)) return Standalone;
            string? appDir = Path.GetDirectoryName(exePath);
            if (appDir == null || !string.Equals(Path.GetFileName(appDir), "app", StringComparison.OrdinalIgnoreCase)) return Standalone;
            string? rootDir = Path.GetDirectoryName(appDir);
            if (rootDir == null) return Standalone;
            string launcherPath = Path.Combine(rootDir, OperatingSystem.IsWindows() ? "recharge-launcher.exe" : "recharge-launcher");
            string statePath = Path.Combine(rootDir, "state.json");
            if (!fileExists(launcherPath) || !fileExists(statePath)) return Standalone;

            int stBuild = 0;
            string stVersion = "", stChannel = "";
            try
            {
                using JsonDocument doc = JsonDocument.Parse(readText(statePath) ?? "{}");
                if (doc.RootElement.TryGetProperty("current", out JsonElement cur) && cur.ValueKind == JsonValueKind.Object)
                {
                    if (cur.TryGetProperty("build", out JsonElement b) && b.TryGetInt32(out int bi)) stBuild = bi;
                    if (cur.TryGetProperty("version", out JsonElement v) && v.ValueKind == JsonValueKind.String) stVersion = v.GetString() ?? "";
                    if (cur.TryGetProperty("channel", out JsonElement c) && c.ValueKind == JsonValueKind.String) stChannel = c.GetString() ?? "";
                }
            }
            catch (JsonException) { }
            string chFile = (readText(Path.Combine(rootDir, "channel.txt")) ?? "").Trim();
            string channel = chFile == "beta" || chFile == "stable" ? chFile : (stChannel == "beta" || stChannel == "stable" ? stChannel : "stable");
            return new InstallMode { Managed = true, Reason = "layout", Launcher = launcherPath, Root = rootDir, Build = stBuild, Version = stVersion, Channel = channel };
        }

        public static InstallMode DetectCurrent() => Detect(
            k => Environment.GetEnvironmentVariable(k),
            Environment.ProcessPath,
            File.Exists,
            p => { try { return File.ReadAllText(p); } catch (IOException) { return null; } catch (UnauthorizedAccessException) { return null; } });

        /// <summary>The launcher's started-&lt;build&gt;.ok in the install root; without it the launcher rolls the new build back after 20 seconds.</summary>
        public string? StartedMarkerPath() => Managed && Build > 0 ? Path.Combine(Root, "started-" + Build + ".ok") : null;
    }

    /// <summary>What the launcher prints for <c>--stage</c>, and the restart request left for the next start.</summary>
    public static class LauncherProtocol
    {
        /// <summary>"staged N" gives N; "up to date" gives null. The last matching line wins.</summary>
        public static int? ParseStageOutput(string output)
        {
            foreach (string raw in output.Split('\n').Reverse())
            {
                string line = raw.Trim();
                if (line.StartsWith("staged ", StringComparison.Ordinal) && int.TryParse(line.Substring(7).Trim(), out int b)) return b;
            }
            return null;
        }

        /// <summary>The launcher's last line is "stage failed: message"; keep only the message.</summary>
        public static string StageError(string output)
        {
            string[] lines = output.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).ToArray();
            string line = lines.LastOrDefault(l => l.Contains("stage failed")) ?? lines.LastOrDefault() ?? "the launcher failed";
            const string prefix = "stage failed:";
            return line.StartsWith(prefix, StringComparison.Ordinal) ? line.Substring(prefix.Length).Trim() : line;
        }

        /// <summary>Written (snake_case, like the old app) before a restart-to-update; the next start compares builds.</summary>
        public static string RequestJson(string fromBuild, string fromVersion, int toBuild, long atEpochSeconds) =>
            JsonSerializer.Serialize(new Dictionary<string, object> { ["from_build"] = fromBuild, ["from_version"] = fromVersion, ["to_build"] = toBuild, ["at"] = atEpochSeconds });

        /// <summary>Did the requested update apply? A message when the old build came back, null when fine or not about this start.</summary>
        public static string? EvaluateRequest(string json, string runningBuild, long nowEpochSeconds)
        {
            try
            {
                using JsonDocument doc = JsonDocument.Parse(json);
                JsonElement r = doc.RootElement;
                string from = r.TryGetProperty("from_build", out JsonElement f) ? f.GetString() ?? "" : "";
                int to = r.TryGetProperty("to_build", out JsonElement t) && t.TryGetInt32(out int ti) ? ti : 0;
                long at = r.TryGetProperty("at", out JsonElement a) && a.TryGetInt64(out long ai) ? ai : 0;
                if (to == 0 || nowEpochSeconds > at + 15 * 60) return null;
                if (runningBuild == to.ToString()) return null;
                if (runningBuild != from) return null;
                return "Build " + to + " did not install, so " + (string.IsNullOrEmpty(from) ? "the previous version" : "build " + from) + " is running again. The updater's details are in launcher.log.";
            }
            catch (Exception e) when (e is JsonException || e is InvalidOperationException) { return null; }
        }
    }
}

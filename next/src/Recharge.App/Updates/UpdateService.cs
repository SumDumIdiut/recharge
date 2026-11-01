using System;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Recharge.App.Settings;

namespace Recharge.App.Updates
{
    /// <summary>The outcome of one check, as the UI sees it.</summary>
    public sealed class UpdateOutcome
    {
        /// <summary>none-yet, up-to-date, available (found, not downloaded) or ready (downloaded, waiting for a restart).</summary>
        public string State { get; set; } = "up-to-date";
        public string Version { get; set; } = "";
        public int Build { get; set; }
        public int Files { get; set; }
        public long DownloadBytes { get; set; }
    }

    /// <summary>
    /// Ties the updater together for the running app. A launcher-managed install (see <see cref="InstallMode"/>) lets the launcher do the work: a
    /// check runs <c>launcher --stage</c>, which downloads the new build beside the app, and "restart" hands over to the launcher. Any other
    /// install uses <see cref="Updater"/> (verify, swap on the next start, roll back if the new build never confirms).
    /// Automatic mode: first check a few seconds after the UI is ready, then every 6 hours, if the setting is on.
    /// </summary>
    public static class UpdateService
    {
        public static readonly TimeSpan FirstCheckAfter = TimeSpan.FromSeconds(8);
        public static readonly TimeSpan CheckEvery = TimeSpan.FromHours(6);

        private static readonly object Gate = new object();
        private static readonly SemaphoreSlim Busy = new SemaphoreSlim(1, 1);
        private static bool _started;
        private static UpdateOutcome? _ready;
        private static string _restartFailure = "";
        private static Updater? _updater;

        public static InstallMode Mode { get; private set; } = InstallMode.DetectCurrent();

        /// <summary>The downloaded update waiting for a restart, or null.</summary>
        public static UpdateOutcome? Ready { get { lock (Gate) return _ready; } }

        /// <summary>The waiting update: from this run's check, else one downloaded earlier (staged copy / the launcher's app.new.json).</summary>
        public static UpdateOutcome? FindReady(string dataDir)
        {
            UpdateOutcome? r = Ready;
            if (r != null) return r;
            try
            {
                if (Mode.Managed)
                {
                    string file = Path.Combine(Mode.Root, "app.new.json");
                    if (!File.Exists(file)) return null;
                    using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(file));
                    if (!doc.RootElement.TryGetProperty("build", out JsonElement b) || !b.TryGetInt32(out int build) || build == Mode.Build) return null;
                    string v = doc.RootElement.TryGetProperty("version", out JsonElement ve) && ve.ValueKind == JsonValueKind.String ? ve.GetString() ?? "" : "";
                    return new UpdateOutcome { State = "ready", Version = v, Build = build };
                }
                UpdateState st = UpdateState.Load(dataDir);
                if (st.Staged != null && Directory.Exists(Updater.NextDir(Bridge.UpdateCommands.AppDir())))
                    return new UpdateOutcome { State = "ready", Version = st.Staged.Version, Build = st.Staged.Build };
            }
            catch (Exception e) when (e is IOException || e is JsonException || e is UnauthorizedAccessException) { }
            return null;
        }

        public static string RestartFailure { get { lock (Gate) return _restartFailure; } }

        /// <summary>Starts the background loop once. Does nothing for RECHARGE_NO_UPDATE=1 or snapshot runs.</summary>
        public static void StartAuto()
        {
            if (Environment.GetEnvironmentVariable("RECHARGE_NO_UPDATE") == "1") return;
            if (Array.IndexOf(Environment.GetCommandLineArgs(), "--snapshot") >= 0) return;
            lock (Gate)
            {
                if (_started) return;
                _started = true;
            }
            Mode = InstallMode.DetectCurrent();
            CheckRestartOutcome();
            _ = Task.Run(async () =>
            {
                await Task.Delay(FirstCheckAfter).ConfigureAwait(false);
                while (true)
                {
                    try
                    {
                        if (SettingsService.Default().Get().AutoUpdate) await RunAsync(download: true).ConfigureAwait(false);
                    }
                    catch (Exception e) { Console.Error.WriteLine("auto update: " + e.Message); }
                    await Task.Delay(CheckEvery).ConfigureAwait(false);
                }
            });
        }

        /// <summary>One check; with <paramref name="download"/> a found update is also downloaded (always so for managed installs: the launcher's check is the download).</summary>
        public static async Task<UpdateOutcome> RunAsync(bool download)
        {
            await Busy.WaitAsync().ConfigureAwait(false);
            SettingsService settings = SettingsService.Default();
            try
            {
                UpdateOutcome outcome = Mode.Managed ? await Task.Run(() => CheckManaged(settings)).ConfigureAwait(false) : await CheckStandaloneAsync(settings, download).ConfigureAwait(false);
                Record(settings, outcome.State, "");
                if (outcome.State == "ready") lock (Gate) _ready = outcome;
                return outcome;
            }
            catch (Exception e)
            {
                Record(settings, "error", e.Message);
                throw;
            }
            finally { Busy.Release(); }
        }

        /// <summary>Downloads what the last check found (standalone installs). Managed installs already have it.</summary>
        public static async Task<UpdateOutcome> DownloadAsync()
        {
            return await RunAsync(download: true).ConfigureAwait(false);
        }

        private static void Record(SettingsService settings, string state, string error)
        {
            try
            {
                UpdateState st = UpdateState.Load(settings.DataDir);
                st.LastCheckUtc = DateTime.UtcNow.ToString("o");
                st.LastCheckState = state;
                st.LastCheckError = error;
                st.Save(settings.DataDir);
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { }
        }

        // ---- standalone ----

        private static Updater Make(SettingsService settings)
        {
            AppSettings s = settings.Get();
            UpdateState st = UpdateState.Load(settings.DataDir);
            lock (Gate)
            {
                _updater = new Updater(new UpdaterOptions
                {
                    ManifestUrl = Updater.ManifestUrlFor(s.UpdateChannel, s.UpdateUrl),
                    AltManifestUrl = Updater.AltManifestUrlFor(s.UpdateChannel, s.UpdateUrl),
                    AppDir = Bridge.UpdateCommands.AppDir(),
                    DataDir = settings.DataDir,
                    CurrentVersion = Bridge.AppVersion.Value,
                    CurrentBuild = st.InstalledBuild,
                });
                return _updater;
            }
        }

        private static async Task<UpdateOutcome> CheckStandaloneAsync(SettingsService settings, bool download)
        {
            UpdateState before = UpdateState.Load(settings.DataDir);
            Updater u = Make(settings);
            CheckResult r = await u.CheckAsync().ConfigureAwait(false);
            var o = new UpdateOutcome { Version = r.Version, Build = r.Build, Files = r.FileCount, DownloadBytes = r.DownloadBytes };
            switch (r.State)
            {
                case CheckState.NoneYet: o.State = "none-yet"; return o;
                case CheckState.UpToDate:
                    // Already downloaded earlier: still waiting for the restart.
                    if (before.Staged != null && Directory.Exists(Updater.NextDir(Bridge.UpdateCommands.AppDir())))
                        return new UpdateOutcome { State = "ready", Version = before.Staged.Version, Build = before.Staged.Build };
                    o.State = "up-to-date";
                    return o;
            }
            if (before.Staged != null && before.Staged.Build == r.Build && Directory.Exists(Updater.NextDir(Bridge.UpdateCommands.AppDir())))
                return new UpdateOutcome { State = "ready", Version = r.Version, Build = r.Build };
            if (!download) { o.State = "available"; return o; }
            StagedBuild staged = await u.DownloadAsync().ConfigureAwait(false);
            return new UpdateOutcome { State = "ready", Version = staged.Version, Build = staged.Build, Files = r.FileCount };
        }

        // ---- launcher-managed ----

        private static UpdateOutcome CheckManaged(SettingsService settings)
        {
            var info = new ProcessStartInfo(Mode.Launcher) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
            info.ArgumentList.Add("--stage");
            info.ArgumentList.Add("--no-ui");
            using Process p = Process.Start(info) ?? throw new InvalidOperationException("couldn't run the launcher");
            Task<string> err = p.StandardError.ReadToEndAsync();
            string text = p.StandardOutput.ReadToEnd();
            if (!p.WaitForExit(15 * 60 * 1000)) { try { p.Kill(); } catch (InvalidOperationException) { } throw new InvalidOperationException("the launcher took too long"); }
            if (p.ExitCode != 0) throw new InvalidOperationException(LauncherProtocol.StageError(text.Length > 0 ? text : err.GetAwaiter().GetResult()));
            int? staged = LauncherProtocol.ParseStageOutput(text);
            if (staged == null || (Mode.Build > 0 && staged == Mode.Build)) return new UpdateOutcome { State = "up-to-date", Build = Mode.Build, Version = Mode.Version };
            string version = ReadStagedVersion(Mode.Root, staged.Value);
            return new UpdateOutcome { State = "ready", Version = version, Build = staged.Value };
        }

        /// <summary>The version of the build waiting in app.new/, from the launcher's app.new.json.</summary>
        public static string ReadStagedVersion(string root, int build)
        {
            try
            {
                using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "app.new.json")));
                if (doc.RootElement.TryGetProperty("build", out JsonElement b) && b.TryGetInt32(out int bi) && bi == build &&
                    doc.RootElement.TryGetProperty("version", out JsonElement v) && v.ValueKind == JsonValueKind.String)
                    return v.GetString() ?? "";
            }
            catch (Exception e) when (e is IOException || e is JsonException || e is UnauthorizedAccessException) { }
            return "";
        }

        /// <summary>The launcher's channel.txt, so a channel picked in Settings sticks for launcher-managed installs.</summary>
        public static void SetManagedChannel(string channel)
        {
            if (!Mode.Managed) return;
            try { File.WriteAllText(Path.Combine(Mode.Root, "channel.txt"), UpdateRules.NormalizeChannel(channel)); }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { }
            lock (Gate) _ready = null; // belonged to the old channel
        }

        private static void CheckRestartOutcome()
        {
            if (!Mode.Managed) return;
            string path = Path.Combine(Mode.Root, "restart-request.json");
            try
            {
                if (!File.Exists(path)) return;
                string json = File.ReadAllText(path);
                File.Delete(path);
                string? bad = LauncherProtocol.EvaluateRequest(json, Mode.Build.ToString(), DateTimeOffset.UtcNow.ToUnixTimeSeconds());
                if (bad != null) lock (Gate) _restartFailure = bad;
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { }
        }

        // ---- restart ----

        /// <summary>Hands over to whoever installs the update, then ends this process shortly after the caller has answered.</summary>
        public static void RestartToUpdate()
        {
            UpdateOutcome? ready = FindReady(SettingsService.Default().DataDir);
            if (ready == null) throw new InvalidOperationException("There is no downloaded update to install.");
            int pid = Environment.ProcessId;
            if (Mode.Managed)
            {
                string req = LauncherProtocol.RequestJson(Mode.Build > 0 ? Mode.Build.ToString() : "", Mode.Version, ready.Build, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
                string reqPath = Path.Combine(Mode.Root, "restart-request.json");
                try { File.WriteAllText(reqPath, req); } catch (Exception e) when (e is IOException || e is UnauthorizedAccessException) { }
                try { Process.Start(DetachedLauncher(Mode, pid)); }
                catch { try { File.Delete(reqPath); } catch (IOException) { } throw; } // the app stays open
            }
            else
            {
                string exe = Environment.ProcessPath ?? throw new InvalidOperationException("no executable path to restart");
                string[] args = Environment.GetCommandLineArgs();
                var rest = new string[Math.Max(0, args.Length - 1)];
                Array.Copy(args, 1, rest, 0, rest.Length);
                Process.Start(DelayedStart(exe, rest, pid, OperatingSystem.IsWindows()));
            }
            _ = Task.Run(async () => { await Task.Delay(400).ConfigureAwait(false); Environment.Exit(0); });
        }

        /// <summary>The launcher, detached, told to wait for this process to end and then swap and start the new build.</summary>
        public static ProcessStartInfo DetachedLauncher(InstallMode mode, int pid)
        {
            ProcessStartInfo info;
            if (OperatingSystem.IsWindows())
            {
                info = new ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = mode.Root };
                foreach (string a in new[] { "/c", "start", "", "/b", mode.Launcher, "--wait-pid", pid.ToString(), "--no-ui" }) info.ArgumentList.Add(a);
            }
            else
            {
                info = new ProcessStartInfo("setsid") { UseShellExecute = false, WorkingDirectory = mode.Root };
                foreach (string a in new[] { mode.Launcher, "--wait-pid", pid.ToString(), "--no-ui" }) info.ArgumentList.Add(a);
            }
            return info;
        }

        /// <summary>Start <paramref name="exe"/> again once process <paramref name="pid"/> has ended (the new start swaps in the downloaded version).</summary>
        public static ProcessStartInfo DelayedStart(string exe, string[] args, int pid, bool windows)
        {
            ProcessStartInfo info;
            if (windows)
            {
                info = new ProcessStartInfo("cmd.exe") { UseShellExecute = false, CreateNoWindow = true };
                info.ArgumentList.Add("/c");
                info.ArgumentList.Add("ping -n 3 127.0.0.1 >nul & start \"\" " + Quote(exe) + string.Concat(Array.ConvertAll(args, a => " " + Quote(a))));
            }
            else
            {
                info = new ProcessStartInfo("setsid") { UseShellExecute = false };
                foreach (string a in new[] { "sh", "-c", "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; shift; exec \"$@\"", "recharge-restart", pid.ToString(), exe })
                    info.ArgumentList.Add(a);
                foreach (string a in args) info.ArgumentList.Add(a);
            }
            return info;
        }

        private static string Quote(string s) => "\"" + s.Replace("\"", "\"\"") + "\"";
    }
}

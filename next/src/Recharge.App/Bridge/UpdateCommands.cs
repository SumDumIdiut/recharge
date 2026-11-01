using System;
using System.IO;
using System.Threading.Tasks;
using Recharge.App.Settings;
using Recharge.App.Updates;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>updates.status / begin / check / download / restart / setChannel for Recharge's own updater. Also registers the settings.* commands.</summary>
    public static class UpdateCommands
    {
        public static void Register(CommandRegistry registry)
        {
            SettingsCommands.Register(registry);
            registry.Register("updates.status", args => Task.FromResult(Status()));
            // The page calls this once it is up: starts the automatic checks (a few seconds later, then every 6 hours).
            registry.Register("updates.begin", args =>
            {
                UpdateService.StartAuto();
                return Task.FromResult(Status());
            });
            registry.Register("updates.check", async args =>
            {
                // Check now: a managed install's check already downloads (the launcher stages the build); a standalone one only looks.
                UpdateOutcome r = await UpdateService.RunAsync(download: false).ConfigureAwait(false);
                return Outcome(r);
            });
            registry.Register("updates.download", async args =>
            {
                UpdateOutcome r = await UpdateService.DownloadAsync().ConfigureAwait(false);
                if (r.State != "ready") throw new InvalidOperationException("There is no update to download.");
                return Outcome(r);
            });
            registry.Register("updates.restart", args =>
            {
                UpdateService.RestartToUpdate();
                return Task.FromResult(SettingsCommands.Obj(new { restarting = true }));
            });
            registry.Register("updates.setChannel", args =>
            {
                string channel = args.TryGetValue("channel", out JsonNode n) && n is JsonString s ? s.Value : "";
                if (channel != "stable" && channel != "beta") throw new ArgumentException("channel must be stable or beta");
                SettingsService.Default().Patch(new System.Collections.Generic.Dictionary<string, System.Text.Json.JsonElement>
                {
                    ["updateChannel"] = System.Text.Json.JsonDocument.Parse("\"" + channel + "\"").RootElement.Clone(),
                });
                UpdateService.SetManagedChannel(channel);
                return Task.FromResult(Status());
            });
        }

        public static string AppDir() => Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory);

        private static JsonNode Outcome(UpdateOutcome r) => SettingsCommands.Obj(new
        {
            state = r.State,
            version = r.Version,
            build = r.Build,
            files = r.Files,
            downloadBytes = r.DownloadBytes,
        });

        private static JsonNode Status()
        {
            SettingsService settings = SettingsService.Default();
            AppSettings s = settings.Get();
            UpdateState st = UpdateState.Load(settings.DataDir);
            InstallMode mode = UpdateService.Mode;
            UpdateOutcome? ready = UpdateService.FindReady(settings.DataDir);
            string channel = mode.Managed ? mode.Channel : s.UpdateChannel;
            string version = mode.Managed && mode.Version.Length > 0 ? mode.Version : string.IsNullOrEmpty(st.InstalledVersion) ? AppVersion.Value : st.InstalledVersion;
            int build = mode.Managed && mode.Build > 0 ? mode.Build : st.InstalledBuild;
            string failure = UpdateService.RestartFailure;
            if (failure.Length == 0 && st.LastRollback.Length > 0) failure = "Version " + st.LastRollback + " did not start, so the previous version was restored.";
            return SettingsCommands.Obj(new
            {
                version,
                build,
                channel,
                managed = mode.Managed,
                auto = s.AutoUpdate,
                url = mode.Managed ? "" : Updater.ManifestUrlFor(s.UpdateChannel, s.UpdateUrl),
                defaultUrl = Updater.ManifestUrlFor(channel, null),
                lastCheck = st.LastCheckUtc,
                lastCheckState = st.LastCheckState,
                lastCheckError = st.LastCheckError,
                ready = ready == null ? null : new { version = ready.Version, build = ready.Build },
                staged = ready == null ? null : new { version = ready.Version, build = ready.Build },
                lastRollback = st.LastRollback,
                failure,
            });
        }
    }
}

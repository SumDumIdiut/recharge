using System;
using System.IO;
using System.Threading.Tasks;
using Recharge.App.Library;
using Recharge.Core.Json;
using Recharge.Patcher;
using LoaderPatcher = Recharge.Patcher.Patcher;

namespace Recharge.App.Bridge
{
    /// <summary>Bridge commands for RechargeLoader 2 in the game folder: status, install, repair, uninstall.</summary>
    public static class LoaderCommands
    {
        public static void Register(CommandRegistry registry)
        {
            registry.Register("loader.status", args => Run(t => LoaderPatcher.Inspect(t.Game, t.Files), args));
            registry.Register("loader.install", args => Run(t => LoaderPatcher.Install(t.Game, t.Files, GameProcess.IsRunning), args));
            registry.Register("loader.repair", args => Run(t => LoaderPatcher.Repair(t.Game, t.Files, GameProcess.IsRunning), args));
            registry.Register("loader.mode", args =>
            {
                string game = GameFinder.Find() ?? throw new InvalidOperationException("io: IGTAP wasn't found");
                try { return Task.FromResult(ModeJson(LoaderPatcher.Mode(game))); }
                catch (PatcherException e) { throw new InvalidOperationException(e.Message); }
            });
            registry.Register("loader.uninstall", args => Run(t => LoaderPatcher.Uninstall(t.Game, GameProcess.IsRunning), args));
        }

        private readonly record struct Target(string Game, string Files);

        /// <summary>For game.launch: deploys the vanilla or modded build (either loader) before the game starts. Refuses while IGTAP runs.</summary>
        public static string SwitchBuild(string game, bool modded)
        {
            try { return LoaderPatcher.SetMode(game, modded, GameProcess.IsRunning).Detail; }
            catch (PatcherException e) { throw new InvalidOperationException(e.Message); }
        }

        public static JsonNode ModeJson(ModeStatus m)
        {
            var o = new JsonObject();
            o["modded"] = m.Modded ? JsonBool.True : JsonBool.False;
            o["loader"] = new JsonString(m.Loader);
            o["canModded"] = m.CanModded ? JsonBool.True : JsonBool.False;
            o["detail"] = new JsonString(m.Detail);
            return o;
        }

        /// <summary>The loader DLLs ship in the "loader" folder next to the app (see Recharge.App.csproj and tools/stage-loader.sh); an optional "files" argument overrides.</summary>
        public static string DefaultFilesDir()
        {
            string baseDir = AppContext.BaseDirectory;
            return Path.Combine(baseDir, "loader");
        }

        private static Task<JsonNode> Run(Func<Target, LoaderStatus> action, JsonObject args)
        {
            string game = GameFinder.Find() ?? throw new InvalidOperationException("io: IGTAP wasn't found");
            string files = args.TryGetValue("files", out JsonNode n) && n is JsonString s && s.Value.Length > 0 ? s.Value : DefaultFilesDir();
            try
            {
                return Task.FromResult(ToJson(action(new Target(game, files))));
            }
            catch (PatcherException e)
            {
                throw new InvalidOperationException(e.Message);
            }
        }

        public static JsonNode ToJson(LoaderStatus status)
        {
            var o = new JsonObject();
            o["state"] = new JsonString(status.State.ToString().ToLowerInvariant());
            o["legacy"] = status.Legacy ? JsonBool.True : JsonBool.False;
            o["hasBackup"] = status.HasBackup ? JsonBool.True : JsonBool.False;
            o["detail"] = new JsonString(status.Detail);
            return o;
        }
    }
}

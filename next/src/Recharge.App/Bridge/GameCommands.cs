using System;
using System.Threading.Tasks;
using Recharge.App.Game;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>Bridge commands for the running game: game.launch starts IGTAP (optionally modded or vanilla, and with a first intent), game.intent talks to it.</summary>
    public static class GameCommands
    {
        private static readonly Lazy<GameSession> Shared = new Lazy<GameSession>(() => new GameSession(GameFinder.Find, new SteamGameLauncher(), null, LoaderCommands.SwitchBuild, Recharge.App.Library.GameProcess.IsRunning));

        public static void Register(CommandRegistry registry) => Register(registry, () => Shared.Value, IntentBlockedByLoader);

        /// <summary>
        /// An intent (host / join) is only understood by RechargeLoader 2. With the previous loader or none, the game would start and sit on a black
        /// screen, so the launch is refused with a reason instead. Null when fine.
        /// </summary>
        public static string? IntentBlockedByLoader()
        {
            string? game = GameFinder.Find();
            if (game == null) return null; // the launch itself reports that
            try
            {
                var mode = Recharge.Patcher.Patcher.Mode(game);
                return mode.Loader == "next" ? null
                    : "loader: hosting and joining from Recharge needs Recharge's loader in the game (it is " + (mode.Loader == "legacy" ? "the previous loader" : "not installed") + "); install it in Settings > Game";
            }
            catch (Exception) { return null; }
        }

        public static void Register(CommandRegistry registry, Func<GameSession> session, Func<string?>? intentBlocker = null)
        {
            registry.Register("game.launch", async args =>
            {
                string? kind = null;
                JsonNode? intentArgs = null;
                if (args.TryGetValue("intent", out JsonNode i) && i is JsonObject intent)
                {
                    kind = KindOf(intent);
                    string? blocked = intentBlocker?.Invoke();
                    if (blocked != null) throw new InvalidOperationException(blocked);
                    intentArgs = intent.TryGetValue("args", out JsonNode a) ? a : null;
                }
                bool? modded = args.TryGetValue("modded", out JsonNode m) && m is JsonBool mb ? mb.Value : null;
                return (JsonNode)await session().LaunchAsync(kind, intentArgs, modded).ConfigureAwait(false);
            });
            registry.Register("game.intent", async args =>
            {
                string kind = KindOf(args);
                return (JsonNode)await session().SendIntentAsync(kind, args.TryGetValue("args", out JsonNode a) ? a : null).ConfigureAwait(false);
            });
            registry.Register("game.state", args => Task.FromResult<JsonNode>(session().State()));
            // Is this game folder's IGTAP running (whether or not it's linked to the app), and which build is deployed.
            registry.Register("game.running", args => Task.Run<JsonNode>(() =>
            {
                var o = new JsonObject();
                string? game = GameFinder.Find();
                bool running = game != null && Recharge.App.Library.GameProcess.IsRunning(game);
                o["running"] = running ? JsonBool.True : JsonBool.False;
                bool? modded = null;
                if (game != null) { try { modded = Recharge.Patcher.Patcher.Mode(game).Modded; } catch (Exception) { } }
                o["modded"] = modded == null ? JsonNull.Instance : (modded.Value ? JsonBool.True : JsonBool.False);
                return o;
            }));
            // Closes this game folder's IGTAP (only its own processes, by PID).
            registry.Register("game.close", args => Task.Run<JsonNode>(() =>
            {
                string game = GameFinder.Find() ?? throw new InvalidOperationException("io: IGTAP wasn't found");
                var o = new JsonObject();
                o["closed"] = JsonNumber.From(Recharge.App.Library.GameProcess.Close(game));
                return o;
            }));
        }

        private static string KindOf(JsonObject o)
        {
            if (!o.TryGetValue("kind", out JsonNode k) || k is not JsonString ks || string.IsNullOrEmpty(ks.Value))
                throw new ArgumentException("missing string argument: kind");
            return ks.Value;
        }
    }
}

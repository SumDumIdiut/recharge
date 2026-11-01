using System;
using System.Threading.Tasks;
using Recharge.App.Game;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>Bridge commands for the running game: game.launch starts IGTAP (optionally modded or vanilla, and with a first intent), game.intent talks to it.</summary>
    public static class GameCommands
    {
        private static readonly Lazy<GameSession> Shared = new Lazy<GameSession>(() => new GameSession(GameFinder.Find, new SteamGameLauncher(), null, LoaderCommands.SwitchBuild));

        public static void Register(CommandRegistry registry) => Register(registry, () => Shared.Value);

        public static void Register(CommandRegistry registry, Func<GameSession> session)
        {
            registry.Register("game.launch", async args =>
            {
                string? kind = null;
                JsonNode? intentArgs = null;
                if (args.TryGetValue("intent", out JsonNode i) && i is JsonObject intent)
                {
                    kind = KindOf(intent);
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
        }

        private static string KindOf(JsonObject o)
        {
            if (!o.TryGetValue("kind", out JsonNode k) || k is not JsonString ks || string.IsNullOrEmpty(ks.Value))
                throw new ArgumentException("missing string argument: kind");
            return ks.Value;
        }
    }
}

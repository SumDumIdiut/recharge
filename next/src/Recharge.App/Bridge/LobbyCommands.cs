using System.Threading.Tasks;
using Recharge.App.Lobbies;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>The Lobbies page bridge. Read-only: nothing here hosts or joins.</summary>
    public static class LobbyCommands
    {
        public static void Register(CommandRegistry registry) => Register(registry, () => LobbyHub.Instance);

        public static void Register(CommandRegistry registry, System.Func<LobbyHub> hub)
        {
            registry.Register("lobbies.list", async args => (JsonNode)await hub().ListAsync().ConfigureAwait(false));
            registry.Register("lobbies.watch", args =>
            {
                bool on = args.TryGetValue("on", out JsonNode n) && n is JsonBool b && b.Value;
                hub().Watch(on);
                var r = new JsonObject();
                r["watching"] = on ? JsonBool.True : JsonBool.False;
                return Task.FromResult<JsonNode>(r);
            });
            registry.Register("lobbies.status", args => Task.FromResult<JsonNode>(hub().Status()));
        }
    }
}

using System;
using System.Threading.Tasks;
using Recharge.App.Social;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>Friends & Messages: requests to the social server, plus the realtime event feed.</summary>
    public static class SocialCommands
    {
        public static void Register(CommandRegistry registry) => Register(registry, () => SocialHub.Instance);

        public static void Register(CommandRegistry registry, Func<SocialHub> hub)
        {
            registry.Register("social.request", args =>
            {
                string method = args.TryGetValue("method", out JsonNode m) && m is JsonString ms ? ms.Value : "GET";
                string path = args.TryGetValue("path", out JsonNode p) && p is JsonString ps ? ps.Value : "";
                JsonNode? body = args.TryGetValue("body", out JsonNode b) && b is not JsonNull ? b : null;
                return hub().Request(method, path, body);
            });
            registry.Register("social.watch", args =>
            {
                bool on = args.TryGetValue("on", out JsonNode n) && n is JsonBool b && b.Value;
                hub().Watch(on);
                var r = new JsonObject();
                r["watching"] = on ? JsonBool.True : JsonBool.False;
                return Task.FromResult<JsonNode>(r);
            });
            registry.Register("social.events", args =>
            {
                long since = args.TryGetValue("since", out JsonNode s) && s is JsonNumber num ? num.AsInt64() : 0;
                return Task.FromResult<JsonNode>(hub().Events(since));
            });
            registry.Register("social.presence", args =>
            {
                string Text(string key) => args.TryGetValue(key, out JsonNode v) && v is JsonString js ? js.Value : "";
                string state = Text("state");
                hub().SetPresence(string.IsNullOrEmpty(state) ? "online" : state, Text("detail"), Text("join"));
                var r = new JsonObject();
                r["ok"] = JsonBool.True;
                return Task.FromResult<JsonNode>(r);
            });
        }
    }
}

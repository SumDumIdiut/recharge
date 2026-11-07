using System;
using System.Threading.Tasks;
using Recharge.App.Amp;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>Bridge commands for the Amplifier map editor: amp.load reads a map folder's map.json, amp.save writes it.</summary>
    public static class AmpCommands
    {
        public static void Register(CommandRegistry registry)
        {
            registry.Register("amp.load", Load);
            registry.Register("amp.save", Save);
            registry.Register("amp.preview", Preview);
        }

        private static Task<JsonNode> Load(JsonObject args)
        {
            string game = GameFinder.Find() ?? throw new InvalidOperationException("IGTAP was not found");
            string id = Required(args, "id");
            var result = new JsonObject();
            result["id"] = new JsonString(id);
            result["map"] = new JsonString(AmpService.Load(game, id));
            return Task.FromResult<JsonNode>(result);
        }

        private static Task<JsonNode> Preview(JsonObject args)
        {
            string game = GameFinder.Find() ?? throw new InvalidOperationException("IGTAP was not found");
            string? since = args.TryGetValue("since", out JsonNode s) && s is JsonString ss ? ss.Value : null;
            var (rev, map, same) = AmpService.Preview(game, Required(args, "id"), since);
            var result = new JsonObject();
            result["rev"] = new JsonString(rev);
            result["map"] = map is null ? JsonNull.Instance : new JsonString(map);
            result["same"] = same ? JsonBool.True : JsonBool.False;
            return Task.FromResult<JsonNode>(result);
        }

        private static Task<JsonNode> Save(JsonObject args)
        {
            string game = GameFinder.Find() ?? throw new InvalidOperationException("IGTAP was not found");
            string? id = args.TryGetValue("id", out JsonNode node) && node is JsonString s && !string.IsNullOrEmpty(s.Value) ? s.Value : null;
            string folder = AmpService.Save(game, id, Required(args, "name"), Required(args, "map"));
            Library.InstalledCache.Invalidate();
            var result = new JsonObject();
            result["id"] = new JsonString(folder);
            return Task.FromResult<JsonNode>(result);
        }

        private static string Required(JsonObject args, string key)
        {
            if (!args.TryGetValue(key, out JsonNode node) || node is not JsonString value || string.IsNullOrEmpty(value.Value))
                throw new ArgumentException("missing string argument: " + key);
            return value.Value;
        }
    }
}

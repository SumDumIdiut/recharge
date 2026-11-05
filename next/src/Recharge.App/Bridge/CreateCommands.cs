using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using Recharge.App.Create;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>Bridge commands for the Create page. All read-only; open.folder only launches the file manager.</summary>
    public static class CreateCommands
    {
        public static void Register(CommandRegistry registry)
        {
            registry.Register("create.maps", Maps);
            registry.Register("create.mapThumb", MapThumb);
            registry.Register("create.skins", Skins);
            registry.Register("create.skinSheet", SkinSheet);
            registry.Register("open.folder", OpenFolder);
        }

        private static Task<JsonNode> Maps(JsonObject args)
        {
            string? game = GameFinder.Find();
            JsonObject result = game is null ? Empty("maps") : CreateService.Maps(CreateService.MapsDir(game));
            result["game"] = game is null ? JsonNull.Instance : new JsonString(game);
            return Task.FromResult<JsonNode>(result);
        }

        private static Task<JsonNode> Skins(JsonObject args)
        {
            string? game = GameFinder.Find();
            JsonObject result = game is null ? Empty("skins") : CreateService.Skins(CreateService.SkinsDir(game));
            result["game"] = game is null ? JsonNull.Instance : new JsonString(game);
            return Task.FromResult<JsonNode>(result);
        }

        private static Task<JsonNode> MapThumb(JsonObject args)
        {
            string? game = GameFinder.Find();
            string folder = Required(args, "folder");
            if (game is null)
            {
                return Task.FromResult<JsonNode>(CreateService.Image(string.Empty));
            }
            string dir = CreateService.ResolveFolder(game, "map", folder);
            return Task.FromResult<JsonNode>(CreateService.Image(CreateService.PreviewFor(dir) ?? string.Empty));
        }

        private static Task<JsonNode> SkinSheet(JsonObject args)
        {
            string? game = GameFinder.Find();
            string folder = Required(args, "folder");
            if (game is null)
            {
                return Task.FromResult<JsonNode>(CreateService.Image(string.Empty));
            }
            string dir = CreateService.ResolveFolder(game, "skin", folder);
            // An optional other sheet in the folder (a skin whose template is empty keeps its art in doublejump.png).
            string? file = args.TryGetValue("file", out JsonNode f) && f is JsonString fs ? fs.Value : null;
            if (!string.IsNullOrEmpty(file) && file == Path.GetFileName(file) && file.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
            {
                string other = Path.Combine(dir, file);
                return Task.FromResult<JsonNode>(CreateService.Image(File.Exists(other) ? other : string.Empty));
            }
            return Task.FromResult<JsonNode>(CreateService.Image(CreateService.PlayerImage(dir) ?? string.Empty));
        }

        private static Task<JsonNode> OpenFolder(JsonObject args)
        {
            string? game = GameFinder.Find();
            if (game is null)
            {
                throw new InvalidOperationException("IGTAP was not found");
            }
            string kind = Required(args, "kind");
            string? folder = args.TryGetValue("folder", out JsonNode node) && node is JsonString s ? s.Value : null;
            string path = CreateService.ResolveFolder(game, kind, folder);
            if (!Directory.Exists(path))
            {
                throw new DirectoryNotFoundException("that folder does not exist");
            }
            ShellOpen.Open(path);
            var result = new JsonObject();
            result["opened"] = JsonBool.True;
            return Task.FromResult<JsonNode>(result);
        }

        private static JsonObject Empty(string key)
        {
            var result = new JsonObject();
            result[key] = new JsonArray();
            return result;
        }

        private static string Required(JsonObject args, string key)
        {
            if (!args.TryGetValue(key, out JsonNode node) || node is not JsonString value || string.IsNullOrEmpty(value.Value))
            {
                throw new ArgumentException("missing string argument: " + key);
            }
            return value.Value;
        }
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Recharge.App.Create;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>
    /// Bridge commands for choosing a skin while the game is not running: <c>skin.applyNext</c> writes the Skins module's
    /// <c>data/config.json</c> so the skin is worn from the next launch, and <c>skin.current</c> reads it back. When the
    /// game is running the page sends the <c>skin.apply</c> intent through <c>game.intent</c> instead.
    ///
    /// This is the one place the app writes into the game folder: only <c>config.json</c> of the old
    /// <c>recharge.customskins</c> mod data, with a <c>config.json.bak</c> copy first. It mirrors
    /// <c>Recharge.Loader.Core.Skins.SkinConfig</c>, which the module itself uses.
    /// </summary>
    public static class SkinCommands
    {
        public const string ConfigKey = "CurrentSkinFile";

        public static void Register(CommandRegistry registry) => Register(registry, GameFinder.Find);

        public static void Register(CommandRegistry registry, Func<string?> game)
        {
            registry.Register("skin.applyNext", args => Task.FromResult<JsonNode>(ApplyNext(game(), args)));
            registry.Register("skin.current", args => Task.FromResult<JsonNode>(Current(game())));
        }

        public static string ConfigPath(string gameDir) =>
            Path.Combine(gameDir, "Recharge", "Mods", "recharge.customskins", "data", "config.json");

        /// <summary>{ok, folder, backup?} after writing the choice. A null or empty folder means the vanilla look.</summary>
        public static JsonObject ApplyNext(string? gameDir, JsonObject args)
        {
            if (gameDir == null) throw new InvalidOperationException("IGTAP was not found");
            string? folder = null;
            if (args.TryGetValue("folder", out JsonNode node) && !(node is JsonNull))
            {
                if (!(node is JsonString s)) throw new ArgumentException("folder must be a string");
                folder = s.Value.Length == 0 ? null : s.Value;
            }
            if (folder != null)
            {
                string skinsDir = CreateService.SkinsDir(gameDir);
                string dir = CreateService.Child(skinsDir, folder);
                if (!Directory.Exists(dir)) throw new DirectoryNotFoundException("that skin is not installed");
            }

            string? backup = WriteChoice(ConfigPath(gameDir), folder);
            var result = new JsonObject();
            result["ok"] = JsonBool.True;
            result["folder"] = folder == null ? (JsonNode)JsonNull.Instance : new JsonString(folder);
            if (backup != null) result["backup"] = new JsonString(backup);
            return result;
        }

        public static JsonObject Current(string? gameDir)
        {
            var result = new JsonObject();
            string? folder = gameDir == null ? null : ReadChoice(ConfigPath(gameDir));
            result["folder"] = folder == null ? (JsonNode)JsonNull.Instance : new JsonString(folder);
            return result;
        }

        public static string? ReadChoice(string configPath)
        {
            try
            {
                if (!File.Exists(configPath)) return null;
                if (!(JsonReader.Parse(File.ReadAllText(configPath)) is JsonObject o)) return null;
                foreach (KeyValuePair<string, JsonNode> kv in o)
                {
                    if (string.Equals(kv.Key, ConfigKey, StringComparison.OrdinalIgnoreCase))
                        return kv.Value is JsonString s && s.Value.Length > 0 ? s.Value : null;
                }
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is JsonParseException)
            {
                // an unreadable config means no choice
            }
            return null;
        }

        /// <summary>Writes the choice; an existing file is copied to config.json.bak first and its other keys are kept. Returns the backup path.</summary>
        public static string? WriteChoice(string configPath, string? folder)
        {
            string? dir = Path.GetDirectoryName(configPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            var root = new JsonObject();
            string? backup = null;
            if (File.Exists(configPath))
            {
                backup = configPath + ".bak";
                File.Copy(configPath, backup, true);
                try
                {
                    if (JsonReader.Parse(File.ReadAllText(configPath)) is JsonObject existing) root = existing;
                }
                catch (JsonParseException)
                {
                    // a corrupt config is replaced; the backup keeps the original
                }
            }
            foreach (string key in new List<string>(root.Keys))
            {
                if (string.Equals(key, ConfigKey, StringComparison.OrdinalIgnoreCase) && key != ConfigKey) root.Remove(key);
            }
            root[ConfigKey] = folder == null ? (JsonNode)JsonNull.Instance : new JsonString(folder);

            string temp = configPath + ".tmp";
            File.WriteAllText(temp, JsonWriter.Write(root, 2), new UTF8Encoding(false));
            if (File.Exists(configPath)) File.Delete(configPath);
            File.Move(temp, configPath);
            return backup;
        }
    }
}

using System;
using System.IO;
using System.Text;
using Recharge.Core.Json;

namespace Recharge.Loader.Core.Skins
{
    /// <summary>Where the Skins module keeps its data. It still uses the old mod's folder so installed skins and the chosen skin carry over.</summary>
    public static class SkinPaths
    {
        /// <summary>The old mod's id, and the name of the data folder the module keeps using.</summary>
        public const string DataModId = "recharge.customskins";

        public const string EnvGameDir = "RECHARGE_GAME_DIR";

        public static string DataDir(string gameDir) => Path.Combine(gameDir, "Recharge", "Mods", DataModId, "data");

        public static string SkinsDir(string gameDir) => Path.Combine(DataDir(gameDir), "skins");

        public static string ConfigPath(string gameDir) => Path.Combine(DataDir(gameDir), "config.json");
    }

    /// <summary>
    /// <c>data/config.json</c>: <c>{ "CurrentSkinFile": "folder" }</c>, or null for the vanilla look. The key keeps the
    /// casing the old mod's Newtonsoft writer used, and is read case-insensitively. Other keys are kept on write.
    /// </summary>
    public static class SkinConfig
    {
        public const string Key = "CurrentSkinFile";

        /// <summary>The chosen skin folder, or null (missing, unreadable, null or empty means vanilla).</summary>
        public static string? Read(string configPath)
        {
            try
            {
                if (!File.Exists(configPath)) return null;
                if (!(JsonReader.Parse(File.ReadAllText(configPath)) is JsonObject o)) return null;
                foreach (var kv in o)
                {
                    if (!string.Equals(kv.Key, Key, StringComparison.OrdinalIgnoreCase)) continue;
                    return kv.Value is JsonString s && s.Value.Length > 0 ? s.Value : null;
                }
                return null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// Writes the chosen skin. An existing file is copied to <c>config.json.bak</c> first, other keys are kept, and the
        /// new file replaces the old in one step. Returns the backup path, or null when there was nothing to back up.
        /// </summary>
        public static string? Write(string configPath, string? folder)
        {
            var dir = Path.GetDirectoryName(configPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            JsonObject root = new JsonObject();
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
                    // a corrupt config is replaced (the backup keeps the original)
                }
            }

            foreach (var key in new System.Collections.Generic.List<string>(root.Keys))
                if (string.Equals(key, Key, StringComparison.OrdinalIgnoreCase) && key != Key) root.Remove(key);
            root[Key] = folder == null ? (JsonNode)JsonNull.Instance : new JsonString(folder);

            var temp = configPath + ".tmp";
            File.WriteAllText(temp, JsonWriter.Write(root, 2), new UTF8Encoding(false));
            if (File.Exists(configPath)) File.Delete(configPath);
            File.Move(temp, configPath);
            return backup;
        }
    }

    /// <summary>The <c>skin.apply</c> intent and the <c>skin</c> state of the app-game link.</summary>
    public static class SkinLinkProtocol
    {
        public const string ApplyIntent = "skin.apply";
        public const string StateKey = "skin";

        /// <summary>The folder out of the intent's args <c>{folder}</c>; an empty or null folder means vanilla. Throws on a malformed request.</summary>
        public static string? ParseApplyArgs(JsonNode? args)
        {
            if (!(args is JsonObject o)) throw new ArgumentException("skin.apply needs {folder}");
            if (!o.TryGetValue("folder", out var f) || f is JsonNull) return null;
            if (!(f is JsonString s)) throw new ArgumentException("folder must be a string");
            return s.Value.Length == 0 ? null : s.Value;
        }

        /// <summary>The state value: <c>{folder, name}</c>, folder null for vanilla.</summary>
        public static JsonObject State(string? folder, string? displayName)
        {
            var o = new JsonObject();
            o["folder"] = folder == null ? (JsonNode)JsonNull.Instance : new JsonString(folder);
            o["name"] = new JsonString(displayName ?? (folder == null ? "Vanilla" : folder));
            return o;
        }
    }
}

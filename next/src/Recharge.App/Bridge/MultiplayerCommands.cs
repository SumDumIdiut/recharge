using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>
    /// mp.identity: writes the signed-in Recharge name + colour into the game so multiplayer
    /// shows it instead of the Steam persona name. The Net module reads this file in
    /// MpNetworkManager.GetDisplayName()/GetNameColorHex() before its PlayerPref/Steam fallback.
    /// Logged out (blank name) clears the file so the Steam name comes back.
    /// </summary>
    public static class MultiplayerCommands
    {
        public const string ModuleFolder = "recharge.multiplayer";
        public const string IdentityFileName = "identity.json";
        public const string DisplayFileName = "display.json";

        public static void Register(CommandRegistry registry)
        {
            registry.Register("mp.identity", args => Task.FromResult(WriteIdentity(args)));
            registry.Register("mp.display", args => Task.FromResult(WriteDisplay(args)));
        }

        /// <summary>The identity file the in-game Net module reads: &lt;gameDir&gt;/Recharge/Mods/recharge.multiplayer/identity.json.</summary>
        private static string? IdentityPath() => ModuleFile(IdentityFileName);

        private static string? ModuleFile(string name)
        {
            string? game = GameFinder.Find();
            if (string.IsNullOrEmpty(game)) return null;
            return Path.Combine(game, "Recharge", "Mods", ModuleFolder, name);
        }

        /// <summary>mp.display: the per-player opacity prefs the in-game Net module reads for peer name labels and bodies (0..1).</summary>
        private static JsonNode WriteDisplay(JsonObject args)
        {
            string? path = ModuleFile(DisplayFileName);
            var result = new JsonObject();
            if (path == null)
            {
                result["written"] = JsonBool.False;
                result["reason"] = new JsonString("game not found");
                return result;
            }

            var model = new JsonObject();
            model["nameOpacity"] = JsonNumber.From(Clamp01(args, "nameOpacity", 0.9));
            model["playerOpacity"] = JsonNumber.From(Clamp01(args, "playerOpacity", 0.9));

            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, JsonWriter.Write(model, 0), new UTF8Encoding(false));
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                result["written"] = JsonBool.False;
                result["reason"] = new JsonString(ex.Message);
                return result;
            }

            result["written"] = JsonBool.True;
            result["path"] = new JsonString(path);
            return result;
        }

        private static double Clamp01(JsonObject args, string key, double fallback)
        {
            if (!args.TryGetValue(key, out JsonNode node) || node is not JsonNumber num) return fallback;
            double v;
            try { v = num.AsDouble(); } catch { return fallback; }
            return v < 0 ? 0 : v > 1 ? 1 : v;
        }

        private static JsonNode WriteIdentity(JsonObject args)
        {
            string? path = IdentityPath();
            var result = new JsonObject();
            if (path == null)
            {
                // No game found: a resilient no-op (the UI calls this on every login, with or without the game present).
                result["written"] = JsonBool.False;
                result["reason"] = new JsonString("game not found");
                return result;
            }

            string name = ReadString(args, "name")?.Trim() ?? "";
            if (name.Length == 0)
            {
                // Logged out: drop the file so GetDisplayName() falls back to the Steam persona name.
                try { if (File.Exists(path)) File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                result["written"] = JsonBool.False;
                result["cleared"] = JsonBool.True;
                result["path"] = new JsonString(path);
                return result;
            }

            string color = NormalizeHex(ReadString(args, "nameColor")) ?? "#FFFFFF";
            var gradient = ReadHexArray(args, "gradient");

            var model = new JsonObject();
            model["name"] = new JsonString(name);
            model["color"] = new JsonString(color);
            if (gradient.Count >= 2)
            {
                var arr = new JsonArray();
                foreach (string stop in gradient) arr.Add(new JsonString(stop));
                model["gradient"] = arr;
            }

            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, JsonWriter.Write(model, 0), new UTF8Encoding(false));
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                result["written"] = JsonBool.False;
                result["reason"] = new JsonString(ex.Message);
                return result;
            }

            result["written"] = JsonBool.True;
            result["path"] = new JsonString(path);
            return result;
        }

        private static string? ReadString(JsonObject args, string key) =>
            args.TryGetValue(key, out JsonNode node) && node is JsonString value ? value.Value : null;

        /// <summary>A validated #rrggbb (upper-case), or null. The Net module trusts this file, so only clean hex is stored.</summary>
        private static string? NormalizeHex(string? raw)
        {
            if (string.IsNullOrEmpty(raw)) return null;
            string s = raw!.Trim();
            if (s.Length != 7 || s[0] != '#') return null;
            for (int i = 1; i < 7; i++)
            {
                char c = s[i];
                bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
                if (!hex) return null;
            }
            return s.ToUpperInvariant();
        }

        private static List<string> ReadHexArray(JsonObject args, string key)
        {
            var stops = new List<string>();
            if (args.TryGetValue(key, out JsonNode node) && node is JsonArray arr)
            {
                foreach (JsonNode item in arr)
                {
                    if (item is JsonString s)
                    {
                        string? hex = NormalizeHex(s.Value);
                        if (hex != null) stops.Add(hex);
                    }
                }
            }
            return stops;
        }
    }
}

using System;
using System.IO;
using System.Threading.Tasks;
using Recharge.App.Library;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>
    /// Gun's settings (the Gun mod, recharge.gun, has no in-game menu any more). They live in
    /// Recharge/Mods/recharge.gun/data/config.json; the mod reads that file once when the game starts, so a change applies the next time IGTAP starts
    /// and is refused while it runs. "Re-lock" clears the Gun's purchase record in data/unlocks.json (after a copy), so the Unlock gun box is buyable again.
    ///   gun.settings                          -> {installed, running, appliesOn, settings{enabled, gun, breakTiles, leftMouseFires, recoilPercent}, guns[], unlocks{slot: bool}}
    ///   gun.setSettings {enabled?, gun?, breakTiles?, leftMouseFires?, recoilPercent?} -> the same as gun.settings
    ///   gun.relock {slot?: "base" (default) | a slot key | "all"} -> {relocked[], backup}
    /// </summary>
    public static class GunCommands
    {
        public const string ModFolder = "recharge.gun";
        public static readonly string[] Guns = { "Pistol", "Blaster", "Shotgun", "Ray gun", "Rocket launcher" };
        public const int MaxRecoilPercent = 10000;

        public static void Register(CommandRegistry registry) => Register(registry, GameFinder.Find, GameProcess.IsRunning);

        public static void Register(CommandRegistry registry, Func<string?> game, Func<string, bool> running)
        {
            registry.Register("gun.settings", args => Task.FromResult<JsonNode>(Read(Need(game()), running)));
            registry.Register("gun.setSettings", args => Task.FromResult<JsonNode>(Write(Need(game()), args, running)));
            registry.Register("gun.relock", args => Task.FromResult<JsonNode>(Relock(Need(game()), args, running)));
        }

        private static string Need(string? game) => game ?? throw new InvalidOperationException("IGTAP wasn't found");
        private static string DataDir(string game) => Path.Combine(game, "Recharge", "Mods", ModFolder, "data");
        public static string ConfigPath(string game) => Path.Combine(DataDir(game), "config.json");
        public static string UnlocksPath(string game) => Path.Combine(DataDir(game), "unlocks.json");
        private static bool Installed(string game) => File.Exists(Path.Combine(game, "Recharge", "Mods", ModFolder, "mod.json"));

        private static JsonObject ReadObject(string path)
        {
            if (!File.Exists(path)) return new JsonObject();
            try { return JsonReader.Parse(File.ReadAllText(path)) as JsonObject ?? new JsonObject(); }
            catch (Exception) { return new JsonObject(); } // the mod itself falls back to defaults on an unreadable file
        }

        private static bool Bool(JsonObject o, string key, bool dflt) => o.TryGetValue(key, out JsonNode n) && n is JsonBool b ? b.Value : dflt;

        public static JsonObject Read(string game, Func<string, bool> running)
        {
            var r = new JsonObject();
            bool installed = Installed(game);
            r["installed"] = installed ? JsonBool.True : JsonBool.False;
            r["running"] = running(game) ? JsonBool.True : JsonBool.False;
            r["appliesOn"] = new JsonString("the next time IGTAP starts");
            var guns = new JsonArray();
            foreach (string g in Guns) guns.Add(new JsonString(g));
            r["guns"] = guns;
            var cfg = ReadObject(ConfigPath(game));
            var s = new JsonObject();
            s["enabled"] = Bool(cfg, "Enabled", true) ? JsonBool.True : JsonBool.False;
            string gun = cfg.TryGetValue("GunName", out JsonNode gn) && gn is JsonString gs ? gs.Value : "Pistol";
            s["gun"] = new JsonString(Array.Exists(Guns, x => x == gun) ? gun : "Pistol");
            s["breakTiles"] = Bool(cfg, "BreakTiles", true) ? JsonBool.True : JsonBool.False;
            s["leftMouseFires"] = Bool(cfg, "LeftMouseFires", true) ? JsonBool.True : JsonBool.False;
            double recoil = cfg.TryGetValue("RecoilStrength", out JsonNode rn) && rn is JsonNumber rnum ? rnum.AsDouble() : 1.0;
            s["recoilPercent"] = JsonNumber.From((long)Math.Max(0, Math.Min(MaxRecoilPercent, Math.Round(recoil * 100))));
            r["settings"] = s;
            var unlocks = new JsonObject();
            foreach (var kv in ReadObject(UnlocksPath(game))) if (kv.Value is JsonBool b) unlocks[kv.Key] = b;
            r["unlocks"] = unlocks;
            return r;
        }

        public static JsonObject Write(string game, JsonObject args, Func<string, bool> running)
        {
            if (!Installed(game)) throw new InvalidOperationException("the Gun mod isn't installed");
            // validate everything first, so a bad value changes nothing
            bool? enabled = OptBool(args, "enabled"), breakTiles = OptBool(args, "breakTiles"), left = OptBool(args, "leftMouseFires");
            string? gun = null;
            if (args.TryGetValue("gun", out JsonNode g))
            {
                gun = g is JsonString gs ? Array.Find(Guns, x => string.Equals(x, gs.Value, StringComparison.OrdinalIgnoreCase)) : null;
                if (gun == null) throw new ArgumentException("gun must be one of: " + string.Join(", ", Guns));
            }
            long? pct = null;
            if (args.TryGetValue("recoilPercent", out JsonNode p))
            {
                if (!(p is JsonNumber pn) || double.IsNaN(pn.AsDouble()) || pn.AsDouble() != Math.Floor(pn.AsDouble()) || pn.AsDouble() < 0 || pn.AsDouble() > MaxRecoilPercent)
                    throw new ArgumentException("recoilPercent must be a whole number from 0 to " + MaxRecoilPercent);
                pct = pn.AsInt64();
            }
            if (running(game)) throw new InvalidOperationException("IGTAP is running - Gun settings apply the next time it starts, so close the game first.");

            Directory.CreateDirectory(DataDir(game));
            string path = ConfigPath(game);
            var cfg = ReadObject(path); // every other field (fire rate, bullet speed, ...) stays as it is
            if (enabled.HasValue) cfg["Enabled"] = enabled.Value ? JsonBool.True : JsonBool.False;
            if (breakTiles.HasValue) cfg["BreakTiles"] = breakTiles.Value ? JsonBool.True : JsonBool.False;
            if (left.HasValue) cfg["LeftMouseFires"] = left.Value ? JsonBool.True : JsonBool.False;
            if (gun != null) cfg["GunName"] = new JsonString(gun);
            if (pct.HasValue) cfg["RecoilStrength"] = JsonNumber.From(pct.Value / 100.0);
            AtomicWrite(path, JsonWriter.Write(cfg, 2));
            return Read(game, running);
        }

        public static JsonObject Relock(string game, JsonObject args, Func<string, bool> running)
        {
            if (!Installed(game)) throw new InvalidOperationException("the Gun mod isn't installed");
            string slot = args.TryGetValue("slot", out JsonNode sn) && sn is JsonString ss && ss.Value.Length > 0 ? ss.Value : "base";
            if (running(game)) throw new InvalidOperationException("IGTAP is running - close the game before re-locking the gun.");
            string path = UnlocksPath(game);
            if (!File.Exists(path)) throw new InvalidOperationException("the gun isn't unlocked anywhere yet");
            var unlocks = ReadObject(path);
            var relocked = new JsonArray();
            foreach (string key in new System.Collections.Generic.List<string>(unlocks.Keys))
            {
                if (slot != "all" && key != slot) continue;
                if (unlocks[key] is JsonBool b && b.Value) { unlocks[key] = JsonBool.False; relocked.Add(new JsonString(key)); }
            }
            var result = new JsonObject();
            result["relocked"] = relocked;
            if (relocked.Count == 0) { result["backup"] = JsonNull.Instance; return result; }
            string backup = path + ".bak-" + DateTime.Now.ToString("yyyyMMdd-HHmmss");
            for (int n = 2; File.Exists(backup); n++) backup = path + ".bak-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + n;
            File.Copy(path, backup, false);
            AtomicWrite(path, JsonWriter.Write(unlocks, 2));
            result["backup"] = new JsonString(Path.GetFileName(backup));
            return result;
        }

        private static bool? OptBool(JsonObject a, string key)
        {
            if (!a.TryGetValue(key, out JsonNode n)) return null;
            return n is JsonBool b ? b.Value : throw new ArgumentException(key + " must be true or false");
        }

        private static void AtomicWrite(string path, string text)
        {
            string tmp = path + ".rn-tmp";
            File.WriteAllText(tmp, text + "\n");
            File.Move(tmp, path, true);
        }
    }
}

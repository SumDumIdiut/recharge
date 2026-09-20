using System;
using System.Collections.Generic;
using Recharge.ModApi;

// Nested objects, lists, dictionaries, enums, and a schema-version-driven
// migration so the config's shape can change across mod versions.
internal static class LoggingConfigDemo
{
    internal enum Difficulty
    {
        Easy,
        Normal,
        Hard,
    }

    internal class KeybindConfig
    {
        public string Action;
        public string Key;
    }

    internal class ExtendedConfig
    {
        public int SchemaVersion = 2;
        public Difficulty Difficulty = Difficulty.Normal;
        public List<string> FavoriteMaps = new List<string>();
        public Dictionary<string, int> MapPlayCounts = new Dictionary<string, int>();

        public List<KeybindConfig> Keybinds = new List<KeybindConfig>
        {
            new KeybindConfig { Action = "Dash", Key = "LeftShift" },
            new KeybindConfig { Action = "Reset", Key = "R" },
        };

        // Only present in configs written by a pre-2.0 build of this mod -
        // read once during migration below, then never touched again.
        public string LegacyDifficultyName;
    }

    public static ExtendedConfig LoadAndMigrate(IRechargeHost host, string modId)
    {
        var config = host.LoadConfig<ExtendedConfig>(modId, "extended-config.json");

        if (config.SchemaVersion < 2 && !string.IsNullOrEmpty(config.LegacyDifficultyName))
        {
            if (Enum.TryParse<Difficulty>(config.LegacyDifficultyName, true, out var parsed))
                config.Difficulty = parsed;
            config.LegacyDifficultyName = null;
            config.SchemaVersion = 2;
            host.SaveConfig(modId, config, "extended-config.json");
            host.Log("Migrated extended-config.json from schema v1 to v2.");
        }

        host.Log($"Difficulty: {config.Difficulty}, {config.Keybinds.Count} keybind(s), {config.MapPlayCounts.Count} map(s) with play counts.");
        return config;
    }

    public static void RecordMapPlayed(IRechargeHost host, string modId, ExtendedConfig config, string mapName)
    {
        config.MapPlayCounts.TryGetValue(mapName, out var count);
        config.MapPlayCounts[mapName] = count + 1;
        if (!config.FavoriteMaps.Contains(mapName) && config.MapPlayCounts[mapName] >= 3)
            config.FavoriteMaps.Add(mapName);
        host.SaveConfig(modId, config, "extended-config.json");
    }

    public static void CycleDifficulty(IRechargeHost host, string modId, ExtendedConfig config)
    {
        var next = (int)config.Difficulty + 1;
        config.Difficulty = (Difficulty)(next % Enum.GetValues(typeof(Difficulty)).Length);
        host.SaveConfig(modId, config, "extended-config.json");
        host.Log($"Difficulty is now {config.Difficulty}.");
    }
}

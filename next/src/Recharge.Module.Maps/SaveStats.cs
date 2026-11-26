using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace Recharge.Module.Maps;

// Reads a save's player data into human-readable lines for the details popup.
// Everything here is best-effort: a save with missing or odd fields still
// produces a sensible block rather than throwing.
internal static class SaveStats
{
    public static List<string> Read(SaveEntry entry)
    {
        var lines = new List<string>();
        var meta = entry.Metadata;
        if (meta != null)
        {
            lines.Add("Map: " + (string.IsNullOrWhiteSpace(meta.MapName) ? meta.MapId : meta.MapName));
            lines.Add("Created: " + Local(meta.Created));
            lines.Add("Last saved: " + (meta.Saved.HasValue ? Local(meta.Saved.Value) : "never"));
        }

        var data = ReadPlayer(entry);
        if (data == null)
        {
            lines.Add("");
            lines.Add("No player data yet — this save hasn't been played.");
            return lines;
        }

        lines.Add("");
        if (data["_respawnPoint"] is JObject point && point["x"] != null && point["y"] != null)
            lines.Add("Position: " + Coord(point["x"]) + ", " + Coord(point["y"]));
        if (data["_currentZone"] != null && data["_currentZone"].Type != JTokenType.Null)
            lines.Add("Zone: " + data["_currentZone"]);
        if (data["_vmanScore"] is JToken score && IsNumber(score))
            lines.Add("V-man score: " + Abbreviate(score));

        var abilities = new List<string>();
        void Ability(string key, string label) { if (Flag(data, key)) abilities.Add(label); }
        Ability("_dashUnlocked", "Dash");
        Ability("_airJumpUnlocked", "Air jump");
        Ability("_wallJumpUnlocked", "Wall jump");
        Ability("_omniDashUnlocked", "Omni dash");
        Ability("_blockSwapUnlocked", "Block swap");
        if (abilities.Count > 0) lines.Add("Abilities: " + string.Join(", ", abilities));

        if (data["_currencies"] is JArray currencies && currencies.Count > 0)
        {
            lines.Add("");
            lines.Add("Currencies:");
            foreach (var token in currencies.OfType<JObject>())
            {
                if (!(token["_Key"] is JToken keyToken) || keyToken.Type != JTokenType.Integer) continue;
                lines.Add("  " + CurrencyName(keyToken.Value<int>()) + ": " + Abbreviate(token["_Value"]));
            }
        }
        return lines;
    }

    private static JObject ReadPlayer(SaveEntry entry)
        => ReadJson(Path.Combine(entry.Path, SaveLibrary.Primary))
           ?? ReadJson(Path.Combine(entry.Path, SaveLibrary.Backup));

    private static JObject ReadJson(string folder)
    {
        try
        {
            var file = Path.Combine(folder, "playerdata.txt");
            if (!File.Exists(file)) return null;
            return JObject.Parse(File.ReadAllText(file));
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
        catch (Newtonsoft.Json.JsonException) { return null; }
    }

    private static Type _currencyEnum;
    private static bool _currencyEnumChecked;

    private static string CurrencyName(int key)
    {
        if (!_currencyEnumChecked)
        {
            _currencyEnumChecked = true;
            // globalStats.Currencies lives in the game assembly; the Maps module
            // already references it, but resolve by name so a missing or renamed
            // enum just falls back to a numbered label instead of failing to load.
            _currencyEnum = Type.GetType("globalStats+Currencies, Assembly-CSharp");
        }
        if (_currencyEnum != null && Enum.IsDefined(_currencyEnum, key))
        {
            var name = Enum.GetName(_currencyEnum, key);
            if (!string.IsNullOrEmpty(name)) return Spaced(name);
        }
        return "Currency " + key;
    }

    // "AstralDust" -> "Astral Dust" so enum names read as labels.
    private static string Spaced(string name)
    {
        var sb = new System.Text.StringBuilder(name.Length + 4);
        for (int i = 0; i < name.Length; i++)
        {
            if (i > 0 && char.IsUpper(name[i]) && !char.IsUpper(name[i - 1])) sb.Append(' ');
            sb.Append(name[i]);
        }
        return sb.ToString();
    }

    private static bool Flag(JObject data, string key)
        => data[key] is JToken t && (t.Type == JTokenType.Boolean ? t.Value<bool>()
            : t.Type == JTokenType.Integer && t.Value<int>() != 0);

    private static bool IsNumber(JToken value) => value != null
        && (value.Type == JTokenType.Integer || value.Type == JTokenType.Float);

    private static string Coord(JToken value)
        => IsNumber(value) ? value.Value<double>().ToString("0", CultureInfo.InvariantCulture) : "?";

    // Save values span from small counts to absurd incremental-game numbers
    // (and the occasional NaN from a wiped field), so abbreviate for display.
    private static string Abbreviate(JToken value)
    {
        if (!IsNumber(value)) return "—";
        double n = value.Value<double>();
        if (double.IsNaN(n)) return "—";
        if (double.IsInfinity(n)) return n > 0 ? "∞" : "-∞";
        if (n == 0) return "0";
        bool negative = n < 0;
        n = Math.Abs(n);
        string result;
        if (n < 1000) result = n.ToString(n < 10 ? "0.##" : "0", CultureInfo.InvariantCulture);
        else
        {
            string[] suffixes = { "", "K", "M", "B", "T", "q", "Q", "s", "S", "O", "N", "D" };
            int tier = (int)Math.Floor(Math.Log10(n) / 3);
            if (tier < suffixes.Length)
                result = (n / Math.Pow(1000, tier)).ToString("0.##", CultureInfo.InvariantCulture) + suffixes[tier];
            else
                result = n.ToString("0.###E+0", CultureInfo.InvariantCulture);
        }
        return negative ? "-" + result : result;
    }

    private static string Local(DateTime utc)
        => utc.ToLocalTime().ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);
}

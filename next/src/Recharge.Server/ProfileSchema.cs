using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Recharge.Server
{
    /// <summary>
    /// The extended profile: a versioned JSON document with a strict schema. Every value is checked against a whitelist (an enum,
    /// a #rrggbb colour, a bounded integer, a bounded string, an https URL or an id pattern); unknown fields and anything that
    /// does not fit are refused, never repaired. Nothing in a stored profile can carry CSS or markup, and the UI draws only from
    /// these value types. The canonical result has every field present, in a fixed order.
    /// </summary>
    public static class ProfileSchema
    {
        public const int Version = 1;
        /// <summary>The most a stored profile may take.</summary>
        public const int MaxBytes = 16 * 1024;

        public static readonly string[] SectionIds = { "about", "showcase", "uploads", "stats", "links", "friends", "activity" };
        public static readonly string[] StatIds = { "uploads", "threads", "replies", "comments", "friends", "played" };
        /// <summary>Every avatar frame the app can draw (the hub's ids). Anything else is refused.</summary>
        public static readonly string[] FrameIds = { "none", "s-ring", "s-thick", "s-double", "s-inner", "s-gradient", "s-half", "s-stripes", "s-dashed", "s-dotted", "s-segments", "s-square", "s-pixel", "s-pixel-duo", "s-spin-arc", "s-spin-comet", "s-spin-dashed", "s-spin-segments", "s-spin-gradient", "g-rainbow", "g-holo", "g-gilded", "g-quarters", "g-fire", "spin-rainbow-spin", "pixel-rainbow", "green", "ring-red", "ring-violet", "ring-ink", "pixel-gold", "gold", "neon", "pixel", "ring-orange", "ring-yellow", "ring-cyan", "ring-blue", "ring-magenta", "ring-pink", "ring-white", "ring-silver", "ring-lime", "square-green", "square-violet", "square-red", "pixel-blue", "pixel-pink", "pixel-white", "duo-mint-sky", "duo-frost", "duo-ember", "duo-berry", "duo-dusk", "duo-royal", "g-aurora", "g-sunset", "g-ice", "g-toxic", "g-ocean", "g-candy", "g-bee", "g-zebra", "g-dashed", "g-dotted", "g-segments", "g-half", "spin-aurora-spin", "spin-dashed-spin", "spin-arc-spin", "spin-comet-spin", "spin-segments-spin", "double", "x-flipped-signature", "x-flipped-frost" };
        public static readonly string[] ItemKinds = { "map", "mod", "skin", "background", "playlist", "game" };

        private static readonly Regex HexRe = new Regex("^#[0-9a-fA-F]{6}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex IdRe = new Regex("^[A-Za-z0-9._-]{1,64}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex PresetRe = new Regex("^[a-z0-9-]{1,32}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex UrlRe = new Regex("^https://[^\\s<>\"'`\\\\{}|^]{1,192}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        // ---- the schema ----

        private abstract class Node
        {
            public abstract JsonNode? Check(JsonElement v, string path);
            public abstract JsonNode? Default();
        }

        private static SocialException Bad(string path, string why) => new SocialException(400, "profile." + path + ": " + why);

        private sealed class Obj : Node
        {
            public readonly List<(string Name, Node Node)> Fields = new List<(string, Node)>();
            public Obj Add(string name, Node node) { Fields.Add((name, node)); return this; }

            public override JsonNode? Check(JsonElement v, string path)
            {
                if (v.ValueKind != JsonValueKind.Object) throw Bad(path, "must be an object");
                foreach (JsonProperty p in v.EnumerateObject())
                {
                    if (!Fields.Any(f => f.Name == p.Name)) throw Bad(path, "unknown field \"" + Clip(p.Name) + "\"");
                }
                var result = new JsonObject();
                foreach ((string name, Node node) in Fields)
                {
                    string sub = path.Length == 0 ? name : path + "." + name;
                    result[name] = v.TryGetProperty(name, out JsonElement child) ? node.Check(child, sub) : node.Default();
                }
                return result;
            }

            public override JsonNode? Default()
            {
                var result = new JsonObject();
                foreach ((string name, Node node) in Fields) result[name] = node.Default();
                return result;
            }
        }

        private sealed class Enum : Node
        {
            private readonly string[] _values;
            private readonly string _default;
            public Enum(string def, params string[] values) { _default = def; _values = values; }
            public override JsonNode? Check(JsonElement v, string path)
            {
                if (v.ValueKind != JsonValueKind.String || Array.IndexOf(_values, v.GetString()) < 0) throw Bad(path, _values.Length > 12 ? "is not a known choice" : "must be one of " + string.Join(", ", _values));
                return JsonValue.Create(v.GetString());
            }
            public override JsonNode? Default() => JsonValue.Create(_default);
        }

        private sealed class Hex : Node
        {
            private readonly string _default;
            public Hex(string def) { _default = def; }
            public override JsonNode? Check(JsonElement v, string path)
            {
                if (v.ValueKind != JsonValueKind.String || !HexRe.IsMatch(v.GetString()!)) throw Bad(path, "must be a #rrggbb colour");
                return JsonValue.Create(v.GetString()!.ToLowerInvariant());
            }
            public override JsonNode? Default() => JsonValue.Create(_default);
        }

        private sealed class Int : Node
        {
            private readonly int _min, _max, _default;
            public Int(int def, int min, int max) { _default = def; _min = min; _max = max; }
            public override JsonNode? Check(JsonElement v, string path)
            {
                if (v.ValueKind != JsonValueKind.Number || !v.TryGetInt64(out long n) || n < _min || n > _max) throw Bad(path, "must be a whole number from " + _min + " to " + _max);
                return JsonValue.Create(n);
            }
            public override JsonNode? Default() => JsonValue.Create((long)_default);
        }

        private sealed class Bool : Node
        {
            private readonly bool _default;
            public Bool(bool def) { _default = def; }
            public override JsonNode? Check(JsonElement v, string path)
            {
                if (v.ValueKind != JsonValueKind.True && v.ValueKind != JsonValueKind.False) throw Bad(path, "must be true or false");
                return JsonValue.Create(v.GetBoolean());
            }
            public override JsonNode? Default() => JsonValue.Create(_default);
        }

        private sealed class Text : Node
        {
            private readonly int _max;
            private readonly bool _multiline;
            public Text(int max, bool multiline = false) { _max = max; _multiline = multiline; }
            public override JsonNode? Check(JsonElement v, string path)
            {
                if (v.ValueKind != JsonValueKind.String) throw Bad(path, "must be text");
                return JsonValue.Create(CleanText(v.GetString()!, _max, _multiline, path));
            }
            public override JsonNode? Default() => JsonValue.Create("");
        }

        /// <summary>A string matching a pattern (ids).</summary>
        private sealed class Pattern : Node
        {
            private readonly Regex _re;
            private readonly string _what;
            public Pattern(Regex re, string what) { _re = re; _what = what; }
            public override JsonNode? Check(JsonElement v, string path)
            {
                if (v.ValueKind != JsonValueKind.String || !_re.IsMatch(v.GetString()!)) throw Bad(path, "must be " + _what);
                return JsonValue.Create(v.GetString());
            }
            public override JsonNode? Default() => JsonValue.Create("");
        }

        private sealed class Url : Node
        {
            public override JsonNode? Check(JsonElement v, string path)
            {
                string? s = v.ValueKind == JsonValueKind.String ? v.GetString() : null;
                if (s is null || !UrlRe.IsMatch(s) || !Uri.TryCreate(s, UriKind.Absolute, out Uri? u) || u.Scheme != Uri.UriSchemeHttps
                    || string.IsNullOrEmpty(u.Host) || !string.IsNullOrEmpty(u.UserInfo) || !u.Host.Contains('.'))
                    throw Bad(path, "must be an https:// link");
                return JsonValue.Create(s);
            }
            public override JsonNode? Default() => JsonValue.Create("");
        }

        private sealed class Nullable : Node
        {
            private readonly Node _inner;
            public Nullable(Node inner) { _inner = inner; }
            public override JsonNode? Check(JsonElement v, string path) => v.ValueKind == JsonValueKind.Null ? null : _inner.Check(v, path);
            public override JsonNode? Default() => null;
        }

        private sealed class Arr : Node
        {
            private readonly Node _item;
            private readonly int _min, _max;
            private readonly bool _unique;
            private readonly string[] _default;
            public Arr(Node item, int min, int max, bool unique = false, params string[] def) { _item = item; _min = min; _max = max; _unique = unique; _default = def; }
            public override JsonNode? Check(JsonElement v, string path)
            {
                if (v.ValueKind != JsonValueKind.Array) throw Bad(path, "must be a list");
                int n = v.GetArrayLength();
                if (n < _min || n > _max) throw Bad(path, "must have " + _min + " to " + _max + " entries");
                var result = new JsonArray();
                var seen = new HashSet<string>(StringComparer.Ordinal);
                int i = 0;
                foreach (JsonElement e in v.EnumerateArray())
                {
                    JsonNode? item = _item.Check(e, path + "[" + i++ + "]");
                    if (_unique && item is not null && !seen.Add(item.ToJsonString())) throw Bad(path, "must not repeat an entry");
                    result.Add(item);
                }
                return result;
            }
            public override JsonNode? Default()
            {
                var result = new JsonArray();
                foreach (string d in _default) result.Add(JsonValue.Create(d));
                return result;
            }
        }

        private static readonly Obj Root = Build();

        private static Obj Build()
        {
            var link = new Obj().Add("url", new Url()).Add("label", new Text(30));
            var item = new Obj().Add("kind", new Enum("map", ItemKinds)).Add("id", new Pattern(IdRe, "an id")).Add("name", new Text(60));
            var featured = new Obj().Add("kind", new Enum("map", ItemKinds)).Add("id", new Pattern(IdRe, "an id")).Add("name", new Text(60)).Add("note", new Text(120));
            var section = new Obj().Add("id", new Enum("about", SectionIds)).Add("on", new Bool(true));
            var defaultSections = new JsonArray();
            return new Obj()
                .Add("v", new Int(Version, Version, Version))
                .Add("name", new Obj()
                    .Add("mode", new Enum("default", "default", "solid", "gradient"))
                    .Add("colors", new Arr(new Hex("#41f88d"), 1, 4, false, "#41f88d", "#c63ed8"))
                    .Add("angle", new Int(90, 0, 360))
                    .Add("effects", new Arr(new Enum("glow", "shimmer", "glow", "outline", "pixel", "rainbow", "pulse"), 0, 6, true))
                    .Add("effectColor", new Nullable(new Hex("#41f88d")))
                    .Add("font", new Enum("vt323", "vt323", "mono", "sans", "serif", "rounded", "typewriter"))
                    .Add("weight", new Enum("normal", "normal", "bold", "heavy"))
                    .Add("spacing", new Enum("normal", "tight", "normal", "wide", "wider")))
                .Add("avatar", new Obj()
                    .Add("shape", new Enum("circle", "circle", "squircle", "hex", "diamond"))
                    .Add("frame", new Enum("none", FrameIds))
                    .Add("frameColors", new Arr(new Hex("#41f88d"), 0, 2))
                    .Add("ornament", new Enum("none", "none", "crown", "halo", "ears", "horns", "sparkles", "antenna", "wreath", "flame", "star"))
                    .Add("ornamentColor", new Nullable(new Hex("#e8c14b")))
                    .Add("glow", new Enum("none", "none", "soft", "neon"))
                    .Add("zoom", new Int(100, 100, 300))
                    .Add("x", new Int(50, 0, 100))
                    .Add("y", new Int(50, 0, 100))
                    .Add("status", new Enum("dot", "none", "dot", "ring", "pixel", "pulse", "bar")))
                .Add("banner", new Obj()
                    .Add("mode", new Enum("color", "color", "gradient", "image"))
                    .Add("colors", new Arr(new Hex("#1f3a2a"), 1, 3, false, "#1f3a2a", "#c63ed8"))
                    .Add("angle", new Int(135, 0, 360))
                    .Add("imgX", new Int(50, 0, 100))
                    .Add("imgY", new Int(50, 0, 100))
                    .Add("imgZoom", new Int(100, 100, 300))
                    .Add("pattern", new Enum("none", "none", "grid", "dots", "scanlines", "stars", "hex"))
                    .Add("anim", new Enum("none", "none", "stars", "aurora", "sweep", "signature", "frostfall"))
                    .Add("dim", new Int(0, 0, 80))
                    .Add("tint", new Nullable(new Hex("#000000")))
                    .Add("height", new Enum("normal", "slim", "normal", "tall", "hero")))
                .Add("theme", new Obj()
                    .Add("accent", new Nullable(new Hex("#c63ed8")))
                    .Add("card", new Enum("glass", "glass", "solid", "gradient", "pattern"))
                    .Add("bg", new Enum("none", "none", "color", "gradient", "grid", "dots", "stars", "aurora"))
                    .Add("bgColors", new Arr(new Hex("#101a14"), 1, 2, false, "#101a14", "#1f3a2a"))
                    .Add("corner", new Enum("soft", "sharp", "soft", "round", "pixel"))
                    .Add("preset", new Nullable(new Pattern(PresetRe, "a preset id"))))
                .Add("content", new Obj()
                    .Add("status", new Obj().Add("emoji", new Text(16)).Add("text", new Text(60)).Add("expires", new Int(0, 0, int.MaxValue)))
                    .Add("bio", new Text(600, true))
                    .Add("pronouns", new Text(20))
                    .Add("links", new Arr(link, 0, 8))
                    .Add("showcase", new Arr(item, 0, 6))
                    .Add("featured", new Nullable(featured)))
                .Add("sections", new Sections(section, defaultSections))
                .Add("stats", new Obj()
                    .Add("show", new Arr(new Enum("uploads", StatIds), 0, 6, true, "uploads", "threads", "replies", "comments"))
                    .Add("style", new Enum("chips", "chips", "big", "minimal")))
                .Add("privacy", new Obj()
                    .Add("profile", new Enum("everyone", "everyone", "friends"))
                    .Add("friends", new Enum("everyone", "everyone", "friends", "nobody"))
                    .Add("presence", new Enum("friends", "friends", "nobody")));
        }

        /// <summary>The section list: every id exactly once, in the owner's order; ids left out are appended switched on.</summary>
        private sealed class Sections : Node
        {
            private readonly Obj _section;
            public Sections(Obj section, JsonArray unused) { _section = section; }
            public override JsonNode? Check(JsonElement v, string path)
            {
                if (v.ValueKind != JsonValueKind.Array || v.GetArrayLength() > SectionIds.Length) throw Bad(path, "must be a list of sections");
                var result = new JsonArray();
                var seen = new HashSet<string>(StringComparer.Ordinal);
                int i = 0;
                foreach (JsonElement e in v.EnumerateArray())
                {
                    var one = (JsonObject)_section.Check(e, path + "[" + i++ + "]")!;
                    if (!seen.Add(one["id"]!.GetValue<string>())) throw Bad(path, "must not repeat a section");
                    result.Add(one);
                }
                foreach (string id in SectionIds)
                {
                    if (seen.Contains(id)) continue;
                    result.Add(new JsonObject { ["id"] = id, ["on"] = true });
                }
                return result;
            }
            public override JsonNode? Default()
            {
                var result = new JsonArray();
                foreach (string id in SectionIds) result.Add(new JsonObject { ["id"] = id, ["on"] = id != "friends" && id != "activity" });
                return result;
            }
        }

        // ---- text ----

        private static string Clip(string s) => s.Length > 24 ? s.Substring(0, 24) + "..." : s;

        /// <summary>Normalises line ends, refuses control and direction-override characters, trims, and measures.</summary>
        public static string CleanText(string value, int max, bool multiline, string path)
        {
            string s = value.Replace("\r\n", "\n").Replace('\r', '\n');
            foreach (char c in s)
            {
                bool control = c < 0x20 || c == 0x7f || (c >= 0x80 && c < 0xa0);
                if (c == '\n' && multiline) control = false;
                if (control || (c >= (char)0x2028 && c <= (char)0x2029) || (c >= (char)0x202a && c <= (char)0x202e) || (c >= (char)0x2066 && c <= (char)0x2069) || c == (char)0x200e || c == (char)0x200f || c == (char)0xfeff)
                    throw Bad(path, "has a character that is not allowed");
            }
            s = s.Trim();
            if (new StringInfo(s).LengthInTextElements > max || s.Length > max * 4) throw Bad(path, "is too long (at most " + max + " characters)");
            return s;
        }

        // ---- entry points ----

        /// <summary>The profile with every field at its default.</summary>
        public static JsonObject Defaults() => (JsonObject)Root.Default()!;

        /// <summary>Validates a submitted profile and returns it in canonical form; throws SocialException(400/413) when anything is wrong.</summary>
        public static JsonObject Validate(JsonElement body)
        {
            if (body.ValueKind != JsonValueKind.Object) throw new SocialException(400, "profile: must be an object");
            if (body.GetRawText().Length > MaxBytes) throw new SocialException(413, "That profile is too large.");
            var canon = (JsonObject)Root.Check(body, "")!;
            var name = (JsonObject)canon["name"]!;
            if (name["mode"]!.GetValue<string>() == "gradient" && ((JsonArray)name["colors"]!).Count < 2) throw Bad("name.colors", "a gradient needs at least 2 colours");
            var banner = (JsonObject)canon["banner"]!;
            if (banner["mode"]!.GetValue<string>() == "gradient" && ((JsonArray)banner["colors"]!).Count < 2) throw Bad("banner.colors", "a gradient needs at least 2 colours");
            var status = (JsonObject)((JsonObject)canon["content"]!)["status"]!;
            long expires = status["expires"]!.GetValue<long>();
            if (expires > 0 && expires > DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 400L * 86400) throw Bad("content.status.expires", "is too far ahead");
            if (Encoding.UTF8.GetByteCount(canon.ToJsonString()) > MaxBytes) throw new SocialException(413, "That profile is too large (at most 16 KB).");
            return canon;
        }
    }
}

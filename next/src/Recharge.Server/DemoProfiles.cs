using System.Collections.Generic;
using System.Text.Json;

namespace Recharge.Server
{
    /// <summary>Sample hub data and six differently styled profiles for the demo server (snapshots). Never used by the real server.</summary>
    internal static class DemoProfiles
    {
        private static readonly string[] Names = { "oliver", "Maya", "jonas", "priya", "sam", "Kit", "Flipped" };

        private static Dictionary<string, object> Upload(string id, string kind, string name, string version, string when) =>
            new Dictionary<string, object> { ["id"] = id, ["kind"] = kind, ["name"] = name, ["version"] = version, ["createdAt"] = when, ["gallery"] = new string[0] };

        private static object Author(string name, string? color = null, string frame = "none", string[]? colors = null) =>
            new Dictionary<string, object?> { ["username"] = name, ["avatar_url"] = null, ["frame"] = frame, ["frame_colors"] = colors ?? new string[0], ["name_color"] = color };

        public static void SeedHub(FakeHub hub)
        {
            var uploads = new Dictionary<string, object[]>
            {
                ["oliver"] = new object[] { Upload("map-cliffside", "map", "Cliffside Run", "1.2", "2026-09-10T10:00:00Z"), Upload("skin-neon", "skin", "Neon Courier", "1.0", "2026-08-02T10:00:00Z"), Upload("mod-ghost", "mod", "Ghost Replays", "0.9", "2026-07-21T10:00:00Z") },
                ["Maya"] = new object[] { Upload("map-sunset", "map", "Sunset Sprint", "2.0", "2026-09-30T10:00:00Z") },
                ["jonas"] = new object[] { Upload("map-arcade", "map", "Arcade Alley", "1.4", "2026-06-11T10:00:00Z"), Upload("map-tower", "map", "Tower Climb", "1.0", "2026-05-01T10:00:00Z") },
                ["priya"] = new object[0], ["sam"] = new object[] { Upload("skin-mono", "skin", "Monochrome", "1.1", "2026-04-04T10:00:00Z") }, ["Kit"] = new object[0], ["Flipped"] = new object[] { Upload("map-cliffside", "map", "Cliffside Run", "1.2", "2026-09-10T10:00:00Z") },
            };
            var counts = new Dictionary<string, int[]> { ["oliver"] = new[] { 14, 52, 31 }, ["Maya"] = new[] { 6, 33, 12 }, ["jonas"] = new[] { 9, 20, 40 }, ["priya"] = new[] { 3, 18, 7 }, ["sam"] = new[] { 1, 4, 2 }, ["Kit"] = new[] { 0, 2, 1 }, ["Flipped"] = new[] { 21, 64, 48 } };
            var bio = new Dictionary<string, string> { ["oliver"] = "Map maker and Recharge tinkerer.", ["Maya"] = "Speedrunner.", ["jonas"] = "Pixel art and tricky jumps.", ["priya"] = "Mods and shaders.", ["sam"] = "", ["Kit"] = "", ["Flipped"] = "Recharge." };
            foreach (string n in Names)
            {
                hub.UserData(n, new Dictionary<string, object>
                {
                    ["bio"] = bio[n], ["created_at"] = "2026-03-14T10:00:00Z", ["uploads"] = uploads[n],
                    ["post_count"] = counts[n][0], ["reply_count"] = counts[n][1], ["comment_count"] = counts[n][2],
                });
            }
            hub.Page("/api/users", new Dictionary<string, object>
            {
                ["total"] = Names.Length,
                ["users"] = new List<object>
                {
                    Merge(Author("oliver"), "created_at", "2026-03-14T10:00:00Z"), Merge(Author("Maya"), "created_at", "2026-03-14T10:00:00Z"), Merge(Author("jonas"), "created_at", "2026-03-14T10:00:00Z"),
                    Merge(Author("priya"), "created_at", "2026-03-14T10:00:00Z"), Merge(Author("sam"), "created_at", "2026-03-14T10:00:00Z"), Merge(Author("Kit"), "created_at", "2026-03-14T10:00:00Z"), Merge(Author("Flipped"), "created_at", "2026-03-14T10:00:00Z"),
                },
            });
            object Thread(int id, string title, string cat, string who, string excerpt, int replies) => new Dictionary<string, object>
            {
                ["id"] = id, ["title"] = title, ["category"] = cat, ["status"] = "open", ["pinned"] = false, ["excerpt"] = excerpt, ["image_count"] = 0, ["reply_count"] = replies,
                ["created_at"] = "2026-10-20T10:00:00Z", ["last_activity_at"] = "2026-10-28T10:00:00Z", ["author"] = Author(who),
            };
            hub.Page("/api/forum", new Dictionary<string, object>
            {
                ["page"] = 1, ["pages"] = 1, ["total"] = 6,
                ["posts"] = new List<object>
                {
                    Thread(1, "Best way to learn wall jumps?", "question", "Maya", "I keep losing speed on the second jump.", 8),
                    Thread(2, "Arcade Alley 1.4 released", "suggestion", "jonas", "New checkpoint system and a pixel-perfect finale.", 5),
                    Thread(3, "Shader pack flickers on Linux", "bug", "priya", "Only on the aurora preset, with the overlay on.", 3),
                    Thread(4, "Cliffside Run feedback", "issue", "oliver", "Is the second checkpoint too far from the cliff?", 11),
                    Thread(5, "Monochrome skin on dark maps", "question", "sam", "Hard to see on some backgrounds.", 2),
                    Thread(6, "Lava level ideas", "suggestion", "Kit", "Rising lava for a survival map?", 6),
                },
            });
        }

        private static object Merge(object author, string key, string value)
        {
            var d = new Dictionary<string, object?>((Dictionary<string, object?>)author) { [key] = value, ["uploads"] = new Dictionary<string, object>() };
            return d;
        }

        private static readonly Dictionary<string, string> Looks = new Dictionary<string, string>
        {
            ["oliver"] = """
            {"name":{"mode":"gradient","colors":["#ff4fd8","#4dd8ff"],"angle":90,"effects":["glow","shimmer"],"font":"vt323","weight":"bold","spacing":"wide"},
             "avatar":{"shape":"hex","frame":"s-spin-gradient","frameColors":["#ff4fd8","#4dd8ff"],"ornament":"crown","ornamentColor":"#ffe14d","glow":"neon","status":"pulse"},
             "banner":{"mode":"gradient","colors":["#150a2b","#ff4fd8"],"angle":135,"pattern":"grid","anim":"stars","height":"tall","dim":10},
             "theme":{"accent":"#ff4fd8","card":"gradient","bg":"stars","bgColors":["#150a2b","#4dd8ff"],"corner":"round","preset":"neon-night"},
             "content":{"status":{"emoji":"🚧","text":"Building a new cliff map","expires":0},"bio":"Map maker and **Recharge** tinkerer. I love *tricky jumps*.\nFind my maps below or say hi on [Discord](https://discord.gg/recharge).","pronouns":"he/him",
               "links":[{"url":"https://www.youtube.com/@oliver","label":"YouTube"},{"url":"https://discord.gg/recharge","label":"Discord"},{"url":"https://github.com/oliver","label":"GitHub"},{"url":"https://www.twitch.tv/oliver","label":"Twitch"},{"url":"https://www.patreon.com/oliver","label":"Patreon"}],
               "showcase":[{"kind":"map","id":"map-cliffside","name":"Cliffside Run"},{"kind":"skin","id":"skin-neon","name":"Neon Courier"},{"kind":"mod","id":"mod-ghost","name":"Ghost Replays"}],
               "featured":{"kind":"map","id":"map-cliffside","name":"Cliffside Run","note":"My best map so far: three checkpoints and a secret route."}},
             "sections":[{"id":"about","on":true},{"id":"stats","on":true},{"id":"showcase","on":true},{"id":"links","on":true},{"id":"uploads","on":true},{"id":"friends","on":true},{"id":"activity","on":true}],
             "stats":{"show":["uploads","threads","replies","comments","friends"],"style":"big"}}
            """,
            ["Maya"] = """
            {"name":{"mode":"gradient","colors":["#ff9a3c","#ff4d8d","#9a5cff"],"angle":45,"effects":["shimmer"],"font":"serif","weight":"bold"},
             "avatar":{"shape":"squircle","frame":"g-sunset","ornament":"ears","ornamentColor":"#ffc9a0","status":"ring"},
             "banner":{"mode":"gradient","colors":["#2a0f2e","#ff9a3c","#ff4d8d"],"angle":120,"pattern":"dots","anim":"aurora"},
             "theme":{"accent":"#ff7a59","card":"glass","bg":"gradient","bgColors":["#2a0f2e","#4a1a3a"],"corner":"soft","preset":"sunset-drive"},
             "content":{"status":{"emoji":"🏃","text":"Chasing a new PB on Sunset Sprint","expires":0},"bio":"Speedrunner. **World record** hunter, *coffee* enthusiast.","pronouns":"she/her",
               "links":[{"url":"https://www.speedrun.com/maya","label":"speedrun.com"},{"url":"https://www.twitch.tv/maya","label":"Twitch"}],
               "showcase":[{"kind":"map","id":"map-sunset","name":"Sunset Sprint"}]},
             "stats":{"show":["uploads","threads","replies"],"style":"chips"}}
            """,
            ["jonas"] = """
            {"name":{"mode":"solid","colors":["#ffe14d"],"effects":["pixel"],"font":"vt323","weight":"bold","spacing":"wide","effectColor":"#ff4d4d"},
             "avatar":{"shape":"diamond","frame":"pixel-gold","status":"pixel"},
             "banner":{"mode":"gradient","colors":["#0a0a24","#ffe14d"],"angle":160,"pattern":"scanlines","anim":"sweep","height":"normal"},
             "theme":{"accent":"#ffe14d","card":"solid","bg":"dots","bgColors":["#0a0a24","#23236a"],"corner":"pixel","preset":"retro-arcade"},
             "content":{"status":{"emoji":"🎮","text":"Pixel art all day","expires":0},"bio":"Pixel art and **tricky jumps**.\nArcade Alley 1.4 is out!","pronouns":"he/him",
               "links":[{"url":"https://itch.io/profile/jonas","label":"itch.io"},{"url":"https://github.com/jonas","label":""}],
               "showcase":[{"kind":"map","id":"map-arcade","name":"Arcade Alley"},{"kind":"map","id":"map-tower","name":"Tower Climb"}]},
             "stats":{"show":["uploads","threads","comments"],"style":"minimal"}}
            """,
            ["priya"] = """
            {"name":{"mode":"gradient","colors":["#41f88d","#3ce6e6","#9a5cff"],"angle":90,"effects":["glow","shimmer"],"font":"rounded","weight":"bold"},
             "avatar":{"shape":"circle","frame":"g-aurora","ornament":"halo","ornamentColor":"#fff3b0","glow":"soft"},
             "banner":{"mode":"gradient","colors":["#081a24","#41f88d","#9a5cff"],"angle":135,"pattern":"stars","anim":"aurora","height":"hero","tint":"#3ce6e6"},
             "theme":{"accent":"#41f88d","card":"glass","bg":"aurora","bgColors":["#081a24","#9a5cff"],"corner":"round","preset":"aurora"},
             "content":{"status":{"emoji":"✨","text":"Tweaking shaders","expires":0},"bio":"Mods and shaders. Ask me about **lighting**.","pronouns":"she/they",
               "links":[{"url":"https://github.com/priya","label":"GitHub"},{"url":"https://bsky.app/profile/priya","label":"Bluesky"}]},
             "stats":{"show":["uploads","threads","replies","comments"],"style":"big"},"privacy":{"friends":"friends"}}
            """,
            ["sam"] = """
            {"name":{"mode":"solid","colors":["#f9ffe4"],"effects":["outline"],"font":"mono","spacing":"tight","effectColor":"#555555"},
             "avatar":{"shape":"circle","frame":"ring-white","ornament":"antenna","ornamentColor":"#f9ffe4"},
             "banner":{"mode":"color","colors":["#161616"],"pattern":"grid","height":"slim"},
             "theme":{"accent":"#b8bcc4","card":"pattern","bg":"color","bgColors":["#101010","#222222"],"corner":"sharp","preset":"monochrome"},
             "content":{"bio":"Quiet player. Monochrome skin author.","pronouns":"","links":[{"url":"https://github.com/sam","label":"Code"}],"showcase":[{"kind":"skin","id":"skin-mono","name":"Monochrome"}]},
             "sections":[{"id":"links","on":true},{"id":"about","on":true},{"id":"uploads","on":false},{"id":"showcase","on":true},{"id":"stats","on":true}],
             "stats":{"show":["uploads","comments"],"style":"minimal"}}
            """,
            ["Kit"] = """
            {"name":{"mode":"gradient","colors":["#ffe14d","#ff5d3c","#ff3c3c"],"angle":0,"effects":["rainbow","glow","pulse"],"font":"sans","weight":"heavy"},
             "avatar":{"shape":"hex","frame":"duo-ember","ornament":"flame","glow":"neon"},
             "banner":{"mode":"gradient","colors":["#1c0808","#ff5d3c"],"angle":180,"pattern":"scanlines","anim":"sweep","dim":20,"height":"tall"},
             "theme":{"accent":"#ff5d3c","card":"gradient","bg":"gradient","bgColors":["#1c0808","#3a1208"],"corner":"sharp","preset":"magma"},
             "content":{"status":{"emoji":"🔥","text":"Rising lava, rising stakes","expires":0},"bio":"Lava level fan. *Everything* is better when it is on fire.",
               "links":[{"url":"https://www.reddit.com/user/kit","label":"Reddit"}]},
             "stats":{"show":["threads","replies"],"style":"chips"}}
            """,
            ["Flipped"] = """
            {"name":{"mode":"gradient","colors":["#ffffff","#bfe8ff","#5cb4ff","#7a6bff"],"angle":105,"effects":["shimmer","glow","outline"],"effectColor":"#9fdcff","font":"vt323","weight":"heavy","spacing":"wider"},
             "avatar":{"shape":"circle","frame":"x-flipped-frost","ornament":"sparkles","ornamentColor":"#e6f6ff","glow":"neon","status":"pulse"},
             "banner":{"mode":"gradient","colors":["#040f22","#0e2b52","#5cb4ff"],"angle":160,"pattern":"hex","anim":"frostfall","tint":"#bfe8ff","height":"hero"},
             "theme":{"accent":"#9fdcff","card":"glass","bg":"stars","bgColors":["#030a18","#0c2140"],"corner":"round","preset":"flipped-frost"},
             "content":{"status":{"emoji":"❄️","text":"Building the new Recharge","expires":0},"bio":"Maker of **Recharge**.","links":[{"url":"https://github.com/flipped","label":"GitHub"}],
               "showcase":[{"kind":"map","id":"map-cliffside","name":"Cliffside Run"}]},
             "stats":{"show":["uploads","threads","replies","comments","friends"],"style":"big"}}
            """,
        };

        public static void SeedSocial(SocialService s)
        {
            foreach (var kv in Looks)
            {
                using JsonDocument doc = JsonDocument.Parse(kv.Value);
                s.PutProfile(kv.Key, WithVersion(doc.RootElement));
            }
        }

        private static JsonElement WithVersion(JsonElement look)
        {
            var node = System.Text.Json.Nodes.JsonNode.Parse(look.GetRawText())!.AsObject();
            node["v"] = 1;
            return JsonDocument.Parse(node.ToJsonString()).RootElement.Clone();
        }
    }
}

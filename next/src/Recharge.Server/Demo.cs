using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Tasks;

namespace Recharge.Server
{
    /// <summary>
    /// "Recharge.Server --demo &lt;dir&gt;": a fake hub plus a seeded social server on free local ports, for snapshots and manual
    /// checks. Prints one line of JSON with the ports and never contacts the real hub.
    /// </summary>
    internal static class Demo
    {
        public static async Task<int> Run(string[] args)
        {
            string dir = args.Length > 1 ? args[1] : Path.Combine(Path.GetTempPath(), "recharge-social-demo");
            Directory.CreateDirectory(dir);
            FakeHub fake = new FakeHub().AddUser("oliver").AddUser("Maya").AddUser("jonas").AddUser("priya").AddUser("sam").AddUser("Kit").AddUser("Flipped");
            DemoProfiles.SeedHub(fake);
            using FakeHub hub = fake.Start();
            var options = new SocialOptions { Port = 0, Host = "127.0.0.1", DataDir = Path.Combine(dir, "social"), MessagesPerMinute = 1000 };
            var hubDir = new HttpHubDirectory(hub.BaseUrl, options.AuthCache, options.Clock);
            using var server = new SocialServer(options, hubDir, new TestShareSigner("demo"));
            server.Start();
            SocialService s = server.Service;
            foreach (string n in new[] { "oliver", "Maya", "jonas", "priya", "sam", "Kit" }) s.Remember(n);
            foreach (string f in new[] { "Maya", "jonas", "priya" })
            {
                s.RequestFriend(f, "oliver");
                s.Accept("oliver", f);
            }
            s.RequestFriend("sam", "oliver");
            s.RequestFriend("oliver", "Kit");
            s.Connect("Maya", 1001);
            s.SetPresence("Maya", 1001, "lobby", "Speedrun lobby", "lobby-7");
            s.Connect("jonas", 1002);
            s.SetPresence("jonas", 1002, "editing", "Cliffside Run", "map-cliffside");
            s.Connect("priya", 1003);
            s.SetPresence("priya", 1003, "game", "", "");
            s.Send("Maya", SocialService.DmId("Maya", "oliver"), "Hey! Want to try the new lobby?", null);
            s.Send("oliver", SocialService.DmId("oliver", "Maya"), "Sure, give me two minutes.", null);
            s.Send("Maya", SocialService.DmId("Maya", "oliver"), "I'm hosting Speedrun lobby, join whenever you're ready.", new CardRec { Type = "lobby", Id = "lobby-7", Name = "Speedrun lobby" });
            s.Send("jonas", SocialService.DmId("jonas", "oliver"), "Can you test my map? I added a second checkpoint.", new CardRec { Type = "map", Id = "map-cliffside", Name = "Cliffside Run" });
            s.Send("priya", SocialService.DmId("priya", "oliver"), "gg on that last run", null);

            // A group chat: oliver, Maya, jonas and priya, with a reply in it.
            using (JsonDocument g = JsonDocument.Parse(JsonSerializer.Serialize(s.CreateGroup("oliver", "Speedrun crew", new[] { "Maya", "jonas", "priya" }))))
            {
                string gid = g.RootElement.GetProperty("id").GetString()!;
                s.Send("Maya", gid, "Race tonight at 8?", null);
                JsonElement first = default;
                using (JsonDocument hist = JsonDocument.Parse(JsonSerializer.Serialize(s.Messages("oliver", gid, 0, 10))))
                    first = hist.RootElement.GetProperty("messages")[0].Clone();
                long firstId = first.GetProperty("id").GetInt64();
                s.Send("jonas", gid, "I'm in, testing my new map first.", null);
                s.Send("oliver", gid, "Count me in too.", null, null, firstId);
                s.Send("priya", gid, "Same, see you there!", null, null, firstId);
            }

            DemoProfiles.SeedSocial(s);
            Console.WriteLine("{\"social\":" + server.Port + ",\"hub\":" + hub.Port + "}");
            using var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (a, e) => { e.Cancel = true; cts.Cancel(); };
            try { await Task.Delay(Timeout.Infinite, cts.Token).ConfigureAwait(false); }
            catch (TaskCanceledException) { }
            return 0;
        }
    }
}

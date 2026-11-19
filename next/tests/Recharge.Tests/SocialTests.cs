using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Recharge.App.Social;
using Recharge.Core.Json;
using Recharge.Server;

namespace Recharge.Tests
{
    public static class SocialTests
    {
        private sealed class Env : IDisposable
        {
            public FakeHub Hub = new FakeHub().AddUser("alice").AddUser("Bob").AddUser("carol").Start();
            public SocialServer Server = null!;
            public SocialOptions Options = new SocialOptions { Port = 0, Host = "127.0.0.1" };
            public TestShareSigner Signer = new TestShareSigner("test-key");
            public string Dir = Path.Combine(Path.GetTempPath(), "recharge-social-test-" + Guid.NewGuid().ToString("N"));
            public DateTimeOffset Now = new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);
            public HttpClient Http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };

            public Env(Action<SocialOptions>? tweak = null)
            {
                Options.DataDir = Dir;
                Options.Clock = () => Now;
                tweak?.Invoke(Options);
                StartServer();
            }

            public void StartServer()
            {
                var directory = new HttpHubDirectory(Hub.BaseUrl, Options.AuthCache, Options.Clock);
                Server = new SocialServer(Options, directory, Signer);
                Server.Start();
            }

            public void Restart()
            {
                Server.Dispose();
                StartServer();
            }

            public string Url(string path) => "http://127.0.0.1:" + Server.Port + path;

            public (int Status, JsonElement Body) Api(string user, string method, string path, object? body = null, string? token = null)
            {
                using var req = new HttpRequestMessage(new HttpMethod(method), Url(path));
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token ?? FakeHub.TokenFor(user));
                if (body is not null) req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
                using HttpResponseMessage res = Http.SendAsync(req).GetAwaiter().GetResult();
                string text = res.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                using JsonDocument doc = JsonDocument.Parse(text.Length == 0 ? "{}" : text);
                return ((int)res.StatusCode, doc.RootElement.Clone());
            }

            public JsonElement Ok(string user, string method, string path, object? body = null)
            {
                var (status, json) = Api(user, method, path, body);
                if (status != 200) throw new AssertException(method + " " + path + " as " + user + " answered " + status + ": " + json);
                return json;
            }

            public void Befriend(string a, string b)
            {
                Ok(a, "POST", "/api/friends/request", new { username = b });
                Ok(b, "POST", "/api/friends/accept", new { username = a });
            }

            public void Dispose()
            {
                Server.Dispose();
                Hub.Dispose();
                Http.Dispose();
                try { Directory.Delete(Dir, true); } catch (IOException) { }
            }
        }

        private sealed class Sock : IDisposable
        {
            public ClientWebSocket Ws = new ClientWebSocket();

            public Sock(Env env, string user)
            {
                Ws.Options.SetRequestHeader("Authorization", "Bearer " + FakeHub.TokenFor(user));
                Ws.ConnectAsync(new Uri("ws://127.0.0.1:" + env.Server.Port + "/ws"), CancellationToken.None).GetAwaiter().GetResult();
            }

            public void Send(object frame)
            {
                Ws.SendAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(frame)), WebSocketMessageType.Text, true, CancellationToken.None).GetAwaiter().GetResult();
            }

            /// <summary>The next frame, or null on timeout.</summary>
            public JsonElement? Next(int ms = 4000)
            {
                using var cts = new CancellationTokenSource(ms);
                var buf = new byte[65536];
                try
                {
                    var ms2 = new MemoryStream();
                    WebSocketReceiveResult r;
                    do
                    {
                        r = Ws.ReceiveAsync(buf, cts.Token).GetAwaiter().GetResult();
                        if (r.MessageType == WebSocketMessageType.Close) return null;
                        ms2.Write(buf, 0, r.Count);
                    } while (!r.EndOfMessage);
                    using JsonDocument doc = JsonDocument.Parse(ms2.ToArray());
                    return doc.RootElement.Clone();
                }
                catch (OperationCanceledException) { return null; }
                catch (WebSocketException) { return null; }
            }

            /// <summary>Reads frames until one of this type arrives (others are skipped).</summary>
            public JsonElement Expect(string type, Func<JsonElement, bool>? where = null, int ms = 4000)
            {
                var until = DateTime.UtcNow.AddMilliseconds(ms);
                while (DateTime.UtcNow < until)
                {
                    JsonElement? f = Next((int)Math.Max(50, (until - DateTime.UtcNow).TotalMilliseconds));
                    if (f is null) break;
                    if (f.Value.GetProperty("type").GetString() == type && (where is null || where(f.Value))) return f.Value;
                }
                throw new AssertException("no '" + type + "' frame arrived");
            }

            public void Dispose() => Ws.Dispose();
        }

        private static string S(JsonElement e, string name) => e.GetProperty(name).GetString() ?? "";

        [Test]
        public static void FriendFlow()
        {
            using var env = new Env();
            // Unknown users and yourself are refused.
            Assert.Equal(404, env.Api("alice", "POST", "/api/friends/request", new { username = "nobody" }).Status, "unknown user");
            Assert.Equal(400, env.Api("alice", "POST", "/api/friends/request", new { username = "alice" }).Status, "self");

            Assert.Equal("pending", S(env.Ok("alice", "POST", "/api/friends/request", new { username = "bob" }), "status"), "request");
            Assert.Equal("pending", S(env.Ok("alice", "POST", "/api/friends/request", new { username = "bob" }), "status"), "request is idempotent");
            JsonElement bob = env.Ok("bob", "GET", "/api/friends");
            Assert.Equal(1, bob.GetProperty("incoming").GetArrayLength(), "bob's incoming");
            Assert.Equal("alice", S(bob.GetProperty("incoming")[0], "username"), "from alice");
            Assert.Equal(1, env.Ok("alice", "GET", "/api/friends").GetProperty("outgoing").GetArrayLength(), "alice's outgoing");

            env.Ok("bob", "POST", "/api/friends/accept", new { username = "alice" });
            JsonElement a = env.Ok("alice", "GET", "/api/friends");
            Assert.Equal(1, a.GetProperty("friends").GetArrayLength(), "alice has a friend");
            Assert.Equal("Bob", S(a.GetProperty("friends")[0], "username"), "the hub's spelling is kept");
            Assert.Equal(0, a.GetProperty("outgoing").GetArrayLength(), "request cleared");
            Assert.Equal(409, env.Api("alice", "POST", "/api/friends/request", new { username = "bob" }).Status, "already friends");

            // A request in both directions makes them friends at once.
            env.Ok("carol", "POST", "/api/friends/request", new { username = "alice" });
            Assert.Equal("friends", S(env.Ok("alice", "POST", "/api/friends/request", new { username = "carol" }), "status"), "crossed requests");

            // Decline, then remove.
            env.Ok("bob", "DELETE", "/api/friends/alice");
            Assert.Equal(0, env.Ok("alice", "GET", "/api/friends").GetProperty("friends").GetArrayLength() - 1, "bob removed, carol stays");
            env.Ok("bob", "POST", "/api/friends/request", new { username = "alice" });
            env.Ok("alice", "POST", "/api/friends/decline", new { username = "bob" });
            Assert.Equal(0, env.Ok("alice", "GET", "/api/friends").GetProperty("incoming").GetArrayLength(), "declined");
            Assert.Equal(404, env.Api("alice", "POST", "/api/friends/accept", new { username = "bob" }).Status, "nothing to accept");
        }

        [Test]
        public static void AuthChecksTheHubAndCaches()
        {
            using var env = new Env();
            Assert.Equal(401, env.Api("alice", "GET", "/api/friends", null, "tok-nobody").Status, "bad token");
            Assert.Equal(401, env.Api("alice", "GET", "/api/friends", null, "not-even-a-token").Status, "junk token");
            int before = env.Hub.MeCalls;
            for (int i = 0; i < 5; i++) env.Ok("alice", "GET", "/api/friends");
            Assert.Equal(1, env.Hub.MeCalls - before, "five requests, one /api/me call");
            env.Now = env.Now.AddMinutes(2);
            env.Ok("alice", "GET", "/api/friends");
            Assert.Equal(2, env.Hub.MeCalls - before, "the cache expires");
            env.Hub.Down = true;
            env.Now = env.Now.AddMinutes(2);
            Assert.Equal(503, env.Api("alice", "GET", "/api/friends").Status, "hub down");
        }

        [Test]
        public static void SendsAreIdempotentAndReadsAreSeen()
        {
            using var env = new Env();
            env.Befriend("alice", "bob");
            using var alice = new Sock(env, "alice");
            alice.Expect("hello");
            JsonElement first = env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "once", cid = "c-1" });
            JsonElement again = env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "once", cid = "c-1" });
            Assert.Equal(first.GetProperty("id").GetInt64(), again.GetProperty("id").GetInt64(), "a retry returns the stored message");
            Assert.Equal("c-1", S(again, "cid"), "cid is echoed");
            Assert.Equal(1, env.Ok("bob", "GET", "/api/conversations/alice/messages").GetProperty("messages").GetArrayLength(), "no duplicate");
            // Junk ids are ignored (the message is still sent, just not deduplicated).
            env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "x", cid = "bad id!" });
            env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "x", cid = "bad id!" });
            Assert.Equal(3, env.Ok("bob", "GET", "/api/conversations/alice/messages").GetProperty("messages").GetArrayLength(), "invalid cids do not dedupe");
            // The same cid from the other person is a different message.
            env.Ok("bob", "POST", "/api/conversations/alice/messages", new { text = "mine", cid = "c-1" });
            Assert.Equal(4, env.Ok("bob", "GET", "/api/conversations/alice/messages").GetProperty("messages").GetArrayLength(), "cids are per sender");

            // Reading tells the sender (a 'seen' frame) and shows in the history.
            long last = env.Ok("bob", "GET", "/api/conversations/alice/messages").GetProperty("messages").EnumerateArray().Last().GetProperty("id").GetInt64();
            Assert.Equal(0, env.Ok("alice", "GET", "/api/conversations/bob/messages").GetProperty("seenUpTo").GetInt64(), "nothing seen yet");
            env.Ok("bob", "POST", "/api/conversations/alice/read", new { upTo = last });
            JsonElement seen = alice.Expect("seen");
            Assert.Equal("Bob", S(seen, "username"), "seen names the reader");
            Assert.Equal(last, seen.GetProperty("upTo").GetInt64(), "seen position");
            Assert.Equal(last, env.Ok("alice", "GET", "/api/conversations/bob/messages").GetProperty("seenUpTo").GetInt64(), "seenUpTo in history");
        }

        [Test]
        public static void MessagesArriveOverTheSocket()
        {
            using var env = new Env();
            env.Befriend("alice", "bob");
            using var bob = new Sock(env, "bob");
            JsonElement hello = bob.Expect("hello");
            Assert.Equal("Bob", S(hello, "username"), "hello names the user");

            env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "hi bob" });
            JsonElement pushed = bob.Expect("message").GetProperty("message");
            Assert.Equal("hi bob", S(pushed, "text"), "pushed text");
            Assert.Equal("alice", S(pushed, "from"), "pushed sender");

            // A message sent over the socket reaches the other side and is acknowledged.
            using var alice = new Sock(env, "alice");
            alice.Send(new { type = "send", to = "bob", text = "over the socket", @ref = "r1" });
            JsonElement sent = alice.Expect("sent");
            Assert.Equal("r1", S(sent, "ref"), "ref echoed");
            Assert.Equal("over the socket", S(bob.Expect("message", m => S(m.GetProperty("message"), "text") == "over the socket").GetProperty("message"), "text"), "socket message");

            // History, paging and read state.
            for (int i = 0; i < 4; i++) env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "m" + i });
            JsonElement page = env.Ok("bob", "GET", "/api/conversations/alice/messages?limit=3");
            Assert.Equal(3, page.GetProperty("messages").GetArrayLength(), "page size");
            Assert.True(page.GetProperty("hasMore").GetBoolean(), "more");
            long oldest = page.GetProperty("messages")[0].GetProperty("id").GetInt64();
            JsonElement older = env.Ok("bob", "GET", "/api/conversations/alice/messages?limit=50&before=" + oldest);
            Assert.True(older.GetProperty("messages").GetArrayLength() >= 1 && older.GetProperty("messages")[0].GetProperty("id").GetInt64() < oldest, "older page");
            JsonElement convs = env.Ok("bob", "GET", "/api/conversations");
            Assert.Equal(6, convs.GetProperty("unread").GetInt32(), "six unread");
            long last = page.GetProperty("messages")[2].GetProperty("id").GetInt64();
            env.Ok("bob", "POST", "/api/conversations/alice/read", new { upTo = last });
            Assert.Equal(0, env.Ok("bob", "GET", "/api/conversations").GetProperty("unread").GetInt32(), "read");

            // A card.
            env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "", card = new { type = "map", id = "m1", name = "Cliff" } });
            Assert.Equal("Cliff", S(bob.Expect("message", m => m.GetProperty("message").GetProperty("card").ValueKind == JsonValueKind.Object).GetProperty("message").GetProperty("card"), "name"), "card pushed");
            Assert.Equal(400, env.Api("alice", "POST", "/api/conversations/bob/messages", new { card = new { type = "virus", id = "x" } }).Status, "unknown card type");
        }

        [Test]
        public static void PresenceReachesFriendsOnly()
        {
            using var env = new Env();
            env.Befriend("alice", "bob");
            using var bob = new Sock(env, "bob");
            bob.Expect("hello");
            using var carol = new Sock(env, "carol");
            carol.Expect("hello");
            using var alice = new Sock(env, "alice");
            alice.Expect("hello");
            Assert.Equal("online", S(bob.Expect("presence", p => S(p, "username") == "alice"), "state"), "alice comes online");
            alice.Send(new { type = "presence", state = "lobby", detail = "Speedrun", join = "lobby-7" });
            JsonElement p = bob.Expect("presence", x => S(x, "state") == "lobby");
            Assert.Equal("Speedrun", S(p, "detail"), "detail");
            Assert.Equal("lobby-7", S(p, "join"), "join id");
            Assert.Equal("lobby", S(env.Ok("bob", "GET", "/api/friends").GetProperty("friends")[0], "state"), "in the friend list too");
            Assert.True(carol.Next(300) is null, "a stranger sees nothing");

            // Two connections: the more specific state wins, and leaving one keeps the other.
            using var alice2 = new Sock(env, "alice");
            alice2.Expect("hello");
            alice.Dispose();
            Assert.Equal("online", S(bob.Expect("presence", x => S(x, "state") == "online"), "state"), "falls back to the other connection");
            alice2.Dispose();
            Assert.Equal("offline", S(bob.Expect("presence", x => S(x, "state") == "offline"), "state"), "offline once the last closes");

            // Invisible.
            using var alice3 = new Sock(env, "alice");
            alice3.Expect("hello");
            bob.Expect("presence", x => S(x, "state") == "online");
            env.Ok("alice", "PUT", "/api/settings", new { invisible = true });
            Assert.Equal("offline", S(bob.Expect("presence", x => S(x, "state") == "offline"), "state"), "invisible looks offline");
        }

        [Test]
        public static void BlocksHideEverythingBothWays()
        {
            using var env = new Env();
            env.Befriend("alice", "bob");
            env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "before" });
            using var bobSock = new Sock(env, "bob");
            bobSock.Expect("hello");

            env.Ok("bob", "POST", "/api/blocks", new { username = "alice" });
            Assert.Equal(0, env.Ok("alice", "GET", "/api/friends").GetProperty("friends").GetArrayLength(), "no longer friends");
            Assert.Equal(0, env.Ok("bob", "GET", "/api/friends").GetProperty("friends").GetArrayLength(), "both sides");
            Assert.Equal(1, env.Ok("bob", "GET", "/api/blocks").GetProperty("blocked").GetArrayLength(), "bob's block list");
            Assert.Equal(0, env.Ok("alice", "GET", "/api/blocks").GetProperty("blocked").GetArrayLength(), "alice isn't told");
            Assert.Equal(403, env.Api("alice", "POST", "/api/conversations/bob/messages", new { text = "hello?" }).Status, "blocked sender");
            Assert.Equal(403, env.Api("bob", "POST", "/api/conversations/alice/messages", new { text = "hello?" }).Status, "blocker too");
            Assert.Equal(0, env.Ok("bob", "GET", "/api/conversations").GetProperty("conversations").GetArrayLength(), "conversation hidden for bob");
            Assert.Equal(0, env.Ok("alice", "GET", "/api/conversations").GetProperty("conversations").GetArrayLength(), "and for alice");
            Assert.Equal(404, env.Api("alice", "GET", "/api/conversations/bob/messages").Status, "history hidden");
            Assert.Equal(404, env.Api("alice", "POST", "/api/friends/request", new { username = "bob" }).Status, "can't re-request");
            Assert.Equal(404, env.Api("bob", "POST", "/api/friends/request", new { username = "alice" }).Status, "blocker can't either");

            env.Ok("bob", "DELETE", "/api/blocks/alice");
            Assert.Equal(0, env.Ok("alice", "GET", "/api/friends").GetProperty("friends").GetArrayLength(), "unblocking doesn't restore the friendship");
            env.Befriend("alice", "bob");
            Assert.Equal(1, env.Ok("bob", "GET", "/api/conversations").GetProperty("conversations").GetArrayLength(), "old history is back");
        }

        [Test]
        public static void LimitsAreEnforced()
        {
            using var env = new Env(o => { o.MessagesPerMinute = 3; o.FriendRequestsPerHour = 2; o.MaxMessageChars = 50; });
            env.Befriend("alice", "bob");
            Assert.Equal(400, env.Api("alice", "POST", "/api/conversations/bob/messages", new { text = new string('x', 51) }).Status, "too long");
            Assert.Equal(400, env.Api("alice", "POST", "/api/conversations/bob/messages", new { text = "   " }).Status, "empty");
            Assert.Equal(400, env.Api("alice", "POST", "/api/conversations/alice/messages", new { text = "me" }).Status, "to yourself");
            for (int i = 0; i < 3; i++) env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "ok" + i });
            var (status, body) = env.Api("alice", "POST", "/api/conversations/bob/messages", new { text = "one too many" });
            Assert.Equal(429, status, "rate limited");
            Assert.True(body.GetProperty("retry_after").GetDouble() >= 1, "says when to retry");
            env.Now = env.Now.AddSeconds(61);
            env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "later" });

            // Non-friends can't message unless they opted in.
            Assert.Equal(403, env.Api("carol", "POST", "/api/conversations/alice/messages", new { text = "hey" }).Status, "stranger refused");
            env.Ok("alice", "PUT", "/api/settings", new { allowStrangers = true });
            env.Ok("carol", "POST", "/api/conversations/alice/messages", new { text = "hey" });

            // Friend-request limit.
            env.Ok("carol", "POST", "/api/friends/request", new { username = "bob" });
            env.Ok("carol", "DELETE", "/api/friends/bob");
            env.Ok("carol", "POST", "/api/friends/request", new { username = "bob" });
            env.Ok("carol", "DELETE", "/api/friends/bob");
            Assert.Equal(429, env.Api("carol", "POST", "/api/friends/request", new { username = "bob" }).Status, "too many requests");

            // Oversized bodies and bad JSON.
            using var req = new HttpRequestMessage(HttpMethod.Post, env.Url("/api/conversations/bob/messages"));
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", FakeHub.TokenFor("alice"));
            req.Content = new StringContent("{not json", Encoding.UTF8, "application/json");
            Assert.Equal(400, (int)env.Http.SendAsync(req).GetAwaiter().GetResult().StatusCode, "bad json");
        }

        [Test]
        public static void SocketLimitsAreEnforced()
        {
            using var env = new Env(o => o.MaxConnectionsPerUser = 2);
            using var a = new Sock(env, "alice");
            using var b = new Sock(env, "alice");
            Assert.Throws<WebSocketException>(() => { using var c = new Sock(env, "alice"); });
            using var noAuth = new ClientWebSocket();
            Assert.Throws<WebSocketException>(() => noAuth.ConnectAsync(new Uri("ws://127.0.0.1:" + env.Server.Port + "/ws"), CancellationToken.None).GetAwaiter().GetResult());
        }

        [Test]
        public static void PrivateSharesCreateAndRevoke()
        {
            using var env = new Env();
            env.Befriend("alice", "bob");

            // Sharing is for friends only.
            Assert.Equal(403, env.Api("alice", "POST", "/api/shares", new { mapId = "m1", with = "carol" }).Status, "not a friend");
            Assert.Equal(400, env.Api("alice", "POST", "/api/shares", new { mapId = "../x", with = "bob" }).Status, "bad map id");
            Assert.Equal(400, env.Api("alice", "POST", "/api/shares", new { mapId = "m1", link = true, mode = "edit" }).Status, "links are view only");

            using var bobSock = new Sock(env, "bob");
            bobSock.Expect("hello");
            JsonElement share = env.Ok("alice", "POST", "/api/shares", new { mapId = "m1", name = "Cliffside", with = "bob", mode = "edit" });
            string id = S(share, "id");
            Assert.Equal("edit", S(bobSock.Expect("share").GetProperty("share"), "mode"), "bob is told");
            Assert.Equal(1, env.Ok("bob", "GET", "/api/shares").GetProperty("received").GetArrayLength(), "bob sees it");
            Assert.Equal(1, env.Ok("alice", "GET", "/api/shares").GetProperty("owned").GetArrayLength(), "alice owns it");

            JsonElement dl = env.Ok("bob", "GET", "/api/shares/" + id + "/download");
            string url = S(dl, "url");
            var uri = new Uri(url);
            string key = uri.AbsolutePath.TrimStart('/');
            var query = System.Web.HttpUtility.ParseQueryString(uri.Query);
            Assert.Equal("private/alice/m1", key, "private prefix");
            Assert.True(env.Signer.Verify(key, long.Parse(query["expires"]!), query["signature"]!, env.Now), "signature checks out");
            Assert.False(env.Signer.Verify(key, long.Parse(query["expires"]!), query["signature"]!, env.Now.AddMinutes(10)), "and expires");
            Assert.False(env.Signer.Verify("private/alice/other", long.Parse(query["expires"]!), query["signature"]!, env.Now), "and is tied to the file");
            Assert.Equal(404, env.Api("carol", "GET", "/api/shares/" + id + "/download").Status, "a stranger can't download");
            Assert.Equal(404, env.Api("bob", "DELETE", "/api/shares/" + id).Status, "only the owner can revoke");

            env.Ok("alice", "DELETE", "/api/shares/" + id);
            Assert.Equal("share-revoked", S(bobSock.Expect("share-revoked"), "type"), "bob is told");
            Assert.Equal(404, env.Api("bob", "GET", "/api/shares/" + id + "/download").Status, "revoked");
            Assert.Equal(0, env.Ok("bob", "GET", "/api/shares").GetProperty("received").GetArrayLength(), "gone from bob's list");

            // A private link works without a login until it expires or is revoked.
            JsonElement link = env.Ok("alice", "POST", "/api/shares", new { mapId = "m2", link = true, expiresInSeconds = 3600 });
            string token = S(link, "token");
            Assert.True(token.Length >= 24, "token");
            Assert.Equal(JsonValueKind.Null, env.Ok("alice", "GET", "/api/shares").GetProperty("owned")[0].GetProperty("token").ValueKind, "the token is only shown once");
            Assert.True(env.Http.GetAsync(env.Url("/api/shares/link/" + token)).GetAwaiter().GetResult().IsSuccessStatusCode, "link works with no login");
            env.Now = env.Now.AddHours(2);
            Assert.Equal(404, (int)env.Http.GetAsync(env.Url("/api/shares/link/" + token)).GetAwaiter().GetResult().StatusCode, "link expired");
            JsonElement link2 = env.Ok("alice", "POST", "/api/shares", new { mapId = "m3", link = true });
            env.Ok("alice", "DELETE", "/api/shares/" + S(link2, "id"));
            Assert.Equal(404, (int)env.Http.GetAsync(env.Url("/api/shares/link/" + S(link2, "token"))).GetAwaiter().GetResult().StatusCode, "link revoked");

            // Blocking cuts off a friend's access too.
            JsonElement s3 = env.Ok("alice", "POST", "/api/shares", new { mapId = "m4", with = "bob" });
            env.Ok("alice", "POST", "/api/blocks", new { username = "bob" });
            Assert.Equal(404, env.Api("bob", "GET", "/api/shares/" + S(s3, "id") + "/download").Status, "blocked recipient");
        }

        [Test]
        public static void UnconfiguredSignerAnswers503()
        {
            using var env = new Env();
            env.Server.Dispose();
            var directory = new HttpHubDirectory(env.Hub.BaseUrl, env.Options.AuthCache, env.Options.Clock);
            env.Server = new SocialServer(env.Options, directory, new UnconfiguredShareSigner());
            env.Server.Start();
            env.Befriend("alice", "bob");
            string id = S(env.Ok("alice", "POST", "/api/shares", new { mapId = "m1", with = "bob" }), "id");
            Assert.Equal(503, env.Api("bob", "GET", "/api/shares/" + id + "/download").Status, "no signer");
        }

        [Test]
        public static void DataSurvivesARestart()
        {
            using var env = new Env();
            env.Befriend("alice", "bob");
            env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "remember me" });
            env.Ok("carol", "POST", "/api/friends/request", new { username = "alice" });
            env.Ok("bob", "POST", "/api/blocks", new { username = "carol" });
            string shareId = S(env.Ok("alice", "POST", "/api/shares", new { mapId = "m1", with = "bob" }), "id");
            env.Ok("alice", "POST", "/api/shares", new { mapId = "m9", link = true });
            env.Ok("bob", "DELETE", "/api/blocks/carol");
            env.Ok("bob", "POST", "/api/blocks", new { username = "carol" });

            // Simulate a crash mid-write: a torn last line.
            env.Server.Dispose();
            File.AppendAllText(Path.Combine(env.Dir, "messages.jsonl"), "{\"k\":\"99\",\"v\":{\"Id\":99,\"From\":\"ali");
            env.StartServer();

            Assert.Equal(1, env.Ok("alice", "GET", "/api/friends").GetProperty("friends").GetArrayLength(), "friend kept");
            Assert.Equal(1, env.Ok("alice", "GET", "/api/friends").GetProperty("incoming").GetArrayLength(), "request kept");
            Assert.Equal(1, env.Ok("bob", "GET", "/api/blocks").GetProperty("blocked").GetArrayLength(), "block kept, unblock-reblock replayed");
            JsonElement page = env.Ok("bob", "GET", "/api/conversations/alice/messages");
            Assert.Equal(1, page.GetProperty("messages").GetArrayLength(), "the torn line was dropped");
            Assert.Equal("remember me", S(page.GetProperty("messages")[0], "text"), "message kept");
            Assert.Equal(2, env.Ok("alice", "GET", "/api/shares").GetProperty("owned").GetArrayLength(), "shares kept");
            Assert.Equal(200, env.Api("bob", "GET", "/api/shares/" + shareId + "/download").Status, "share still downloadable");

            // New messages after a restart continue the id sequence and the file stays clean.
            long first = page.GetProperty("messages")[0].GetProperty("id").GetInt64();
            long second = env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "again" }).GetProperty("id").GetInt64();
            Assert.True(second > first, "ids keep growing");
            env.Restart();
            Assert.Equal(2, env.Ok("bob", "GET", "/api/conversations/alice/messages").GetProperty("messages").GetArrayLength(), "second restart");
            foreach (string line in File.ReadAllLines(Path.Combine(env.Dir, "messages.jsonl"))) JsonDocument.Parse(line).Dispose();
        }

        [Test]
        public static void GroupsSendReadAndReply()
        {
            using var env = new Env();
            env.Befriend("alice", "bob");
            env.Befriend("alice", "carol");
            using var bob = new Sock(env, "bob");
            bob.Expect("hello");

            Assert.Equal(400, env.Api("alice", "POST", "/api/conversations", new { name = "solo", members = new string[0] }).Status, "needs another member");
            Assert.Equal(404, env.Api("alice", "POST", "/api/conversations", new { name = "x", members = new[] { "nobody" } }).Status, "unknown member");
            JsonElement g = env.Ok("alice", "POST", "/api/conversations", new { name = "  Crew  ", members = new[] { "bob", "carol" } });
            string gid = S(g, "id");
            Assert.True(gid.StartsWith("g:") && gid.Length == 14, "group id shape");
            Assert.Equal("group", S(g, "kind"), "kind");
            Assert.Equal("Crew", S(g, "name"), "name is cleaned");
            Assert.Equal(3, g.GetProperty("members").GetArrayLength(), "three members");
            Assert.True(g.GetProperty("members")[0].GetProperty("admin").GetBoolean(), "creator is admin");
            Assert.Equal("Crew", S(bob.Expect("conversation").GetProperty("conversation"), "name"), "members are told");

            // Carol isn't Bob's friend, but a group lets everyone talk.
            JsonElement m1 = env.Ok("alice", "POST", "/api/conversations/" + gid + "/messages", new { text = "hello crew" });
            Assert.Equal(gid, S(m1, "convId"), "convId");
            Assert.Equal("", S(m1, "to"), "no 'to' in a group");
            Assert.True(m1.GetProperty("replyTo").ValueKind == JsonValueKind.Null, "no reply");
            JsonElement pushed = bob.Expect("message");
            Assert.Equal(gid, S(pushed.GetProperty("conversation"), "id"), "event carries the conversation");
            Assert.Equal(1, pushed.GetProperty("conversation").GetProperty("unread").GetInt32(), "bob has one unread");

            long m1id = m1.GetProperty("id").GetInt64();
            JsonElement m2 = env.Ok("carol", "POST", "/api/conversations/" + gid + "/messages", new { text = new string('r', 300), replyTo = m1id });
            Assert.Equal(m1id, m2.GetProperty("replyTo").GetProperty("id").GetInt64(), "reply id");
            Assert.Equal("alice", S(m2.GetProperty("replyTo"), "from"), "reply sender");
            JsonElement m3 = env.Ok("bob", "POST", "/api/conversations/" + gid + "/messages", new { text = "re re", replyTo = m2.GetProperty("id").GetInt64() });
            Assert.Equal(120, S(m3.GetProperty("replyTo"), "text").Length, "reply text is trimmed");
            JsonElement stray = env.Ok("bob", "POST", "/api/conversations/" + gid + "/messages", new { text = "bad reply", replyTo = 99999 });
            Assert.True(stray.GetProperty("replyTo").ValueKind == JsonValueKind.Null, "unknown reply target is dropped");

            // A reply must stay inside its conversation.
            long dmMsg = env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "dm" }).GetProperty("id").GetInt64();
            Assert.True(env.Ok("alice", "POST", "/api/conversations/" + gid + "/messages", new { text = "x", replyTo = dmMsg }).GetProperty("replyTo").ValueKind == JsonValueKind.Null, "no cross-conversation replies");

            JsonElement hist = env.Ok("carol", "GET", "/api/conversations/" + gid + "/messages");
            Assert.Equal(5, hist.GetProperty("messages").GetArrayLength(), "group history");
            Assert.Equal(0, hist.GetProperty("seenUpTo").GetInt64(), "no receipts in groups");
            Assert.Equal("Crew", S(hist.GetProperty("conversation"), "name"), "history carries the conversation");
            Assert.Equal(4, hist.GetProperty("conversation").GetProperty("unread").GetInt32(), "carol has four unread (everything but her own)");
            long last = hist.GetProperty("messages").EnumerateArray().Last().GetProperty("id").GetInt64();
            env.Ok("carol", "POST", "/api/conversations/" + gid + "/read", new { upTo = last });
            Assert.Equal(0, env.Ok("carol", "GET", "/api/conversations/" + gid + "/messages").GetProperty("conversation").GetProperty("unread").GetInt32(), "read");

            JsonElement list = env.Ok("bob", "GET", "/api/conversations");
            Assert.Equal(2, list.GetProperty("conversations").GetArrayLength(), "bob has the group and the DM");

            // Outsiders see nothing and can't post.
            Assert.Equal(404, env.Api("alice", "GET", "/api/conversations/g:000000000000/messages").Status, "no such group");
            Assert.Equal(400, env.Api("alice", "POST", "/api/conversations/bob/members", new { username = "carol" }).Status, "a DM isn't a group");
        }

        [Test]
        public static void GroupMembershipRules()
        {
            using var env = new Env();
            env.Befriend("alice", "bob");
            env.Befriend("alice", "carol");
            string gid = S(env.Ok("alice", "POST", "/api/conversations", new { name = "G", members = new[] { "bob" } }), "id");
            using var bob = new Sock(env, "bob");
            bob.Expect("hello");
            using var carol = new Sock(env, "carol");
            carol.Expect("hello");

            Assert.Equal(404, env.Api("carol", "GET", "/api/conversations/" + gid + "/messages").Status, "outsider can't read");
            Assert.Equal(404, env.Api("carol", "POST", "/api/conversations/" + gid + "/messages", new { text = "hi" }).Status, "outsider can't post");
            Assert.Equal(403, env.Api("bob", "POST", "/api/conversations/" + gid + "/members", new { username = "carol" }).Status, "only the owner adds");
            Assert.Equal(403, env.Api("bob", "POST", "/api/conversations/" + gid + "/name", new { name = "Mine" }).Status, "only the owner renames");

            JsonElement added = env.Ok("alice", "POST", "/api/conversations/" + gid + "/members", new { username = "carol" });
            Assert.Equal(3, added.GetProperty("members").GetArrayLength(), "carol joined");
            Assert.Equal("G", S(carol.Expect("conversation").GetProperty("conversation"), "name"), "carol is told");
            Assert.Equal(409, env.Api("alice", "POST", "/api/conversations/" + gid + "/members", new { username = "carol" }).Status, "already in");
            Assert.Equal("Renamed", S(env.Ok("alice", "POST", "/api/conversations/" + gid + "/name", new { name = "Renamed" }), "name"), "rename");
            Assert.Equal("Renamed", S(bob.Expect("conversation", c => S(c.GetProperty("conversation"), "name") == "Renamed").GetProperty("conversation"), "name"), "rename pushed");


            // Only the owner removes others.
            Assert.Equal(403, env.Api("bob", "DELETE", "/api/conversations/" + gid + "/members/carol").Status, "member can't remove another");
            env.Ok("alice", "DELETE", "/api/conversations/" + gid + "/members/carol");
            Assert.Equal(gid, S(carol.Expect("conversation-left"), "convId"), "carol is told she is out");
            Assert.Equal(404, env.Api("carol", "GET", "/api/conversations/" + gid + "/messages").Status, "removed means gone");

            // The owner leaves: ownership passes to bob.
            env.Ok("alice", "DELETE", "/api/conversations/" + gid + "/members/alice");
            JsonElement now = env.Ok("bob", "GET", "/api/conversations/" + gid + "/messages").GetProperty("conversation");
            Assert.Equal(1, now.GetProperty("members").GetArrayLength(), "bob alone");
            Assert.True(now.GetProperty("members")[0].GetProperty("admin").GetBoolean(), "bob owns it now");
            env.Ok("bob", "POST", "/api/conversations/" + gid + "/messages", new { text = "anyone?" });

            // The last member leaves: the group is gone.
            env.Ok("bob", "DELETE", "/api/conversations/" + gid + "/members/bob");
            Assert.Equal(404, env.Api("bob", "GET", "/api/conversations/" + gid + "/messages").Status, "deleted");
            Assert.Equal(0, env.Ok("bob", "GET", "/api/conversations").GetProperty("conversations").GetArrayLength(), "no conversations left");
        }

        [Test]
        public static void GroupsRespectFriendshipAndStrangerSettings()
        {
            using var env = new Env();
            Assert.Equal(403, env.Api("alice", "POST", "/api/conversations", new { name = "g", members = new[] { "bob" } }).Status, "not friends");
            env.Ok("bob", "PUT", "/api/settings", new { allowStrangers = true });
            JsonElement g = env.Ok("alice", "POST", "/api/conversations", new { members = new[] { "bob" } });
            Assert.Equal("alice, Bob", S(g, "name"), "default name lists the members");
            env.Ok("bob", "POST", "/api/blocks", new { username = "alice" });
            Assert.Equal(403, env.Api("alice", "POST", "/api/conversations", new { name = "g", members = new[] { "bob" } }).Status, "blocked");
        }

        [Test]
        public static void DirectMessagesWorkByUsernameAndConversationId()
        {
            using var env = new Env();
            env.Befriend("alice", "bob");
            JsonElement sent = env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "hi" });
            Assert.Equal("dm:alice|bob", S(sent, "convId"), "dm id");
            Assert.Equal("Bob", S(sent, "to"), "dm 'to'");
            JsonElement byId = env.Ok("bob", "GET", "/api/conversations/dm:alice|bob/messages");
            Assert.Equal(1, byId.GetProperty("messages").GetArrayLength(), "by id");
            Assert.Equal("dm", S(byId.GetProperty("conversation"), "kind"), "kind");
            Assert.Equal("alice", S(byId.GetProperty("conversation"), "name"), "dm name is the other user");
            Assert.True(byId.GetProperty("conversation").GetProperty("friend").GetBoolean(), "friend flag");
            Assert.Equal(404, env.Api("carol", "GET", "/api/conversations/dm:alice|bob/messages").Status, "not your dm");
            env.Ok("bob", "POST", "/api/conversations/dm:alice|bob/messages", new { text = "yo", replyTo = sent.GetProperty("id").GetInt64() });
            JsonElement convs = env.Ok("alice", "GET", "/api/conversations");
            Assert.Equal(1, convs.GetProperty("conversations").GetArrayLength(), "one conversation");
            Assert.Equal(1, convs.GetProperty("unread").GetInt32(), "unread");
            Assert.Equal("yo", S(convs.GetProperty("conversations")[0].GetProperty("last"), "text"), "last");
            // An empty DM view exists before anything is said.
            Assert.Equal(0, env.Ok("alice", "GET", "/api/conversations/carol/messages").GetProperty("messages").GetArrayLength(), "empty dm");
        }

        [Test]
        public static void OldMessagesAndReadsMigrate()
        {
            using var env = new Env();
            env.Befriend("alice", "bob");
            env.Server.Dispose();
            File.WriteAllText(Path.Combine(env.Dir, "messages.jsonl"),
                "{\"k\":\"1\",\"v\":{\"Id\":1,\"From\":\"alice\",\"To\":\"bob\",\"Text\":\"old one\",\"Card\":null,\"Ts\":1000,\"Cid\":\"\"}}\n" +
                "{\"k\":\"2\",\"v\":{\"Id\":2,\"From\":\"bob\",\"To\":\"alice\",\"Text\":\"old two\",\"Card\":null,\"Ts\":2000,\"Cid\":\"\"}}\n" +
                "{\"k\":\"3\",\"v\":{\"Id\":3,\"From\":\"alice\",\"To\":\"bob\",\"Text\":\"old three\",\"Card\":null,\"Ts\":3000,\"Cid\":\"\"}}\n");
            File.WriteAllText(Path.Combine(env.Dir, "reads.jsonl"), "{\"k\":\"bob|alice|bob\",\"v\":{\"UpTo\":1}}\n{\"k\":\"alice|alice|bob\",\"v\":{\"UpTo\":2}}\n");
            if (File.Exists(Path.Combine(env.Dir, "conversations.jsonl"))) File.Delete(Path.Combine(env.Dir, "conversations.jsonl"));
            env.StartServer();

            JsonElement page = env.Ok("bob", "GET", "/api/conversations/alice/messages");
            Assert.Equal(3, page.GetProperty("messages").GetArrayLength(), "old messages are kept");
            Assert.Equal("dm:alice|bob", S(page.GetProperty("messages")[0], "convId"), "convId assigned");
            Assert.Equal(1, page.GetProperty("readUpTo").GetInt64(), "bob's old read position carried over");
            Assert.Equal(2, page.GetProperty("seenUpTo").GetInt64(), "alice's old read position carried over");
            JsonElement convs = env.Ok("bob", "GET", "/api/conversations");
            Assert.Equal(1, convs.GetProperty("conversations").GetArrayLength(), "the DM is listed");
            Assert.Equal(1, convs.GetProperty("unread").GetInt32(), "message 3 is unread (2 was sent by bob, 1 is read)");
            long next = env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "new" }).GetProperty("id").GetInt64();
            Assert.Equal(4, next, "ids continue");

            // The upgrade is persisted: a second start reads the new shapes.
            env.Restart();
            Assert.Equal(4, env.Ok("bob", "GET", "/api/conversations/alice/messages").GetProperty("messages").GetArrayLength(), "after restart");
            Assert.Equal(1, env.Ok("bob", "GET", "/api/conversations/alice/messages").GetProperty("readUpTo").GetInt64(), "read state persisted");
            Assert.True(File.ReadAllText(Path.Combine(env.Dir, "reads.jsonl")).Contains("bob|dm:alice|bob"), "read keys rewritten");
        }

        [Test]
        public static void AppHubRelaysRequestsAndEvents()
        {
            using var env = new Env();
            env.Befriend("alice", "bob");
            using var hub = new SocialHub(new SocialHubOptions
            {
                BaseUrl = () => "http://127.0.0.1:" + env.Server.Port,
                Token = () => FakeHub.TokenFor("bob"),
                ReconnectMin = TimeSpan.FromMilliseconds(100),
            });

            JsonObject reply = (JsonObject)hub.Request("GET", "/api/friends", null).GetAwaiter().GetResult();
            Assert.Equal(200, ((JsonNumber)reply["status"]).AsInt32(), "status passes through");
            Assert.True(((JsonString)reply["body"]).Value.Contains("alice"), "body passes through");
            Assert.Throws<ArgumentException>(() => hub.Request("GET", "/etc/passwd", null).GetAwaiter().GetResult());
            Assert.Throws<ArgumentException>(() => hub.Request("PATCH", "/api/friends", null).GetAwaiter().GetResult());

            Assert.False(hub.IsConnected, "idle until watched");
            hub.Watch(true);
            WaitFor(() => hub.IsConnected, "connects once watched");
            using var aliceSock = new Sock(env, "alice");
            aliceSock.Expect("hello");
            hub.SetPresence("lobby", "Speedrun", "l1");
            aliceSock.Expect("presence", p => S(p, "username") == "Bob" && S(p, "state") == "lobby");

            env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "hello app" });
            JsonObject events = null!;
            WaitFor(() =>
            {
                events = hub.Events(0);
                foreach (JsonNode e in (JsonArray)events["events"]) if (e is JsonObject o && ((JsonString)o["type"]).Value == "message") return true;
                return false;
            }, "the message event arrives");
            long seq = ((JsonNumber)events["seq"]).AsInt64();
            Assert.Equal(0, ((JsonArray)hub.Events(seq)["events"]).Count, "nothing new after the cursor");

            // A dropped socket reconnects by itself.
            env.Restart();
            long before = ((JsonNumber)hub.Events(0)["seq"]).AsInt64();
            WaitFor(() => hub.IsConnected && ((JsonNumber)hub.Events(0)["seq"]).AsInt64() > before, "reconnects after a server restart");
            hub.Watch(false);
            WaitFor(() => !hub.IsConnected, "closes when unwatched");
        }

        // ---- long polling and the R2 signer ----

        private static JsonElement Poll(Env env, string user, long since, int wait, string sid = "s1") =>
            env.Ok(user, "GET", "/api/events?since=" + since + "&wait=" + wait + "&sid=" + sid);

        private static bool HasEvent(JsonElement poll, string type, Func<JsonElement, bool>? where = null)
        {
            foreach (JsonElement e in poll.GetProperty("events").EnumerateArray())
                if (S(e, "type") == type && (where is null || where(e))) return true;
            return false;
        }

        [Test]
        public static void LongPollDeliversPushesAndPresence()
        {
            using var env = new Env();
            env.Befriend("alice", "bob");

            JsonElement first = Poll(env, "bob", 0, 0);
            Assert.True(HasEvent(first, "hello"), "the first poll starts with hello");
            long seq = first.GetProperty("seq").GetInt64();
            Assert.Equal(0, Poll(env, "bob", seq, 0).GetProperty("events").GetArrayLength(), "nothing new, no wait");

            // A waiting poll is answered the moment a message lands.
            var waiting = Task.Run(() => Poll(env, "bob", seq, 20));
            Thread.Sleep(300);
            Assert.False(waiting.IsCompleted, "the poll is holding");
            env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "over the poll" });
            Assert.True(waiting.Wait(5000), "the poll answered");
            JsonElement got = waiting.Result;
            Assert.True(HasEvent(got, "message", m => S(m.GetProperty("message"), "text") == "over the poll" || S(m, "text") == "over the poll"), "the message arrives");
            seq = got.GetProperty("seq").GetInt64();

            // The same cursor again returns the same events; a later cursor skips them.
            Assert.Equal(0, Poll(env, "bob", seq, 0).GetProperty("events").GetArrayLength(), "cursor moved on");

            // A timeout answers empty.
            var sw = System.Diagnostics.Stopwatch.StartNew();
            Assert.Equal(0, Poll(env, "bob", seq, 1).GetProperty("events").GetArrayLength(), "idle poll is empty");
            Assert.True(sw.ElapsedMilliseconds >= 800, "and waited");

            // Presence over REST reaches a friend on a socket, and goes offline when the poller disappears.
            using var aliceSock = new Sock(env, "alice");
            aliceSock.Expect("hello");
            env.Ok("bob", "POST", "/api/presence?sid=s1", new { state = "lobby", detail = "Speedrun", join = "l9" });
            aliceSock.Expect("presence", p => S(p, "username") == "Bob" && S(p, "state") == "lobby");
            Assert.Equal(400, env.Api("bob", "POST", "/api/presence?sid=s1", new { state = "bogus" }).Status, "bad state refused");
            env.Now = env.Now.AddSeconds(60);
            WaitForPresenceOffline(aliceSock);

            // A cursor from an older session (server restarted) resets.
            Assert.True(Poll(env, "carol", 999, 0).GetProperty("reset").GetBoolean(), "unknown cursor resets");
            Assert.Equal(401, env.Api("bob", "GET", "/api/events", null, "nope").Status, "needs a login");
        }

        private static void WaitForPresenceOffline(Sock sock) =>
            sock.Expect("presence", p => S(p, "username") == "Bob" && S(p, "state") == "offline", 12000);

        [Test]
        public static void AppHubFallsBackWhenTheSocketCannotConnect()
        {
            using var env = new Env();
            env.Befriend("alice", "bob");
            using var proxy = new PrefixProxy(env.Server.Port, "/social");   // no "/recharge/" in the path: the socket is tried first, and refused
            using var hub = new SocialHub(new SocialHubOptions
            {
                BaseUrl = () => proxy.Base,
                Token = () => FakeHub.TokenFor("bob"),
                ReconnectMin = TimeSpan.FromMilliseconds(100),
                PollWaitSeconds = 3,
            });
            hub.Watch(true);
            WaitFor(() => hub.IsConnected, "connects by long-polling after the socket fails");
            Assert.True(proxy.UpgradeAttempts >= 1, "the socket was tried first");
            hub.Watch(false);
        }

        [Test]
        public static void AppHubLongPollsThroughAPrefix()
        {
            using var env = new Env();
            env.Befriend("alice", "bob");
            using var proxy = new PrefixProxy(env.Server.Port, "/recharge/social");
            using var hub = new SocialHub(new SocialHubOptions
            {
                BaseUrl = () => proxy.Base,
                Token = () => FakeHub.TokenFor("bob"),
                ReconnectMin = TimeSpan.FromMilliseconds(100),
                PollWaitSeconds = 3,
            });
            hub.Watch(true);
            WaitFor(() => hub.IsConnected, "connects by long-polling");
            Assert.Equal(0, proxy.UpgradeAttempts, "no WebSocket was tried under /recharge/");
            using var aliceSock = new Sock(env, "alice");
            aliceSock.Expect("hello");
            hub.SetPresence("editing", "Cliffside", "");
            aliceSock.Expect("presence", p => S(p, "username") == "Bob" && S(p, "state") == "editing");
            env.Ok("alice", "POST", "/api/conversations/bob/messages", new { text = "hi bob" });
            WaitFor(() =>
            {
                foreach (JsonNode e in (JsonArray)hub.Events(0)["events"]) if (e is JsonObject o && ((JsonString)o["type"]).Value == "message") return true;
                return false;
            }, "the message arrives by long poll");
            Assert.False(hub.TrySend(new JsonObject()), "no socket to send on");
            hub.Watch(false);
            WaitFor(() => !hub.IsConnected, "stops when unwatched");
        }

        /// <summary>A tiny HTTP forwarder that serves the social server under a path prefix and refuses WebSocket upgrades, like the portal.</summary>
        private sealed class PrefixProxy : IDisposable
        {
            private readonly System.Net.HttpListener _l = new System.Net.HttpListener();
            private readonly HttpClient _http = new HttpClient { Timeout = TimeSpan.FromSeconds(40) };
            private readonly string _prefix;
            private readonly int _target;
            private int _upgrades;
            public string Base { get; }
            public int UpgradeAttempts => _upgrades;

            public PrefixProxy(int target, string prefix)
            {
                _target = target;
                _prefix = prefix;
                var probe = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
                probe.Start();
                int port = ((System.Net.IPEndPoint)probe.LocalEndpoint).Port;
                probe.Stop();
                Base = "http://127.0.0.1:" + port + prefix;
                _l.Prefixes.Add("http://127.0.0.1:" + port + "/");
                _l.Start();
                Task.Run(Loop);
            }

            private async Task Loop()
            {
                while (true)
                {
                    System.Net.HttpListenerContext c;
                    try { c = await _l.GetContextAsync().ConfigureAwait(false); } catch (Exception) { return; }
                    _ = Task.Run(() => Serve(c));
                }
            }

            private async Task Serve(System.Net.HttpListenerContext c)
            {
                try
                {
                    string path = c.Request.Url!.PathAndQuery;
                    if (c.Request.IsWebSocketRequest) { Interlocked.Increment(ref _upgrades); c.Response.StatusCode = 502; c.Response.Close(); return; }
                    if (!path.StartsWith(_prefix + "/", StringComparison.Ordinal)) { c.Response.StatusCode = 404; c.Response.Close(); return; }
                    using var req = new HttpRequestMessage(new HttpMethod(c.Request.HttpMethod), "http://127.0.0.1:" + _target + path.Substring(_prefix.Length));
                    string? auth = c.Request.Headers["Authorization"];
                    if (auth is not null) req.Headers.TryAddWithoutValidation("Authorization", auth);
                    if (c.Request.HasEntityBody)
                    {
                        using var ms = new MemoryStream();
                        await c.Request.InputStream.CopyToAsync(ms).ConfigureAwait(false);
                        req.Content = new ByteArrayContent(ms.ToArray());
                        req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
                    }
                    using HttpResponseMessage res = await _http.SendAsync(req).ConfigureAwait(false);
                    byte[] body = await res.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
                    c.Response.StatusCode = (int)res.StatusCode;
                    c.Response.ContentType = "application/json";
                    c.Response.ContentLength64 = body.Length;
                    await c.Response.OutputStream.WriteAsync(body).ConfigureAwait(false);
                    c.Response.Close();
                }
                catch (Exception) { try { c.Response.Abort(); } catch (Exception) { } }
            }

            public void Dispose()
            {
                try { _l.Stop(); } catch (Exception) { }
                _http.Dispose();
            }
        }

        [Test]
        public static void R2SignerMatchesTheAwsExample()
        {
            // The AWS documentation's presigned GET example (examplebucket/test.txt, 86400 s).
            string q = R2ShareSigner.Presign("GET", "examplebucket.s3.amazonaws.com", "/test.txt", "AKIAIOSFODNN7EXAMPLE",
                "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1", "s3", "20130524T000000Z", 86400);
            Assert.Equal("X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404", q, "AWS example");
        }

        [Test]
        public static void R2SignerSignsOnlyPrivateKeys()
        {
            var now = new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);
            var cfg = new R2Config { AccessKey = "AKTEST", Secret = "not-a-real-secret", Bucket = "bkt", Endpoint = "https://acct.r2.cloudflarestorage.com" };
            var signer = new R2ShareSigner(() => cfg, () => now);
            SignedLink link = signer.Sign("private/alice/my map", now.AddMinutes(5));
            Assert.True(link.Url.StartsWith("https://acct.r2.cloudflarestorage.com/bkt/private/alice/my%20map?X-Amz-Algorithm=AWS4-HMAC-SHA256&", StringComparison.Ordinal), "path-style URL");
            Assert.True(link.Url.Contains("X-Amz-Expires=300&", StringComparison.Ordinal), "lifetime");
            Assert.True(link.Url.Contains("X-Amz-Date=20260101T120000Z", StringComparison.Ordinal), "date");
            Assert.True(link.Url.Contains("X-Amz-Credential=AKTEST%2F20260101%2Fauto%2Fs3%2Faws4_request", StringComparison.Ordinal), "scope");
            Assert.Equal(now.AddMinutes(5), link.Expires, "expiry");
            Assert.Equal(400, Assert.Throws<SocialException>(() => signer.Sign("approved/x/y.zip", now.AddMinutes(5))).Status, "public files are never signed");
            Assert.Equal(400, Assert.Throws<SocialException>(() => signer.Sign("private/../approved/x", now.AddMinutes(5))).Status, "no traversal");
            Assert.Equal(503, Assert.Throws<SocialException>(() => new R2ShareSigner(() => null, () => now).Sign("private/a/b", now.AddMinutes(5))).Status, "unconfigured");

            string file = Path.Combine(Path.GetTempPath(), "r2-test-" + Guid.NewGuid().ToString("N") + ".env");
            File.WriteAllText(file, "# c\nR2_ACCOUNT_ID=acct\nexport R2_ACCESS_KEY_ID='AKTEST'\nR2_SECRET_ACCESS_KEY=\"zzz\"\nR2_BUCKET=bkt\n");
            try
            {
                R2Config? loaded = R2Config.Load(_ => null, file);
                Assert.True(loaded is not null, "env file loads");
                Assert.Equal("https://acct.r2.cloudflarestorage.com", loaded!.Endpoint, "endpoint from the account");
                Assert.Equal("AKTEST", loaded.AccessKey, "quotes stripped");
            }
            finally { File.Delete(file); }
            Assert.True(R2Config.Load(_ => null, Path.Combine(Path.GetTempPath(), "missing-r2.env")) is null, "no file, no config");
        }

        [Test]
        public static void ShareKeysMustBeTheCallersPrivateFolder()
        {
            using var env = new Env();
            env.Befriend("alice", "bob");
            Assert.Equal(400, env.Api("alice", "POST", "/api/shares", new { mapId = "m1", with = "bob", objectKey = "approved/x/y.zip" }).Status, "public key refused");
            Assert.Equal(400, env.Api("alice", "POST", "/api/shares", new { mapId = "m1", with = "bob", objectKey = "private/bob/m1" }).Status, "another user's folder refused");
            Assert.Equal(200, env.Api("alice", "POST", "/api/shares", new { mapId = "m1", with = "bob", objectKey = "private/alice/m1" }).Status, "own folder fine");
        }

        /// <summary>
        /// A rehearsal against a real hub + proxy + bundled server, started by hand (see social-deploy.sh's notes). Skipped unless
        /// RECHARGE_REHEARSAL_HUB (the hub base, e.g. http://127.0.0.1:3555) is set; the social server is then at HUB/social.
        /// </summary>
        [Test]
        public static void RehearsalThroughTheHubProxy()
        {
            string? hubBase = Environment.GetEnvironmentVariable("RECHARGE_REHEARSAL_HUB");
            if (string.IsNullOrEmpty(hubBase)) return;
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
            string Register(string name)
            {
                var res = http.PostAsync(hubBase + "/api/register", new StringContent("{\"username\":\"" + name + "\",\"password\":\"pw1234\"}", Encoding.UTF8, "application/json")).GetAwaiter().GetResult();
                using JsonDocument d = JsonDocument.Parse(res.Content.ReadAsStringAsync().GetAwaiter().GetResult());
                return d.RootElement.GetProperty("token").GetString()!;
            }
            string aliceToken = Register("RehearsalAlice"), bobToken = Register("RehearsalBob");
            SocialHub Make(string token) => new SocialHub(new SocialHubOptions { BaseUrl = () => hubBase + "/social", Token = () => token, ReconnectMin = TimeSpan.FromMilliseconds(200), PollWaitSeconds = 5 });
            using SocialHub alice = Make(aliceToken), bob = Make(bobToken);
            int Status(JsonNode n) => ((JsonNumber)((JsonObject)n)["status"]).AsInt32();
            Assert.Equal(200, Status(alice.Request("GET", "/api/friends", null).GetAwaiter().GetResult()), "alice reaches the server and the hub accepts her token");
            bob.Watch(true);
            WaitFor(() => bob.IsConnected, "bob connects");
            Console.WriteLine("rehearsal: bob connected by " + (bob.TrySend(new JsonObject()) ? "websocket" : "long poll"));
            Assert.Equal(200, Status(alice.Request("POST", "/api/friends/request", JsonReader.Parse("{\"username\":\"RehearsalBob\"}")).GetAwaiter().GetResult()), "friend request");
            Assert.Equal(200, Status(bob.Request("POST", "/api/friends/accept", JsonReader.Parse("{\"username\":\"RehearsalAlice\"}")).GetAwaiter().GetResult()), "accepted");
            Assert.Equal(200, Status(alice.Request("POST", "/api/conversations/RehearsalBob/messages", JsonReader.Parse("{\"text\":\"hello through the proxy\"}")).GetAwaiter().GetResult()), "message sent");
            WaitFor(() =>
            {
                foreach (JsonNode e in (JsonArray)bob.Events(0)["events"])
                    if (e is JsonObject o && ((JsonString)o["type"]).Value == "message" && ((JsonString)((JsonObject)o["message"])["text"]).Value == "hello through the proxy") return true;
                return false;
            }, "bob receives the message");
            JsonObject conv = (JsonObject)bob.Request("GET", "/api/conversations/RehearsalAlice/messages", null).GetAwaiter().GetResult();
            Assert.True(((JsonString)conv["body"]).Value.Contains("hello through the proxy"), "history has it too");
            Console.WriteLine("rehearsal: friend request, accept, message and long-poll delivery all worked");
            bob.Watch(false);
        }

        [Test]
        public static void ServerCategoriesRolesAndEmojiArsenal()
        {
            using var env = new Env();
            const string png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

            // alice makes a server: she owns it, so she manages it and it starts with no categories or roles.
            JsonElement sv = env.Ok("alice", "POST", "/api/servers", new { name = "Rec" });
            string id = S(sv, "id");
            Assert.True(sv.GetProperty("manage").GetBoolean(), "owner manages");
            Assert.Equal(0, sv.GetProperty("categories").GetArrayLength(), "no categories yet");

            // a category, with a channel created straight into it; rename it; delete it (its channel falls back to uncategorised).
            string catId = S(env.Ok("alice", "POST", $"/api/servers/{id}/categories", new { name = "Art Stuff" }), "id");
            JsonElement ch = env.Ok("alice", "POST", $"/api/servers/{id}/channels", new { name = "fanart", kind = "text", categoryId = catId });
            Assert.Equal(catId, S(ch, "categoryId"), "channel lands in the category");
            Assert.Equal("Art", S(env.Ok("alice", "PATCH", $"/api/servers/{id}/categories/{catId}", new { name = "Art" }), "name"), "category renamed");
            env.Ok("alice", "DELETE", $"/api/servers/{id}/categories/{catId}");
            Assert.Equal("", S(FindChannel(env.Ok("alice", "GET", "/api/servers"), id, S(ch, "id")), "categoryId"), "channel falls back to uncategorised");

            // roles: add bob, make an admin role, assign it -> bob manages too; a bad colour is rejected.
            env.Ok("alice", "POST", $"/api/servers/{id}/members", new { username = "bob" });
            string roleId = S(env.Ok("alice", "POST", $"/api/servers/{id}/roles", new { name = "Mod", color = "#88ccff", admin = true }), "id");
            Assert.Equal(400, env.Api("alice", "POST", $"/api/servers/{id}/roles", new { name = "Bad", color = "nope" }).Status, "bad colour rejected");
            env.Ok("alice", "PUT", $"/api/servers/{id}/members/bob/roles", new { roleIds = new[] { roleId } });
            JsonElement svBob = FindServer(env.Ok("bob", "GET", "/api/servers"), id);
            Assert.True(svBob.GetProperty("manage").GetBoolean(), "bob manages via admin role");
            Assert.True(Member(svBob, "bob").GetProperty("admin").GetBoolean(), "bob shows admin");

            // server emoji added while alice + bob are the members -> both unlock it; it still renders for everyone (global registry).
            env.Ok("alice", "POST", $"/api/servers/{id}/emojis", new { shortcode = "rec_pog", mime = "image/png", data = png });
            Assert.True(HasArsenal(env, "bob", "rec_pog"), "member bob unlocked it");
            Assert.True(HasArsenal(env, "alice", "rec_pog"), "owner has it");
            Assert.True(Has(env.Ok("bob", "GET", "/api/emojis"), "rec_pog"), "renders globally for everyone");

            // carol joins AFTER the emoji exists -> she gets it on join; but as a plain member she can't manage.
            env.Ok("alice", "POST", $"/api/servers/{id}/members", new { username = "carol" });
            Assert.True(HasArsenal(env, "carol", "rec_pog"), "joining unlocked the server's emoji");
            Assert.Equal(403, env.Api("carol", "POST", $"/api/servers/{id}/channels", new { name = "nope", kind = "text" }).Status, "plain member can't manage");
            env.Ok("bob", "POST", $"/api/servers/{id}/channels", new { name = "mod-log", kind = "text" });   // admin bob can

            // removing the emoji from the server set leaves it in everyone's arsenal (it's theirs now); deleting the role drops bob's admin.
            env.Ok("alice", "DELETE", $"/api/servers/{id}/emojis/rec_pog");
            Assert.False(Has(env.Ok("alice", "GET", $"/api/servers/{id}/emojis"), "rec_pog"), "off the server set");
            Assert.True(HasArsenal(env, "carol", "rec_pog"), "but carol keeps it forever");
            env.Ok("alice", "DELETE", $"/api/servers/{id}/roles/{roleId}");
            Assert.False(Member(FindServer(env.Ok("bob", "GET", "/api/servers"), id), "bob").GetProperty("admin").GetBoolean(), "admin gone with the role");
        }

        private static JsonElement FindServer(JsonElement servers, string id) =>
            servers.GetProperty("servers").EnumerateArray().First(s => S(s, "id") == id);
        private static JsonElement FindChannel(JsonElement servers, string serverId, string channelId) =>
            FindServer(servers, serverId).GetProperty("channels").EnumerateArray().First(c => S(c, "id") == channelId);
        private static JsonElement Member(JsonElement server, string name) =>
            server.GetProperty("members").EnumerateArray().First(m => string.Equals(S(m, "username"), name, StringComparison.OrdinalIgnoreCase));
        private static bool Has(JsonElement list, string shortcode) =>
            list.EnumerateArray().Any(e => S(e, "shortcode") == shortcode);
        private static bool HasArsenal(Env env, string user, string shortcode) =>
            Has(env.Ok(user, "GET", "/api/emojis/mine"), shortcode);

        private static void WaitFor(Func<bool> condition, string what, int ms = 8000)
        {
            var until = DateTime.UtcNow.AddMilliseconds(ms);
            while (DateTime.UtcNow < until)
            {
                if (condition()) return;
                Thread.Sleep(25);
            }
            throw new AssertException("timed out: " + what);
        }
    }
}

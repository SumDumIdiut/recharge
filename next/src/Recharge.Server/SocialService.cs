using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Recharge.Server
{
    /// <summary>
    /// The social rules: friends, blocks, messages, presence and private shares. Everything runs under one lock; replies are
    /// plain objects the transport serialises. Pushes (to a user's open sockets) go through the Push event.
    /// </summary>
    public sealed partial class SocialService : IDisposable
    {
        private static readonly Regex MapIdRe = new Regex("^[A-Za-z0-9._-]{1,64}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex ObjectKeyRe = new Regex("^[A-Za-z0-9._/-]{1,200}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex NameRe = new Regex(@"^[\p{L}\p{N}_.\- ]{1,40}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        private readonly SocialOptions _o;
        private readonly IShareSigner _signer;
        private readonly object _gate = new object();
        private readonly JsonlStore<UserRec> _users;
        private readonly JsonlStore<FriendRec> _friends;
        private readonly JsonlStore<RequestRec> _requests;
        private readonly JsonlStore<BlockRec> _blocks;
        private readonly JsonlStore<MessageRec> _messages;
        private readonly JsonlStore<ReadRec> _reads;
        private readonly JsonlStore<SettingsRec> _settings;
        private readonly JsonlStore<ShareRec> _shares;
        private readonly JsonlStore<ProfileRec> _profiles;
        private readonly Dictionary<string, List<MessageRec>> _byConv = new Dictionary<string, List<MessageRec>>(StringComparer.Ordinal);
        private readonly Dictionary<string, Dictionary<int, Live>> _live = new Dictionary<string, Dictionary<int, Live>>(StringComparer.Ordinal);
        private readonly RateLimiter _messageLimit;
        private readonly RateLimiter _requestLimit;
        private readonly RateLimiter _shareLimit;
        private long _lastMessageId;

        private sealed class Live
        {
            public string State = "online";
            public string Detail = "";
            public string Join = "";
            public long At;
        }

        /// <summary>Raised with (lower-case username, payload) for each push to a user's open sockets. Handlers must not block or call back in.</summary>
        public event Action<string, object>? Push;

        public SocialService(SocialOptions options, IShareSigner signer)
        {
            _o = options;
            _signer = signer;
            string dir = options.DataDir;
            _users = new JsonlStore<UserRec>(System.IO.Path.Combine(dir, "users.jsonl"));
            _friends = new JsonlStore<FriendRec>(System.IO.Path.Combine(dir, "friends.jsonl"));
            _requests = new JsonlStore<RequestRec>(System.IO.Path.Combine(dir, "requests.jsonl"));
            _blocks = new JsonlStore<BlockRec>(System.IO.Path.Combine(dir, "blocks.jsonl"));
            _messages = new JsonlStore<MessageRec>(System.IO.Path.Combine(dir, "messages.jsonl"));
            _reads = new JsonlStore<ReadRec>(System.IO.Path.Combine(dir, "reads.jsonl"));
            _settings = new JsonlStore<SettingsRec>(System.IO.Path.Combine(dir, "settings.jsonl"));
            _shares = new JsonlStore<ShareRec>(System.IO.Path.Combine(dir, "shares.jsonl"));
            _profiles = new JsonlStore<ProfileRec>(System.IO.Path.Combine(dir, "profiles.jsonl"));
            _profileLimit = new RateLimiter(options.ProfileWritesPerHour, TimeSpan.FromHours(1), options.Clock);
            _messageLimit = new RateLimiter(options.MessagesPerMinute, TimeSpan.FromMinutes(1), options.Clock);
            _requestLimit = new RateLimiter(options.FriendRequestsPerHour, TimeSpan.FromHours(1), options.Clock);
            _shareLimit = new RateLimiter(options.SharesPerHour, TimeSpan.FromHours(1), options.Clock);
            foreach (MessageRec m in _messages.Items.Values.OrderBy(m => m.Id))
            {
                ConvList(Conv(m.From, m.To)).Add(m);
                if (m.Id > _lastMessageId) _lastMessageId = m.Id;
            }
        }

        public void Dispose()
        {
            _users.Dispose(); _friends.Dispose(); _requests.Dispose(); _blocks.Dispose();
            _messages.Dispose(); _reads.Dispose(); _settings.Dispose(); _shares.Dispose(); _profiles.Dispose();
        }

        // ---- names ----

        public static string Norm(string name) => name.Trim().ToLowerInvariant();

        public static bool ValidName(string? name) => name is not null && NameRe.IsMatch(name);

        private long Now() => _o.Clock().ToUnixTimeMilliseconds();

        private static string Pair(string a, string b) => string.CompareOrdinal(a, b) <= 0 ? a + "|" + b : b + "|" + a;
        private static string Conv(string a, string b) => Pair(a, b);

        private List<MessageRec> ConvList(string conv)
        {
            if (!_byConv.TryGetValue(conv, out List<MessageRec>? l)) _byConv[conv] = l = new List<MessageRec>();
            return l;
        }

        /// <summary>Remember a user's spelling (called whenever the hub confirms one).</summary>
        public string Remember(string name)
        {
            lock (_gate)
            {
                string key = Norm(name);
                if (!_users.TryGet(key, out UserRec? u) || u.Name != name) _users.Put(key, new UserRec { Name = name });
                return name;
            }
        }

        /// <summary>The stored spelling for a username, or null when the server has never seen it.</summary>
        public string? KnownName(string name)
        {
            lock (_gate) return _users.TryGet(Norm(name), out UserRec? u) ? u.Name : null;
        }

        private string Display(string key) => _users.TryGet(key, out UserRec? u) ? u.Name : key;

        private bool IsBlocked(string a, string b) =>
            _blocks.Items.ContainsKey(a + "|" + b) || _blocks.Items.ContainsKey(b + "|" + a);

        private bool AreFriends(string a, string b) => _friends.Items.ContainsKey(Pair(a, b));

        private IEnumerable<string> FriendsOf(string me)
        {
            foreach (FriendRec f in _friends.Items.Values)
            {
                if (f.A == me) yield return f.B;
                else if (f.B == me) yield return f.A;
            }
        }

        private void Notify(string user, object payload) => Push?.Invoke(user, payload);

        // ---- friends ----

        public object Friends(string meName)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                var friends = new List<object>();
                foreach (string f in FriendsOf(me).OrderBy(x => Display(x), StringComparer.OrdinalIgnoreCase))
                {
                    if (IsBlocked(me, f)) continue;
                    PresenceView p = PresenceFor(me, f);
                    friends.Add(new { username = Display(f), since = _friends.Items[Pair(me, f)].Since, state = p.State, detail = p.Detail, join = p.Join });
                }
                var incoming = _requests.Items.Values.Where(r => r.To == me && !IsBlocked(me, r.From))
                    .OrderBy(r => r.Created).Select(r => (object)new { username = Display(r.From), created = r.Created }).ToList();
                var outgoing = _requests.Items.Values.Where(r => r.From == me && !IsBlocked(me, r.To))
                    .OrderBy(r => r.Created).Select(r => (object)new { username = Display(r.To), created = r.Created }).ToList();
                var blocked = _blocks.Items.Values.Where(b => b.Blocker == me)
                    .OrderBy(b => Display(b.Blocked), StringComparer.OrdinalIgnoreCase).Select(b => (object)new { username = Display(b.Blocked), created = b.Created }).ToList();
                return new { friends, incoming, outgoing, blocked };
            }
        }

        public object RequestFriend(string meName, string targetName)
        {
            lock (_gate)
            {
                string me = Norm(meName), t = Norm(targetName);
                if (me == t) throw new SocialException(400, "You can't add yourself.");
                if (IsBlocked(me, t)) throw new SocialException(404, "That user was not found.");
                if (AreFriends(me, t)) throw new SocialException(409, "You are already friends.");
                if (_requests.Items.ContainsKey(t + "|" + me)) return AcceptLocked(me, t);
                if (_requests.Items.ContainsKey(me + "|" + t)) return new { status = "pending" };
                _requestLimit.Hit(me, "You are sending too many friend requests.");
                if (FriendsOf(me).Count() >= _o.MaxFriends) throw new SocialException(403, "Your friend list is full.");
                if (_requests.Items.Values.Count(r => r.To == t) >= _o.MaxPendingRequests)
                    throw new SocialException(403, "That user has too many pending requests.");
                _requests.Put(me + "|" + t, new RequestRec { From = me, To = t, Created = Now() });
                Notify(t, new { type = "friends" });
                Notify(me, new { type = "friends" });
                return new { status = "pending" };
            }
        }

        public object Accept(string meName, string fromName)
        {
            lock (_gate) return AcceptLocked(Norm(meName), Norm(fromName));
        }

        private object AcceptLocked(string me, string from)
        {
            if (IsBlocked(me, from) || !_requests.Items.ContainsKey(from + "|" + me))
                throw new SocialException(404, "There is no request from that user.");
            if (FriendsOf(me).Count() >= _o.MaxFriends) throw new SocialException(403, "Your friend list is full.");
            if (FriendsOf(from).Count() >= _o.MaxFriends) throw new SocialException(403, "That user's friend list is full.");
            _requests.Remove(from + "|" + me);
            _requests.Remove(me + "|" + from);
            _friends.Put(Pair(me, from), new FriendRec { A = string.CompareOrdinal(me, from) <= 0 ? me : from, B = string.CompareOrdinal(me, from) <= 0 ? from : me, Since = Now() });
            Notify(me, new { type = "friends" });
            Notify(from, new { type = "friends" });
            PushPresenceTo(me, from);
            PushPresenceTo(from, me);
            return new { status = "friends" };
        }

        public object Decline(string meName, string fromName)
        {
            lock (_gate)
            {
                string me = Norm(meName), from = Norm(fromName);
                if (!_requests.Remove(from + "|" + me)) throw new SocialException(404, "There is no request from that user.");
                Notify(me, new { type = "friends" });
                Notify(from, new { type = "friends" });
                return new { status = "declined" };
            }
        }

        /// <summary>Removes a friend, or cancels a request in either direction.</summary>
        public object RemoveFriend(string meName, string otherName)
        {
            lock (_gate)
            {
                string me = Norm(meName), o = Norm(otherName);
                bool was = _friends.Remove(Pair(me, o));
                bool r1 = _requests.Remove(me + "|" + o);
                bool r2 = _requests.Remove(o + "|" + me);
                if (!was && !r1 && !r2) throw new SocialException(404, "That user is not on your list.");
                Notify(me, new { type = "friends" });
                Notify(o, new { type = "friends" });
                if (was) { PushOffline(me, o); PushOffline(o, me); }
                return new { status = "removed" };
            }
        }

        public object Block(string meName, string targetName)
        {
            lock (_gate)
            {
                string me = Norm(meName), t = Norm(targetName);
                if (me == t) throw new SocialException(400, "You can't block yourself.");
                if (!_blocks.Items.ContainsKey(me + "|" + t))
                    _blocks.Put(me + "|" + t, new BlockRec { Blocker = me, Blocked = t, Created = Now() });
                bool was = _friends.Remove(Pair(me, t));
                _requests.Remove(me + "|" + t);
                _requests.Remove(t + "|" + me);
                Notify(me, new { type = "friends" });
                Notify(t, new { type = "friends" });
                if (was) { PushOffline(me, t); PushOffline(t, me); }
                return new { status = "blocked" };
            }
        }

        public object Unblock(string meName, string targetName)
        {
            lock (_gate)
            {
                string me = Norm(meName), t = Norm(targetName);
                if (!_blocks.Remove(me + "|" + t)) throw new SocialException(404, "That user is not blocked.");
                Notify(me, new { type = "friends" });
                return new { status = "unblocked" };
            }
        }

        public object Blocks(string meName)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                var blocked = _blocks.Items.Values.Where(b => b.Blocker == me)
                    .OrderBy(b => Display(b.Blocked), StringComparer.OrdinalIgnoreCase).Select(b => (object)new { username = Display(b.Blocked), created = b.Created }).ToList();
                return new { blocked };
            }
        }

        // ---- settings ----

        public object GetSettings(string meName)
        {
            lock (_gate)
            {
                SettingsRec s = SettingsOf(Norm(meName));
                return new { allowStrangers = s.AllowStrangers, invisible = s.Invisible };
            }
        }

        public object PutSettings(string meName, bool? allowStrangers, bool? invisible)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                SettingsRec s = SettingsOf(me);
                var next = new SettingsRec { AllowStrangers = allowStrangers ?? s.AllowStrangers, Invisible = invisible ?? s.Invisible };
                _settings.Put(me, next);
                if (next.Invisible != s.Invisible)
                {
                    foreach (string f in FriendsOf(me).Where(f => !IsBlocked(me, f)).ToList()) PushPresenceTo(me, f);
                }
                return new { allowStrangers = next.AllowStrangers, invisible = next.Invisible };
            }
        }

        private SettingsRec SettingsOf(string key) => _settings.TryGet(key, out SettingsRec? s) ? s : new SettingsRec();

        // ---- messages ----

        public object Conversations(string meName)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                var rows = new List<(long Ts, int Unread, object Row)>();
                foreach (KeyValuePair<string, List<MessageRec>> c in _byConv)
                {
                    string[] parts = c.Key.Split('|');
                    if (parts[0] != me && parts[1] != me) continue;
                    string other = parts[0] == me ? parts[1] : parts[0];
                    if (IsBlocked(me, other) || c.Value.Count == 0) continue;
                    MessageRec last = c.Value[c.Value.Count - 1];
                    long readUpTo = _reads.TryGet(me + "|" + c.Key, out ReadRec? r) ? r.UpTo : 0;
                    int unread = c.Value.Count(m => m.To == me && m.Id > readUpTo);
                    PresenceView p = PresenceFor(me, other);
                    rows.Add((last.Ts, unread, new { username = Display(other), last = Project(last), unread, state = p.State, friend = AreFriends(me, other) }));
                }
                var top = rows.OrderByDescending(r => r.Ts).Take(200).ToList();
                return new { conversations = top.Select(r => r.Row).ToList(), unread = top.Sum(r => r.Unread) };
            }
        }

        public object Messages(string meName, string otherName, long before, int limit)
        {
            lock (_gate)
            {
                string me = Norm(meName), o = Norm(otherName);
                if (IsBlocked(me, o)) throw new SocialException(404, "That conversation was not found.");
                limit = Math.Clamp(limit, 1, 100);
                List<MessageRec> all = _byConv.TryGetValue(Conv(me, o), out List<MessageRec>? l) ? l : new List<MessageRec>();
                IEnumerable<MessageRec> older = before > 0 ? all.Where(m => m.Id < before) : all;
                List<MessageRec> page = older.Reverse().Take(limit + 1).ToList();
                bool more = page.Count > limit;
                if (more) page.RemoveAt(page.Count - 1);
                page.Reverse();
                long readUpTo = _reads.TryGet(me + "|" + Conv(me, o), out ReadRec? r) ? r.UpTo : 0;
                return new { messages = page.Select(Project).ToList(), hasMore = more, readUpTo };
            }
        }

        public object Send(string meName, string otherName, string? text, CardRec? card)
        {
            lock (_gate)
            {
                string me = Norm(meName), o = Norm(otherName);
                if (me == o) throw new SocialException(400, "You can't message yourself.");
                if (IsBlocked(me, o)) throw new SocialException(403, "You can't message this user.");
                if (!AreFriends(me, o) && !SettingsOf(o).AllowStrangers)
                    throw new SocialException(403, "Only friends can message each other.");
                string body = CleanText(text);
                if (body.Length == 0 && card is null) throw new SocialException(400, "A message can't be empty.");
                if (body.Length > _o.MaxMessageChars) throw new SocialException(400, "That message is too long (" + _o.MaxMessageChars + " characters at most).");
                if (card is not null)
                {
                    if (card.Type != "map" && card.Type != "skin" && card.Type != "lobby") throw new SocialException(400, "Unknown card type.");
                    if (string.IsNullOrEmpty(card.Id) || card.Id.Length > 64) throw new SocialException(400, "A card needs an id (64 characters at most).");
                    if ((card.Name ?? "").Length > 80) throw new SocialException(400, "A card name is too long.");
                    card.Name = CleanText(card.Name);
                }
                _messageLimit.Hit(me, "You are sending messages too fast.");
                var m = new MessageRec { Id = ++_lastMessageId, From = me, To = o, Text = body, Card = card, Ts = Now() };
                _messages.Put(m.Id.ToString(System.Globalization.CultureInfo.InvariantCulture), m);
                ConvList(Conv(me, o)).Add(m);
                object view = Project(m);
                Notify(o, new { type = "message", message = view });
                Notify(me, new { type = "message", message = view });
                return view;
            }
        }

        public object MarkRead(string meName, string otherName, long upTo)
        {
            lock (_gate)
            {
                string me = Norm(meName), o = Norm(otherName);
                string key = me + "|" + Conv(me, o);
                long cur = _reads.TryGet(key, out ReadRec? r) ? r.UpTo : 0;
                if (upTo > cur) _reads.Put(key, new ReadRec { UpTo = Math.Min(upTo, _lastMessageId) });
                Notify(me, new { type = "read", username = Display(o) });
                return new { readUpTo = Math.Max(cur, Math.Min(upTo, _lastMessageId)) };
            }
        }

        private object Project(MessageRec m) => new { id = m.Id, from = Display(m.From), to = Display(m.To), text = m.Text, card = m.Card, ts = m.Ts };

        private static string CleanText(string? text)
        {
            if (string.IsNullOrEmpty(text)) return "";
            var sb = new StringBuilder(text.Length);
            foreach (char c in text)
            {
                if (c == '\n' || c == '\t' || (c >= ' ' && c != (char)0x7F && c != (char)0x2028 && c != (char)0x2029 && (c < (char)0x202A || c > (char)0x202E))) sb.Append(c);
            }
            return sb.ToString().Trim();
        }

        // ---- presence ----

        private readonly struct PresenceView
        {
            public PresenceView(string state, string detail, string join) { State = state; Detail = detail; Join = join; }
            public string State { get; }
            public string Detail { get; }
            public string Join { get; }
        }

        private static int Rank(string state) => state switch { "editing" => 4, "lobby" => 3, "game" => 2, _ => 1 };

        /// <summary>What <paramref name="viewer"/> may see of <paramref name="user"/>: offline unless friends, not blocked and not invisible.</summary>
        private PresenceView PresenceFor(string viewer, string user)
        {
            var offline = new PresenceView("offline", "", "");
            if (!AreFriends(viewer, user) || IsBlocked(viewer, user) || SettingsOf(user).Invisible) return offline;
            if (!_live.TryGetValue(user, out Dictionary<int, Live>? conns) || conns.Count == 0) return offline;
            Live best = conns.Values.OrderByDescending(c => Rank(c.State)).ThenByDescending(c => c.At).First();
            return new PresenceView(best.State, best.Detail, best.Join);
        }

        private void PushPresenceTo(string user, string viewer)
        {
            PresenceView p = PresenceFor(viewer, user);
            Notify(viewer, new { type = "presence", username = Display(user), state = p.State, detail = p.Detail, join = p.Join });
        }

        private void PushOffline(string user, string viewer) =>
            Notify(viewer, new { type = "presence", username = Display(user), state = "offline", detail = "", join = "" });

        private void BroadcastPresence(string user)
        {
            foreach (string f in FriendsOf(user).ToList()) PushPresenceTo(user, f);
        }

        /// <summary>Registers a socket; returns the hello payload (the friends' presence).</summary>
        public object Connect(string meName, int connId)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                if (!_live.TryGetValue(me, out Dictionary<int, Live>? conns)) _live[me] = conns = new Dictionary<int, Live>();
                if (conns.Count >= _o.MaxConnectionsPerUser) throw new SocialException(429, "Too many connections for this account.");
                conns[connId] = new Live { At = Now() };
                BroadcastPresence(me);
                var friends = FriendsOf(me).Where(f => !IsBlocked(me, f)).Select(f =>
                {
                    PresenceView p = PresenceFor(me, f);
                    return (object)new { username = Display(f), state = p.State, detail = p.Detail, join = p.Join };
                }).ToList();
                return new { type = "hello", username = Display(me), friends };
            }
        }

        public void SetPresence(string meName, int connId, string? state, string? detail, string? join)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                if (!_live.TryGetValue(me, out Dictionary<int, Live>? conns) || !conns.TryGetValue(connId, out Live? c)) return;
                string s = state ?? "online";
                if (s != "online" && s != "game" && s != "lobby" && s != "editing") throw new SocialException(400, "Unknown presence state.");
                c.State = s;
                c.Detail = CleanText(detail);
                if (c.Detail.Length > 80) c.Detail = c.Detail.Substring(0, 80);
                c.Join = CleanText(join);
                if (c.Join.Length > 64) c.Join = "";
                c.At = Now();
                BroadcastPresence(me);
            }
        }

        public void Disconnect(string meName, int connId)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                if (!_live.TryGetValue(me, out Dictionary<int, Live>? conns) || !conns.Remove(connId)) return;
                if (conns.Count == 0) _live.Remove(me);
                BroadcastPresence(me);
            }
        }

        // ---- private shares ----

        public object CreateShare(string meName, string? mapId, string? name, string? mode, string? withUser, bool link, long ttlSeconds, string? objectKey)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                if (mapId is null || !MapIdRe.IsMatch(mapId)) throw new SocialException(400, "That map id isn't valid.");
                string label = CleanText(name);
                if (label.Length == 0) label = mapId;
                if (label.Length > 80) throw new SocialException(400, "The map name is too long (80 characters at most).");
                string m = mode ?? "view";
                if (m != "view" && m != "edit") throw new SocialException(400, "Mode must be view or edit.");
                bool toFriend = !string.IsNullOrEmpty(withUser);
                if (toFriend == link) throw new SocialException(400, "Share with a friend or make a link, not both.");
                if (link && m != "view") throw new SocialException(400, "A private link can only give view access.");
                string key = objectKey ?? ("private/" + me + "/" + mapId);
                if (objectKey is not null && !key.StartsWith("private/" + me + "/", StringComparison.Ordinal)) throw new SocialException(400, "That file key isn't valid.");
                if (!ObjectKeyRe.IsMatch(key) || key.Contains("..")) throw new SocialException(400, "That file key isn't valid.");
                string target = "";
                if (toFriend)
                {
                    target = Norm(withUser!);
                    if (target == me) throw new SocialException(400, "You can't share with yourself.");
                    if (IsBlocked(me, target) || !AreFriends(me, target)) throw new SocialException(403, "You can only share with your friends.");
                }
                if (ttlSeconds < 0 || ttlSeconds > (long)_o.MaxLinkLifetime.TotalSeconds) throw new SocialException(400, "That expiry is too long.");
                if (_shares.Items.Values.Count(s => s.Owner == me && !s.Revoked) >= _o.MaxSharesPerUser) throw new SocialException(403, "You have too many active shares.");
                _shareLimit.Hit(me, "You are sharing too fast.");

                string token = "";
                string tokenHash = "";
                if (link)
                {
                    token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)).Replace('+', '-').Replace('/', '_').TrimEnd('=');
                    tokenHash = HashToken(token);
                }
                var share = new ShareRec
                {
                    Id = Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant(),
                    Owner = me, MapId = mapId, Name = label, ObjectKey = key, Mode = m, Target = target, TokenHash = tokenHash,
                    Created = Now(), Expires = ttlSeconds > 0 ? _o.Clock().ToUnixTimeMilliseconds() + ttlSeconds * 1000 : 0,
                };
                _shares.Put(share.Id, share);
                if (target.Length > 0) Notify(target, new { type = "share", share = ShareView(share, null, me) });
                return ShareView(share, link ? token : null, me);
            }
        }

        public object Shares(string meName)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                var owned = _shares.Items.Values.Where(s => s.Owner == me && !s.Revoked).OrderByDescending(s => s.Created)
                    .Select(s => ShareView(s, null, me)).ToList();
                var received = _shares.Items.Values.Where(s => s.Target == me && !s.Revoked && !Expired(s) && !IsBlocked(me, s.Owner))
                    .OrderByDescending(s => s.Created).Select(s => ShareView(s, null, me)).ToList();
                return new { owned, received };
            }
        }

        public object Revoke(string meName, string id)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                if (!_shares.TryGet(id, out ShareRec? s) || s.Owner != me || s.Revoked) throw new SocialException(404, "That share was not found.");
                s.Revoked = true;
                _shares.Put(s.Id, s);
                if (s.Target.Length > 0) Notify(s.Target, new { type = "share-revoked", id = s.Id });
                return new { status = "revoked" };
            }
        }

        /// <summary>A short-lived signed download link for the owner or the friend a share was made for.</summary>
        public object ShareDownload(string meName, string id)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                if (!_shares.TryGet(id, out ShareRec? s) || s.Revoked || Expired(s)) throw new SocialException(404, "That share was not found.");
                bool owner = s.Owner == me;
                if (!owner && (s.Target != me || IsBlocked(me, s.Owner))) throw new SocialException(404, "That share was not found.");
                return Download(s);
            }
        }

        public object LinkDownload(string token)
        {
            lock (_gate)
            {
                string hash = HashToken(token);
                ShareRec? s = _shares.Items.Values.FirstOrDefault(x => x.TokenHash.Length > 0 && x.TokenHash == hash);
                if (s is null || s.Revoked || Expired(s)) throw new SocialException(404, "That link is no longer valid.");
                return Download(s);
            }
        }

        private object Download(ShareRec s)
        {
            DateTimeOffset expires = _o.Clock().Add(_o.DownloadLinkLifetime);
            SignedLink link = _signer.Sign(s.ObjectKey, expires);
            return new { url = link.Url, expires = link.Expires.ToUnixTimeMilliseconds(), name = s.Name, mapId = s.MapId, mode = s.Mode };
        }

        private bool Expired(ShareRec s) => s.Expires > 0 && s.Expires <= _o.Clock().ToUnixTimeMilliseconds();

        private object ShareView(ShareRec s, string? token, string viewer) => new
        {
            id = s.Id, mapId = s.MapId, name = s.Name, mode = s.Mode,
            owner = Display(s.Owner), sharedWith = s.Target.Length > 0 ? Display(s.Target) : null, link = s.TokenHash.Length > 0,
            token, created = s.Created, expires = s.Expires > 0 ? (long?)s.Expires : null, mine = s.Owner == viewer,
        };

        private static string HashToken(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    }
}

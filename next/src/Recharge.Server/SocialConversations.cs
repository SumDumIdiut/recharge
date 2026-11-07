using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;

namespace Recharge.Server
{
    /// <summary>
    /// Conversations: one model for direct messages ("dm:a|b", implicit, keyed by the two users) and group chats ("g:xxxxxxxxxxxx",
    /// explicit, with an owner and a member list), plus replies and read state. Part of <see cref="SocialService"/>; same lock.
    /// </summary>
    public sealed partial class SocialService
    {
        private const int ReplySnippetChars = 120;

        /// <summary>The conversation id of the DM between two users (names in any spelling).</summary>
        public static string DmId(string a, string b) => "dm:" + Pair(Norm(a), Norm(b));

        public static bool IsConversationId(string? s) => s is not null && (s.StartsWith("dm:", StringComparison.Ordinal) || s.StartsWith("g:", StringComparison.Ordinal));

        private IReadOnlyList<MessageRec> ListOf(string convId) =>
            _byConv.TryGetValue(convId, out List<MessageRec>? l) ? l : (IReadOnlyList<MessageRec>)Array.Empty<MessageRec>();

        /// <summary>One-time upgrade of pre-groups data: message conv ids, DM records and read keys.</summary>
        private void Migrate()
        {
            foreach (KeyValuePair<string, MessageRec> kv in _messages.Items.ToList())
            {
                MessageRec m = kv.Value;
                if (m.ConvId.Length == 0)
                {
                    m.ConvId = DmId(m.From, m.To);
                    _messages.Put(kv.Key, m);
                }
                if (m.ConvId.StartsWith("dm:", StringComparison.Ordinal) && !_convs.Items.ContainsKey(m.ConvId))
                    _convs.Put(m.ConvId, DmRec(m.ConvId, m.Ts));
            }
            foreach (string key in _reads.Items.Keys.ToList())
            {
                string[] p = key.Split('|');
                if (p.Length != 3 || p[1].StartsWith("dm:", StringComparison.Ordinal)) continue;
                string next = p[0] + "|dm:" + p[1] + "|" + p[2];
                ReadRec r = _reads.Items[key];
                _reads.Remove(key);
                if (!_reads.Items.ContainsKey(next)) _reads.Put(next, r);
            }
        }

        private static ConversationRec DmRec(string id, long created) =>
            new ConversationRec { Id = id, Kind = "dm", Members = id.Substring(3).Split('|'), Created = created };

        /// <summary>The conversation <paramref name="me"/> is in: a stored one, or (for a DM with nothing said yet) an implicit one. 404 otherwise.</summary>
        private ConversationRec ConvFor(string me, string id)
        {
            var notFound = new SocialException(404, "That conversation was not found.");
            if (id.StartsWith("g:", StringComparison.Ordinal))
            {
                if (!_convs.TryGet(id, out ConversationRec? g) || !g.Members.Contains(me)) throw notFound;
                return g;
            }
            if (id.StartsWith("dm:", StringComparison.Ordinal))
            {
                string[] p = id.Substring(3).Split('|');
                if (p.Length != 2 || !p.Contains(me) || p[0].Length == 0 || p[1].Length == 0) throw notFound;
                return _convs.TryGet(id, out ConversationRec? d) ? d : DmRec(id, 0);
            }
            throw notFound;
        }

        private static string OtherOf(ConversationRec c, string me) => c.Members.FirstOrDefault(k => k != me) ?? me;

        private long ReadUpTo(string user, string convId) => _reads.TryGet(user + "|" + convId, out ReadRec? r) ? r.UpTo : 0;

        private string MemberState(string viewer, string key) => key == viewer ? "online" : PresenceFor(viewer, key).State;

        private object ConversationView(ConversationRec c, string me)
        {
            IReadOnlyList<MessageRec> list = ListOf(c.Id);
            MessageRec? last = list.Count > 0 ? list[list.Count - 1] : null;
            long readUpTo = ReadUpTo(me, c.Id);
            int unread = list.Count(m => m.Id > readUpTo && m.From != me);
            bool dm = c.Kind == "dm";
            string other = dm ? OtherOf(c, me) : "";
            var members = c.Members.Select(k => (object)new { username = Display(k), state = MemberState(me, k), admin = c.Owner.Length > 0 && c.Owner == k }).ToList();
            string name = dm ? Display(other) : c.Name;
            return new
            {
                id = c.Id, kind = c.Kind, name, members,
                last = last is null ? null : Project(last), unread, friend = dm && AreFriends(me, other),
                // Kept for the pre-groups client, which reads these from a conversation row.
                username = name, state = dm ? MemberState(me, other) : "offline",
            };
        }

        private object Project(MessageRec m)
        {
            object? reply = null;
            if (m.ReplyTo > 0)
            {
                MessageRec? r = ListOf(m.ConvId).FirstOrDefault(x => x.Id == m.ReplyTo);
                if (r is not null)
                {
                    string t = r.Text.Length > ReplySnippetChars ? r.Text.Substring(0, ReplySnippetChars) : r.Text;
                    reply = new { id = r.Id, from = Display(r.From), text = t };
                }
            }
            return new { id = m.Id, convId = m.ConvId, from = Display(m.From), to = m.To.Length > 0 ? Display(m.To) : "", text = m.Text, card = m.Card, ts = m.Ts, cid = m.Cid, replyTo = reply };
        }

        // ---- reading ----

        public object Conversations(string meName)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                var rows = new List<(long Ts, int Unread, object Row)>();
                foreach (ConversationRec c in _convs.Items.Values)
                {
                    if (!c.Members.Contains(me)) continue;
                    IReadOnlyList<MessageRec> list = ListOf(c.Id);
                    if (c.Kind == "dm" && (list.Count == 0 || IsBlocked(me, OtherOf(c, me)))) continue;
                    long readUpTo = ReadUpTo(me, c.Id);
                    int unread = list.Count(m => m.Id > readUpTo && m.From != me);
                    long ts = list.Count > 0 ? list[list.Count - 1].Ts : c.Created;
                    rows.Add((ts, unread, ConversationView(c, me)));
                }
                var top = rows.OrderByDescending(r => r.Ts).Take(200).ToList();
                return new { conversations = top.Select(r => r.Row).ToList(), unread = top.Sum(r => r.Unread) };
            }
        }

        public object Messages(string meName, string convId, long before, int limit)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                ConversationRec c = ConvFor(me, convId);
                if (c.Kind == "dm" && IsBlocked(me, OtherOf(c, me))) throw new SocialException(404, "That conversation was not found.");
                limit = Math.Clamp(limit, 1, 100);
                IReadOnlyList<MessageRec> all = ListOf(convId);
                IEnumerable<MessageRec> older = before > 0 ? all.Where(m => m.Id < before) : all;
                List<MessageRec> page = older.Reverse().Take(limit + 1).ToList();
                bool more = page.Count > limit;
                if (more) page.RemoveAt(page.Count - 1);
                page.Reverse();
                long readUpTo = ReadUpTo(me, convId);
                long seenUpTo = c.Kind == "dm" ? ReadUpTo(OtherOf(c, me), convId) : 0;
                return new { messages = page.Select(Project).ToList(), hasMore = more, readUpTo, seenUpTo, conversation = ConversationView(c, me) };
            }
        }

        public object Send(string meName, string convId, string? text, CardRec? card, string? clientId = null, long replyTo = 0)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                string cid = CleanCid(clientId);
                ConversationRec c = ConvFor(me, convId);
                // A retry of a message that did arrive: hand back the stored one, no second copy, no rate-limit hit.
                if (cid.Length > 0 && _byCid.TryGetValue(me + "|" + cid, out MessageRec? dup) && dup.ConvId == convId) return Project(dup);
                string to = "";
                if (c.Kind == "dm")
                {
                    string o = OtherOf(c, me);
                    if (me == o) throw new SocialException(400, "You can't message yourself.");
                    if (IsBlocked(me, o)) throw new SocialException(403, "You can't message this user.");
                    if (!AreFriends(me, o) && !SettingsOf(o).AllowStrangers)
                        throw new SocialException(403, "Only friends can message each other.");
                    to = o;
                }
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
                long reply = replyTo > 0 && ListOf(convId).Any(x => x.Id == replyTo) ? replyTo : 0;
                var m = new MessageRec { Id = ++_lastMessageId, From = me, To = to, Text = body, Card = card, Ts = Now(), Cid = cid, ConvId = convId, ReplyTo = reply };
                if (c.Kind == "dm" && !_convs.Items.ContainsKey(convId)) { c.Created = m.Ts; _convs.Put(convId, c); }
                if (cid.Length > 0) _byCid[me + "|" + cid] = m;
                _messages.Put(m.Id.ToString(CultureInfo.InvariantCulture), m);
                ConvList(convId).Add(m);
                object view = Project(m);
                foreach (string member in c.Members.Distinct())
                    Notify(member, new { type = "message", message = view, conversation = ConversationView(c, member) });
                return view;
            }
        }

        public object MarkRead(string meName, string convId, long upTo)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                ConversationRec c = ConvFor(me, convId);
                string key = me + "|" + convId;
                long cur = ReadUpTo(me, convId);
                if (upTo > cur) _reads.Put(key, new ReadRec { UpTo = Math.Min(upTo, _lastMessageId) });
                long now = Math.Max(cur, Math.Min(upTo, _lastMessageId));
                if (c.Kind == "dm")
                {
                    string o = OtherOf(c, me);
                    Notify(me, new { type = "read", convId, username = Display(o) });
                    if (now > cur && !IsBlocked(me, o)) Notify(o, new { type = "seen", convId, username = Display(me), upTo = now });
                }
                else Notify(me, new { type = "read", convId });
                return new { readUpTo = now };
            }
        }

        // ---- groups ----

        private void PushConversation(ConversationRec c)
        {
            foreach (string member in c.Members) Notify(member, new { type = "conversation", conversation = ConversationView(c, member) });
        }

        private static string CleanGroupName(string? name)
        {
            string n = CleanText(name).Replace('\n', ' ').Replace('\t', ' ').Trim();
            if (n.Length > 60) throw new SocialException(400, "The group name is too long (60 characters at most).");
            return n;
        }

        /// <summary>Checks that <paramref name="by"/> may put <paramref name="who"/> in a group.</summary>
        private void CheckInvitable(string by, string who)
        {
            if (IsBlocked(by, who)) throw new SocialException(403, "You can't add " + Display(who) + ".");
            if (!AreFriends(by, who) && !SettingsOf(who).AllowStrangers)
                throw new SocialException(403, "You can only add your friends (" + Display(who) + " isn't one).");
        }

        public object CreateGroup(string meName, string? name, IEnumerable<string> others)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                var members = new List<string> { me };
                foreach (string o in others.Select(Norm))
                    if (!members.Contains(o)) members.Add(o);
                if (members.Count < 2) throw new SocialException(400, "A group needs at least one other member.");
                if (members.Count > _o.MaxGroupMembers) throw new SocialException(400, "A group can have " + _o.MaxGroupMembers + " members at most.");
                foreach (string k in members.Skip(1)) CheckInvitable(me, k);
                string title = CleanGroupName(name);
                if (title.Length == 0)
                {
                    title = string.Join(", ", members.Select(Display));
                    if (title.Length > 60) title = title.Substring(0, 57).TrimEnd() + "...";
                }
                string id = "g:" + Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant();
                var c = new ConversationRec { Id = id, Kind = "group", Name = title, Members = members.ToArray(), Owner = me, Created = Now() };
                _convs.Put(id, c);
                PushConversation(c);
                return ConversationView(c, me);
            }
        }

        private ConversationRec GroupFor(string me, string convId)
        {
            ConversationRec c = ConvFor(me, convId);
            if (c.Kind != "group") throw new SocialException(400, "That isn't a group.");
            return c;
        }

        public object AddMember(string meName, string convId, string userName)
        {
            lock (_gate)
            {
                string me = Norm(meName), who = Norm(userName);
                ConversationRec c = GroupFor(me, convId);
                if (c.Owner != me) throw new SocialException(403, "Only the group's owner can add people.");
                if (c.Members.Contains(who)) throw new SocialException(409, Display(who) + " is already in this group.");
                if (c.Members.Length >= _o.MaxGroupMembers) throw new SocialException(400, "A group can have " + _o.MaxGroupMembers + " members at most.");
                CheckInvitable(me, who);
                c.Members = c.Members.Append(who).ToArray();
                _convs.Put(c.Id, c);
                PushConversation(c);
                return ConversationView(c, me);
            }
        }

        public object RemoveMember(string meName, string convId, string userName)
        {
            lock (_gate)
            {
                string me = Norm(meName), who = Norm(userName);
                ConversationRec c = GroupFor(me, convId);
                if (who != me && c.Owner != me) throw new SocialException(403, "Only the group's owner can remove people.");
                if (!c.Members.Contains(who)) throw new SocialException(404, "That user is not in this group.");
                string[] rest = c.Members.Where(k => k != who).ToArray();
                _reads.Remove(who + "|" + c.Id);
                Notify(who, new { type = "conversation-left", convId = c.Id });
                if (rest.Length == 0)
                {
                    foreach (MessageRec m in ListOf(c.Id).ToList()) { _messages.Remove(m.Id.ToString(CultureInfo.InvariantCulture)); if (m.Cid.Length > 0) _byCid.Remove(m.From + "|" + m.Cid); }
                    _byConv.Remove(c.Id);
                    _convs.Remove(c.Id);
                    return new { status = who == me ? "left" : "removed" };
                }
                c.Members = rest;
                if (c.Owner == who) c.Owner = rest[0];
                _convs.Put(c.Id, c);
                PushConversation(c);
                return new { status = who == me ? "left" : "removed" };
            }
        }

        public object RenameGroup(string meName, string convId, string? name)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                ConversationRec c = GroupFor(me, convId);
                if (c.Owner != me) throw new SocialException(403, "Only the group's owner can rename it.");
                string title = CleanGroupName(name);
                if (title.Length == 0) throw new SocialException(400, "A group needs a name.");
                c.Name = title;
                _convs.Put(c.Id, c);
                PushConversation(c);
                return ConversationView(c, me);
            }
        }
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Recharge.Server
{
    /// <summary>
    /// Conversations: direct messages ("dm:a|b"), group chats ("g:xxxxxxxxxxxx") and server channels ("ch:xxxxxxxxxxxx",
    /// membership from the owning server), plus replies and read state. Part of <see cref="SocialService"/>; same lock.
    /// </summary>
    public sealed partial class SocialService
    {
        private const int ReplySnippetChars = 120;
        private const int ImageBytes = 5 * 1024 * 1024;
        private const int VideoBytes = 32 * 1024 * 1024;
        private static readonly Regex MediaNameRe = new Regex(@"^[0-9a-f]{32}\.(png|jpg|jpeg|gif|webp|mp4|webm)$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex AvatarNameRe = new Regex(@"^[0-9a-f]{32}\.(png|jpg|jpeg|gif|webp)$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex GroupColorRe = new Regex(@"^#[0-9a-fA-F]{6}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        /// <summary>The conversation id of the DM between two users (names in any spelling).</summary>
        public static string DmId(string a, string b) => "dm:" + Pair(Norm(a), Norm(b));

        public static bool IsConversationId(string? s) => s is not null &&
            (s.StartsWith("dm:", StringComparison.Ordinal) || s.StartsWith("g:", StringComparison.Ordinal) || s.StartsWith("ch:", StringComparison.Ordinal));

        // ---- message media (base64 in JSON on upload, names on the send) ----

        public string MediaDir => _mediaDir;
        public static string MediaUrl(string name) => "/api/conversations/media/" + name;
        public static bool IsMediaName(string? name) => name is not null && MediaNameRe.IsMatch(name);
        public static bool IsAvatarName(string? name) => name is not null && AvatarNameRe.IsMatch(name);
        public string? MediaPath(string name) => IsMediaName(name) ? Path.Combine(_mediaDir, name) : null;

        public static string MediaMime(string name) =>
            name.EndsWith(".png", StringComparison.Ordinal) ? "image/png" :
            name.EndsWith(".jpg", StringComparison.Ordinal) || name.EndsWith(".jpeg", StringComparison.Ordinal) ? "image/jpeg" :
            name.EndsWith(".gif", StringComparison.Ordinal) ? "image/gif" :
            name.EndsWith(".webp", StringComparison.Ordinal) ? "image/webp" :
            name.EndsWith(".mp4", StringComparison.Ordinal) ? "video/mp4" : "video/webm";

        /// <summary>Real type from magic bytes; the supplied name/mime are never trusted.</summary>
        private static string? SniffExt(byte[] b)
        {
            bool At(int at, string s) { if (b.Length < at + s.Length) return false; for (int i = 0; i < s.Length; i++) if (b[at + i] != s[i]) return false; return true; }
            if (b.Length >= 8 && b[0] == 0x89 && b[1] == (byte)'P' && b[2] == (byte)'N' && b[3] == (byte)'G') return "png";
            if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "jpg";
            if (At(0, "GIF8")) return "gif";
            if (At(0, "RIFF") && At(8, "WEBP")) return "webp";
            if (At(4, "ftyp")) return "mp4";
            if (b.Length >= 4 && b[0] == 0x1A && b[1] == 0x45 && b[2] == 0xDF && b[3] == 0xA3) return "webm";
            return null;
        }

        /// <summary>Keep at most 4 existing names, including at most one video; unknown names are dropped.</summary>
        private List<string> MediaFor(string[]? media)
        {
            var keep = new List<string>();
            if (media is null) return keep;
            bool video = false;
            foreach (string name in media)
            {
                if (!IsMediaName(name) || keep.Contains(name) || !File.Exists(Path.Combine(_mediaDir, name))) continue;
                bool isVideo = name.EndsWith(".mp4", StringComparison.Ordinal) || name.EndsWith(".webm", StringComparison.Ordinal);
                if (isVideo && video) continue;
                if (keep.Count >= 4) break;
                keep.Add(name);
                if (isVideo) video = true;
            }
            return keep;
        }

        /// <summary>Store one base64-in-JSON upload on the social server and return its public name/url.</summary>
        public object UploadMedia(string meName, string convId, string? name, string? mime, string? dataBase64)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                ConvFor(me, convId);   // members only
                _mediaLimit.Hit(me, "You are uploading media too fast.");
                if (string.IsNullOrEmpty(dataBase64) || dataBase64.Length > 48 * 1024 * 1024)
                    throw new SocialException(413, "That file is too large.");
                byte[] bytes;
                try { bytes = Convert.FromBase64String(dataBase64); }
                catch (FormatException) { throw new SocialException(400, "That file wasn't valid base64."); }
                // name/mime are hints only: the bytes decide the extension.
                string? ext = SniffExt(bytes);
                if (ext is null) throw new SocialException(415, "Only PNG, JPEG, GIF, WebP, MP4 and WebM files are accepted.");
                bool video = ext == "mp4" || ext == "webm";
                if (bytes.Length > (video ? VideoBytes : ImageBytes))
                    throw new SocialException(413, video ? "Videos must be 32 MB or less." : "Images must be 5 MB or less.");
                string file = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant() + "." + ext;
                File.WriteAllBytes(Path.Combine(_mediaDir, file), bytes);
                return new { name = file, url = MediaUrl(file) };
            }
        }

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

        /// <summary>The conversation <paramref name="me"/> is in: a stored one, an implicit DM, or a channel of a server they belong to. 404 otherwise.</summary>
        private ConversationRec ConvFor(string me, string id)
        {
            var notFound = new SocialException(404, "That conversation was not found.");
            if (id.StartsWith("ch:", StringComparison.Ordinal))
            {
                // A channel id IS a conversation id; membership comes from the owning server, not a stored ConversationRec.
                if (!_channels.TryGet(id, out ChannelRec? ch) || !_servers.TryGet(ch.ServerId, out ServerRec? s) || !s.Members.Contains(me)) throw notFound;
                return new ConversationRec { Id = id, Kind = "channel", Name = ch.Name, Members = s.Members, Owner = s.OwnerId, Created = ch.Created };
            }
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
            string color = dm ? "" : c.Color;
            string avatar = !dm && IsAvatarName(c.Avatar) && File.Exists(Path.Combine(_mediaDir, c.Avatar)) ? MediaUrl(c.Avatar) : "";
            return new
            {
                id = c.Id, kind = c.Kind, name, color, avatar, members,
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
            return new { id = m.Id, convId = m.ConvId, from = Display(m.From), to = m.To.Length > 0 ? Display(m.To) : "", text = m.Text, card = m.Card, ts = m.Ts, cid = m.Cid, replyTo = reply, reactions = m.Reactions, editedAt = m.EditedAt, deletedAt = m.DeletedAt, media = (m.Media ?? new List<string>()).Select(MediaUrl).ToArray() };
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

        public object Send(string meName, string convId, string? text, CardRec? card, string? clientId = null, long replyTo = 0, string[]? media = null)
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
                List<string> files = MediaFor(media);
                string body = CleanText(text);
                if (body.Length == 0 && card is null && files.Count == 0) throw new SocialException(400, "A message can't be empty.");
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
                var m = new MessageRec { Id = ++_lastMessageId, From = me, To = to, Text = body, Card = card, Ts = Now(), Cid = cid, ConvId = convId, ReplyTo = reply, Media = files };
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

        /// <summary>Toggle the caller's emoji reaction on a message and push the new map to every member.</summary>
        public object React(string meName, string convId, long messageId, string? emoji)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                string key = CleanText(emoji);
                if (key.Length == 0 || key.Length > 16) throw new SocialException(400, "That reaction is not valid.");
                ConversationRec c = ConvFor(me, convId);
                MessageRec? m = ListOf(convId).FirstOrDefault(x => x.Id == messageId);
                if (m is null) throw new SocialException(404, "That message was not found.");
                m.Reactions ??= new Dictionary<string, List<string>>();
                if (!m.Reactions.TryGetValue(key, out List<string>? users) || users is null)
                {
                    users = new List<string>();
                    m.Reactions[key] = users;
                }
                if (users.Contains(me))
                {
                    users.Remove(me);
                    if (users.Count == 0) m.Reactions.Remove(key);
                }
                else users.Add(me);
                _messages.Put(m.Id.ToString(CultureInfo.InvariantCulture), m);
                var reactions = m.Reactions.ToDictionary(kv => kv.Key, kv => kv.Value.ToArray());
                foreach (string member in c.Members.Distinct())
                    Notify(member, new { type = "reaction", convId, messageId = m.Id, emoji = key, reactions });
                return new { convId, messageId = m.Id, emoji = key, reactions };
            }
        }

        /// <summary>Edit the caller's own message text and push the change to every member.</summary>
        public object Edit(string meName, string convId, long messageId, string? text)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                ConversationRec c = ConvFor(me, convId);
                MessageRec? m = ListOf(convId).FirstOrDefault(x => x.Id == messageId);
                if (m is null) throw new SocialException(404, "That message was not found.");
                if (Norm(m.From) != me) throw new SocialException(403, "You can only edit your own messages.");
                string body = CleanText(text);
                if (body.Length == 0) throw new SocialException(400, "A message can't be empty.");
                if (body.Length > _o.MaxMessageChars) throw new SocialException(400, "That message is too long (" + _o.MaxMessageChars + " characters at most).");
                _messageLimit.Hit(me, "You are sending messages too fast.");
                m.Text = body;
                m.EditedAt = Now();
                _messages.Put(m.Id.ToString(CultureInfo.InvariantCulture), m);
                var payload = new { type = "edit", convId, messageId = m.Id, text = m.Text, editedAt = m.EditedAt };
                foreach (string member in c.Members.Distinct())
                    Notify(member, payload);
                return payload;
            }
        }

        /// <summary>Soft-delete the caller's own message, keeping the row as a tombstone so replies and ordering still work.</summary>
        public object Delete(string meName, string convId, long messageId)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                ConversationRec c = ConvFor(me, convId);
                MessageRec? m = ListOf(convId).FirstOrDefault(x => x.Id == messageId);
                if (m is null) throw new SocialException(404, "That message was not found.");
                if (Norm(m.From) != me) throw new SocialException(403, "You can only delete your own messages.");
                m.DeletedAt = Now();
                m.Text = "";
                m.Card = null;
                m.Media = new();
                m.Reactions = new Dictionary<string, List<string>>();
                _messages.Put(m.Id.ToString(CultureInfo.InvariantCulture), m);
                var payload = new { type = "delete", convId, messageId = m.Id, deletedAt = m.DeletedAt };
                foreach (string member in c.Members.Distinct())
                    Notify(member, payload);
                return payload;
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

        /// <summary>Any member can edit the group's look; only supplied, valid fields change.</summary>
        public object SetGroupProfile(string meName, string convId, string? name, string? color, string? avatar)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                ConversationRec c = GroupFor(me, convId);   // group + member checks
                if (name is not null)
                {
                    string title = CleanGroupName(name);
                    if (title.Length == 0) throw new SocialException(400, "A group needs a name.");
                    c.Name = title;
                }
                if (color is not null && GroupColorRe.IsMatch(color)) c.Color = color;
                if (avatar is not null && IsAvatarName(avatar) && File.Exists(Path.Combine(_mediaDir, avatar))) c.Avatar = avatar;
                _convs.Put(c.Id, c);
                PushConversation(c);
                return ConversationView(c, me);
            }
        }
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;

namespace Recharge.Server
{
    /// <summary>Servers and their channels. Text channel ids resolve as conversations; voice channels are call rooms.</summary>
    public sealed partial class SocialService
    {
        private const int ChannelTopicChars = 280;

        private ServerRec ServerFor(string me, string id)
        {
            if (!_servers.TryGet(id, out ServerRec? s) || !s.Members.Contains(me))
                throw new SocialException(404, "That server was not found.");
            return s;
        }

        private ServerRec OwnedServerFor(string me, string id)
        {
            ServerRec s = ServerFor(me, id);
            if (s.OwnerId != me) throw new SocialException(403, "Only the server's owner can do that.");
            return s;
        }

        private IEnumerable<ChannelRec> ChannelsOf(string serverId) =>
            _channels.Items.Values.Where(c => c.ServerId == serverId).OrderBy(c => c.Position).ThenBy(c => c.Created);

        private ChannelRec ChannelFor(ServerRec s, string channelId)
        {
            if (!_channels.TryGet(channelId, out ChannelRec? c) || c.ServerId != s.Id)
                throw new SocialException(404, "That channel was not found.");
            return c;
        }

        /// <summary>A channel whose server the user belongs to; shared by text conversations and voice signaling.</summary>
        internal ChannelRec ChannelForMember(string meName, string channelId)
        {
            string me = Norm(meName);
            if (!channelId.StartsWith("ch:", StringComparison.Ordinal) ||
                !_channels.TryGet(channelId, out ChannelRec? c) ||
                !_servers.TryGet(c.ServerId, out ServerRec? s) || !s.Members.Contains(me))
                throw new SocialException(404, "That channel was not found.");
            return c;
        }

        private object ChannelView(ChannelRec c) => new
        {
            id = c.Id, serverId = c.ServerId, name = c.Name, kind = c.Kind, topic = c.Topic,
            position = c.Position, categoryId = c.CategoryId, created = c.Created, type = c.Kind,
        };

        // ---- roles / categories helpers ----
        private IEnumerable<CategoryRec> CategoriesOf(string serverId) =>
            _categories.Items.Values.Where(c => c.ServerId == serverId).OrderBy(c => c.Position).ThenBy(c => c.Created);

        private IEnumerable<RoleRec> RolesOf(string serverId) =>
            _roles.Items.Values.Where(r => r.ServerId == serverId).OrderByDescending(r => r.Position).ThenBy(r => r.Created);

        private string[] MemberRoleIds(string serverId, string user) =>
            _memberRoles.TryGet(serverId + "|" + user, out MemberRoleRec? mr)
                ? mr.RoleIds.Where(id => _roles.TryGet(id, out RoleRec? r) && r.ServerId == serverId).ToArray()
                : Array.Empty<string>();

        /// <summary>The owner, or a member wearing a role marked Admin.</summary>
        private bool IsAdmin(ServerRec s, string user)
        {
            if (s.OwnerId == user) return true;
            foreach (string rid in MemberRoleIds(s.Id, user))
                if (_roles.TryGet(rid, out RoleRec? r) && r.Admin) return true;
            return false;
        }

        /// <summary>A server the user may manage (owner or an admin role). 403 otherwise.</summary>
        private ServerRec ManagedServerFor(string me, string id)
        {
            ServerRec s = ServerFor(me, id);
            if (!IsAdmin(s, me)) throw new SocialException(403, "Only the server's owner or an admin can do that.");
            return s;
        }

        private object RoleView(RoleRec r) => new { id = r.Id, name = r.Name, color = r.Color, admin = r.Admin, position = r.Position };

        private object ServerView(ServerRec s, string me) => new
        {
            id = s.Id, name = s.Name,
            icon = IsAvatarName(s.Icon) && File.Exists(Path.Combine(_mediaDir, s.Icon)) ? MediaUrl(s.Icon) : "",
            owner = Display(s.OwnerId), ownerId = s.OwnerId, created = s.Created,
            manage = IsAdmin(s, me),
            members = s.Members.Select(k => (object)new { username = Display(k), state = MemberState(me, k), admin = IsAdmin(s, k), roles = MemberRoleIds(s.Id, k) }).ToList(),
            categories = CategoriesOf(s.Id).Select(c => (object)new { id = c.Id, name = c.Name, position = c.Position }).ToList(),
            roles = RolesOf(s.Id).Select(RoleView).ToList(),
            channels = ChannelsOf(s.Id).Select(ChannelView).ToList(),
        };

        private void PushServer(ServerRec s)
        {
            foreach (string member in s.Members.Distinct())
                Notify(member, new { type = "server", server = ServerView(s, member) });
        }

        private ChannelRec AddChannelLocked(ServerRec s, string name, string topic, int position, string kind)
        {
            var c = new ChannelRec
            {
                Id = "ch:" + Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant(),
                ServerId = s.Id, Name = name, Kind = kind, Topic = topic, Position = position, Created = Now(),
            };
            _channels.Put(c.Id, c);
            return c;
        }

        public object Servers(string meName)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                var servers = _servers.Items.Values.Where(s => s.Members.Contains(me))
                    .OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase).Select(s => ServerView(s, me)).ToList();
                return new { servers };
            }
        }

        public object CreateServer(string meName, string? name)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                string title = CleanGroupName(name);
                if (title.Length == 0) throw new SocialException(400, "A server needs a name.");
                var s = new ServerRec
                {
                    Id = "sv:" + Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant(),
                    Name = title, OwnerId = me, Members = new[] { me }, Created = Now(),
                };
                _servers.Put(s.Id, s);
                AddChannelLocked(s, "general", "", 0, "text");
                PushServer(s);
                return ServerView(s, me);
            }
        }

        /// <summary>Owner-only edits; an empty icon clears it. A null field is left alone.</summary>
        public object UpdateServer(string meName, string id, string? name, string? icon)
        {
            lock (_gate)
            {
                ServerRec s = ManagedServerFor(Norm(meName), id);
                if (name is not null)
                {
                    string title = CleanGroupName(name);
                    if (title.Length == 0) throw new SocialException(400, "A server needs a name.");
                    s.Name = title;
                }
                if (icon is not null)
                {
                    string file = icon.Trim();
                    if (file.Length > 0 && (!IsAvatarName(file) || !File.Exists(Path.Combine(_mediaDir, file))))
                        throw new SocialException(400, "That icon isn't a stored image.");
                    s.Icon = file;
                }
                _servers.Put(s.Id, s);
                PushServer(s);
                return ServerView(s, s.OwnerId);
            }
        }

        public object CreateChannel(string meName, string id, string? name, string? kind, string? categoryId = null)
        {
            lock (_gate)
            {
                ServerRec s = ManagedServerFor(Norm(meName), id);
                string title = CleanGroupName(name);
                if (title.Length == 0) throw new SocialException(400, "A channel needs a name.");
                string channelKind = (kind ?? "text").Trim().ToLowerInvariant();
                if (channelKind != "text" && channelKind != "voice") throw new SocialException(400, "A channel is either text or voice.");
                string cat = CategoryIn(s, categoryId);
                int next = ChannelsOf(s.Id).Select(c => c.Position).DefaultIfEmpty(-1).Max() + 1;
                ChannelRec c = AddChannelLocked(s, title, "", next, channelKind);
                c.CategoryId = cat;
                _channels.Put(c.Id, c);
                PushServer(s);
                return ChannelView(c);
            }
        }

        /// <summary>Validate a category id against the server; "" or null → uncategorised.</summary>
        private string CategoryIn(ServerRec s, string? categoryId)
        {
            string cat = (categoryId ?? "").Trim();
            if (cat.Length == 0) return "";
            if (!_categories.TryGet(cat, out CategoryRec? c) || c.ServerId != s.Id)
                throw new SocialException(404, "That category was not found.");
            return cat;
        }

        public object UpdateChannel(string meName, string id, string channelId, string? name, string? topic, int? position, string? categoryId = null)
        {
            lock (_gate)
            {
                ServerRec s = ManagedServerFor(Norm(meName), id);
                ChannelRec c = ChannelFor(s, channelId);
                if (name is not null)
                {
                    string title = CleanGroupName(name);
                    if (title.Length == 0) throw new SocialException(400, "A channel needs a name.");
                    c.Name = title;
                }
                if (topic is not null)
                {
                    string t = CleanText(topic);
                    if (t.Length > ChannelTopicChars) throw new SocialException(400, "The topic is too long (280 characters at most).");
                    c.Topic = t;
                }
                if (position is not null) c.Position = (int)Math.Clamp(position.Value, -1000, 1000);
                if (categoryId is not null) c.CategoryId = CategoryIn(s, categoryId);
                _channels.Put(c.Id, c);
                PushServer(s);
                return ChannelView(c);
            }
        }

        public object DeleteChannel(string meName, string id, string channelId)
        {
            lock (_gate)
            {
                ServerRec s = ManagedServerFor(Norm(meName), id);
                ChannelRec c = ChannelFor(s, channelId);
                if (ChannelsOf(s.Id).Count() <= 1) throw new SocialException(400, "A server needs at least one channel.");
                _channels.Remove(c.Id);
                PushServer(s);
                return new { status = "deleted", id = c.Id };
            }
        }

        /// <summary>The route resolves the username through the hub before calling this.</summary>
        public object AddServerMember(string meName, string id, string userName)
        {
            lock (_gate)
            {
                string me = Norm(meName), who = Norm(userName);
                ServerRec s = ManagedServerFor(me, id);
                if (s.Members.Contains(who)) throw new SocialException(409, Display(who) + " is already in this server.");
                s.Members = s.Members.Append(who).ToArray();
                _servers.Put(s.Id, s);
                GrantServerEmojis(who, s.Id);   // joining unlocks the server's emoji into your arsenal, forever
                PushServer(s);
                return ServerView(s, me);
            }
        }

        /// <summary>The owner removes someone; any member may leave. A departing owner hands the server on.</summary>
        public object RemoveServerMember(string meName, string id, string userName)
        {
            lock (_gate)
            {
                string me = Norm(meName), who = Norm(userName);
                ServerRec s = ServerFor(me, id);
                if (who != me && s.OwnerId != me) throw new SocialException(403, "Only the server's owner can remove people.");
                if (!s.Members.Contains(who)) throw new SocialException(404, "That user is not in this server.");
                string[] rest = s.Members.Where(k => k != who).ToArray();
                Notify(who, new { type = "server-left", id = s.Id });
                _memberRoles.Remove(s.Id + "|" + who);   // their role wear-list in this server; arsenal is theirs to keep
                if (rest.Length == 0)
                {
                    _servers.Remove(s.Id);
                    foreach (ChannelRec c in ChannelsOf(s.Id).ToList()) _channels.Remove(c.Id);
                    foreach (CategoryRec c in CategoriesOf(s.Id).ToList()) _categories.Remove(c.Id);
                    foreach (RoleRec r in RolesOf(s.Id).ToList()) _roles.Remove(r.Id);
                    foreach (ServerEmojiRec e in _serverEmojis.Items.Values.Where(e => e.ServerId == s.Id).ToList()) _serverEmojis.Remove(e.ServerId + "|" + e.Shortcode);
                    return new { status = who == me ? "left" : "removed" };
                }
                s.Members = rest;
                if (s.OwnerId == who) s.OwnerId = rest[0];
                _servers.Put(s.Id, s);
                PushServer(s);
                return new { status = who == me ? "left" : "removed" };
            }
        }
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;

namespace Recharge.Server
{
    /// <summary>Servers and their text channels. Channel ids resolve as conversations in <see cref="SocialService"/>.</summary>
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

        private object ChannelView(ChannelRec c) => new
        {
            id = c.Id, serverId = c.ServerId, name = c.Name, topic = c.Topic,
            position = c.Position, created = c.Created, type = "text",
        };

        private object ServerView(ServerRec s, string me) => new
        {
            id = s.Id, name = s.Name,
            icon = IsAvatarName(s.Icon) && File.Exists(Path.Combine(_mediaDir, s.Icon)) ? MediaUrl(s.Icon) : "",
            owner = Display(s.OwnerId), ownerId = s.OwnerId, created = s.Created,
            members = s.Members.Select(k => (object)new { username = Display(k), state = MemberState(me, k), admin = k == s.OwnerId }).ToList(),
            channels = ChannelsOf(s.Id).Select(ChannelView).ToList(),
        };

        private void PushServer(ServerRec s)
        {
            foreach (string member in s.Members.Distinct())
                Notify(member, new { type = "server", server = ServerView(s, member) });
        }

        private ChannelRec AddChannelLocked(ServerRec s, string name, string topic, int position)
        {
            var c = new ChannelRec
            {
                Id = "ch:" + Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant(),
                ServerId = s.Id, Name = name, Topic = topic, Position = position, Created = Now(),
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
                AddChannelLocked(s, "general", "", 0);
                PushServer(s);
                return ServerView(s, me);
            }
        }

        /// <summary>Owner-only edits; an empty icon clears it. A null field is left alone.</summary>
        public object UpdateServer(string meName, string id, string? name, string? icon)
        {
            lock (_gate)
            {
                ServerRec s = OwnedServerFor(Norm(meName), id);
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

        public object CreateChannel(string meName, string id, string? name)
        {
            lock (_gate)
            {
                ServerRec s = OwnedServerFor(Norm(meName), id);
                string title = CleanGroupName(name);
                if (title.Length == 0) throw new SocialException(400, "A channel needs a name.");
                int next = ChannelsOf(s.Id).Select(c => c.Position).DefaultIfEmpty(-1).Max() + 1;
                ChannelRec c = AddChannelLocked(s, title, "", next);
                PushServer(s);
                return ChannelView(c);
            }
        }

        public object UpdateChannel(string meName, string id, string channelId, string? name, string? topic, int? position)
        {
            lock (_gate)
            {
                ServerRec s = OwnedServerFor(Norm(meName), id);
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
                _channels.Put(c.Id, c);
                PushServer(s);
                return ChannelView(c);
            }
        }

        public object DeleteChannel(string meName, string id, string channelId)
        {
            lock (_gate)
            {
                ServerRec s = OwnedServerFor(Norm(meName), id);
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
                ServerRec s = OwnedServerFor(me, id);
                if (s.Members.Contains(who)) throw new SocialException(409, Display(who) + " is already in this server.");
                s.Members = s.Members.Append(who).ToArray();
                _servers.Put(s.Id, s);
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
                if (rest.Length == 0)
                {
                    _servers.Remove(s.Id);
                    foreach (ChannelRec c in ChannelsOf(s.Id).ToList()) _channels.Remove(c.Id);
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

using System;
using System.Linq;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Recharge.Server
{
    /// <summary>Categories (named channel groups) and cosmetic roles (coloured name labels; Admin grants management).</summary>
    public sealed partial class SocialService
    {
        private static readonly Regex ColorRe = new Regex(@"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private const int RoleNameChars = 40;

        private static string NewId(string prefix) => prefix + Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant();

        private static string CleanColor(string? color)
        {
            string c = (color ?? "").Trim();
            if (c.Length == 0) return "";
            if (!ColorRe.IsMatch(c)) throw new SocialException(400, "A role colour must be a hex value like #88ccff.");
            return c.ToLowerInvariant();
        }

        private string ShortName(string? name, string what)
        {
            string t = CleanText(name ?? "");
            if (t.Length == 0) throw new SocialException(400, "A " + what + " needs a name.");
            if (t.Length > RoleNameChars) throw new SocialException(400, "That " + what + " name is too long (40 characters at most).");
            return t;
        }

        // ---- categories ----
        public object CreateCategory(string meName, string id, string? name)
        {
            lock (_gate)
            {
                ServerRec s = ManagedServerFor(Norm(meName), id);
                string title = ShortName(name, "category");
                int next = CategoriesOf(s.Id).Select(c => c.Position).DefaultIfEmpty(-1).Max() + 1;
                var c = new CategoryRec { Id = NewId("cat:"), ServerId = s.Id, Name = title, Position = next, Created = Now() };
                _categories.Put(c.Id, c);
                PushServer(s);
                return new { id = c.Id, name = c.Name, position = c.Position };
            }
        }

        public object UpdateCategory(string meName, string id, string catId, string? name, int? position)
        {
            lock (_gate)
            {
                ServerRec s = ManagedServerFor(Norm(meName), id);
                if (!_categories.TryGet(catId, out CategoryRec? c) || c.ServerId != s.Id) throw new SocialException(404, "That category was not found.");
                if (name is not null) c.Name = ShortName(name, "category");
                if (position is not null) c.Position = (int)Math.Clamp(position.Value, -1000, 1000);
                _categories.Put(c.Id, c);
                PushServer(s);
                return new { id = c.Id, name = c.Name, position = c.Position };
            }
        }

        public object DeleteCategory(string meName, string id, string catId)
        {
            lock (_gate)
            {
                ServerRec s = ManagedServerFor(Norm(meName), id);
                if (!_categories.TryGet(catId, out CategoryRec? c) || c.ServerId != s.Id) throw new SocialException(404, "That category was not found.");
                foreach (ChannelRec ch in ChannelsOf(s.Id).Where(ch => ch.CategoryId == catId).ToList())
                {
                    ch.CategoryId = "";
                    _channels.Put(ch.Id, ch);
                }
                _categories.Remove(catId);
                PushServer(s);
                return new { status = "deleted", id = catId };
            }
        }

        // ---- roles ----
        public object CreateRole(string meName, string id, string? name, string? color, bool admin)
        {
            lock (_gate)
            {
                ServerRec s = ManagedServerFor(Norm(meName), id);
                string title = ShortName(name, "role");
                int next = RolesOf(s.Id).Select(r => r.Position).DefaultIfEmpty(-1).Max() + 1;
                var r = new RoleRec { Id = NewId("role:"), ServerId = s.Id, Name = title, Color = CleanColor(color), Admin = admin, Position = next, Created = Now() };
                _roles.Put(r.Id, r);
                PushServer(s);
                return RoleView(r);
            }
        }

        public object UpdateRole(string meName, string id, string roleId, string? name, string? color, bool? admin, int? position)
        {
            lock (_gate)
            {
                ServerRec s = ManagedServerFor(Norm(meName), id);
                if (!_roles.TryGet(roleId, out RoleRec? r) || r.ServerId != s.Id) throw new SocialException(404, "That role was not found.");
                if (name is not null) r.Name = ShortName(name, "role");
                if (color is not null) r.Color = CleanColor(color);
                if (admin is not null) r.Admin = admin.Value;
                if (position is not null) r.Position = (int)Math.Clamp(position.Value, -1000, 1000);
                _roles.Put(r.Id, r);
                PushServer(s);
                return RoleView(r);
            }
        }

        public object DeleteRole(string meName, string id, string roleId)
        {
            lock (_gate)
            {
                ServerRec s = ManagedServerFor(Norm(meName), id);
                if (!_roles.TryGet(roleId, out RoleRec? r) || r.ServerId != s.Id) throw new SocialException(404, "That role was not found.");
                _roles.Remove(roleId);
                foreach (MemberRoleRec mr in _memberRoles.Items.Values.Where(m => m.ServerId == s.Id && m.RoleIds.Contains(roleId)).ToList())
                {
                    mr.RoleIds = mr.RoleIds.Where(x => x != roleId).ToArray();
                    _memberRoles.Put(mr.ServerId + "|" + mr.UserId, mr);
                }
                PushServer(s);
                return new { status = "deleted", id = roleId };
            }
        }

        /// <summary>Set a member's whole role list. The target is a member key (route resolves the username first).</summary>
        public object SetMemberRoles(string meName, string id, string userKey, string[] roleIds)
        {
            lock (_gate)
            {
                ServerRec s = ManagedServerFor(Norm(meName), id);
                string who = Norm(userKey);
                if (!s.Members.Contains(who)) throw new SocialException(404, "That user is not in this server.");
                string[] valid = (roleIds ?? Array.Empty<string>())
                    .Where(rid => _roles.TryGet(rid, out RoleRec? r) && r.ServerId == s.Id).Distinct().ToArray();
                if (valid.Length == 0) _memberRoles.Remove(s.Id + "|" + who);
                else _memberRoles.Put(s.Id + "|" + who, new MemberRoleRec { ServerId = s.Id, UserId = who, RoleIds = valid });
                PushServer(s);
                return new { username = Display(who), roles = valid };
            }
        }
    }
}

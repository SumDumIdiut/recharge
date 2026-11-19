using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Recharge.Server
{
    /// <summary>Global shared custom emojis. Registered in their own JSONL store; images live in the media dir.</summary>
    public sealed partial class SocialService
    {
        private const int EmojiBytes = 256 * 1024;
        private static readonly Regex EmojiShortRe = new Regex(@"^[a-z0-9_]{2,32}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        /// <summary>Add a custom emoji for everyone; the caller is recorded as its owner. It also lands in the caller's own arsenal.</summary>
        public object UploadEmoji(string meName, string? shortcode, string? mime, string? dataBase64)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                EmojiRec e = RegisterEmojiLocked(me, shortcode, dataBase64);
                AddToArsenalLocked(me, e.Shortcode);
                return new { shortcode = e.Shortcode, url = MediaUrl(e.Media) };
            }
        }

        /// <summary>Validate and store one emoji image in the global registry. Caller holds _gate.</summary>
        private EmojiRec RegisterEmojiLocked(string me, string? shortcode, string? dataBase64)
        {
            _emojiLimit.Hit(me, "You are uploading emojis too fast.");
            string sc = (shortcode ?? "").Trim().ToLowerInvariant();
            if (!EmojiShortRe.IsMatch(sc)) throw new SocialException(400, "Use 2-32 letters, digits or underscores for the shortcode.");
            if (_emojis.TryGet(sc, out _)) throw new SocialException(409, "That shortcode is already taken.");
            if (string.IsNullOrEmpty(dataBase64) || dataBase64.Length > 400 * 1024)
                throw new SocialException(413, "That emoji is too large.");
            byte[] bytes;
            try { bytes = Convert.FromBase64String(dataBase64); }
            catch (FormatException) { throw new SocialException(400, "That file wasn't valid base64."); }
            // mime is a hint only: the bytes decide the extension.
            string? ext = SniffExt(bytes);
            if (ext is null || (ext != "png" && ext != "gif" && ext != "webp"))
                throw new SocialException(415, "Emojis must be PNG, GIF or WebP images.");
            if (bytes.Length > EmojiBytes) throw new SocialException(413, "Emojis must be 256 KB or less.");
            string file = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant() + "." + ext;
            File.WriteAllBytes(Path.Combine(_mediaDir, file), bytes);
            var rec = new EmojiRec { Shortcode = sc, Media = file, Owner = me, Created = Now() };
            _emojis.Put(sc, rec);
            return rec;
        }

        /// <summary>Every registered emoji, for :shortcode: rendering (everyone resolves every emoji).</summary>
        public object[] ListEmojis()
        {
            lock (_gate)
            {
                return _emojis.Items.Values.OrderBy(e => e.Shortcode, StringComparer.Ordinal)
                    .Select(e => (object)new { shortcode = e.Shortcode, url = MediaUrl(e.Media) }).ToArray();
            }
        }

        // ---- per-user arsenal (the picker's set) ----
        private void AddToArsenalLocked(string userKey, params string[] shortcodes)
        {
            string key = Norm(userKey);
            string[] have = _arsenals.TryGet(key, out ArsenalRec? a) ? a.Shortcodes : Array.Empty<string>();
            string[] next = have.Concat(shortcodes).Distinct(StringComparer.Ordinal).ToArray();
            if (next.Length != have.Length)
                _arsenals.Put(key, new ArsenalRec { UserId = key, Shortcodes = next });
        }

        /// <summary>Union a server's emoji shortcodes into a member's arsenal (kept forever, even after leaving).</summary>
        private void GrantServerEmojis(string userKey, string serverId)
        {
            string[] codes = _serverEmojis.Items.Values.Where(e => e.ServerId == serverId).Select(e => e.Shortcode).ToArray();
            if (codes.Length > 0) AddToArsenalLocked(userKey, codes);
        }

        /// <summary>The caller's arsenal: the emoji their picker offers (own uploads + everything from servers they have joined).</summary>
        public object[] MyArsenal(string meName)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                string[] codes = _arsenals.TryGet(me, out ArsenalRec? a) ? a.Shortcodes : Array.Empty<string>();
                return codes.Where(sc => _emojis.TryGet(sc, out _)).OrderBy(sc => sc, StringComparer.Ordinal)
                    .Select(sc => { _emojis.TryGet(sc, out EmojiRec? e); return (object)new { shortcode = sc, url = MediaUrl(e!.Media) }; }).ToArray();
            }
        }

        // ---- a server's emoji set ----
        /// <summary>A server's emoji set (members may view; used by server settings and to show what joining grants).</summary>
        public object[] ServerEmojis(string meName, string id)
        {
            lock (_gate)
            {
                ServerRec s = ServerFor(Norm(meName), id);
                return _serverEmojis.Items.Values.Where(e => e.ServerId == s.Id)
                    .Where(e => _emojis.TryGet(e.Shortcode, out _)).OrderBy(e => e.Shortcode, StringComparer.Ordinal)
                    .Select(e => { _emojis.TryGet(e.Shortcode, out EmojiRec? r); return (object)new { shortcode = e.Shortcode, url = MediaUrl(r!.Media) }; }).ToArray();
            }
        }

        /// <summary>Add an emoji to a server (owner/admin): registers it, links it to the server, and grants it to every current member's arsenal.</summary>
        public object AddServerEmoji(string meName, string id, string? shortcode, string? mime, string? dataBase64)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                ServerRec s = ManagedServerFor(me, id);
                EmojiRec e = RegisterEmojiLocked(me, shortcode, dataBase64);
                _serverEmojis.Put(s.Id + "|" + e.Shortcode, new ServerEmojiRec { ServerId = s.Id, Shortcode = e.Shortcode });
                foreach (string member in s.Members.Distinct()) AddToArsenalLocked(member, e.Shortcode);
                PushServer(s);
                return new { shortcode = e.Shortcode, url = MediaUrl(e.Media) };
            }
        }

        /// <summary>Remove an emoji from a server's set (owner/admin). Members who already unlocked it keep it in their arsenal.</summary>
        public object RemoveServerEmoji(string meName, string id, string shortcode)
        {
            lock (_gate)
            {
                ServerRec s = ManagedServerFor(Norm(meName), id);
                string sc = (shortcode ?? "").Trim().ToLowerInvariant();
                if (!_serverEmojis.TryGet(s.Id + "|" + sc, out _)) throw new SocialException(404, "That emoji is not on this server.");
                _serverEmojis.Remove(s.Id + "|" + sc);
                PushServer(s);
                return new { status = "removed", shortcode = sc };
            }
        }

        /// <summary>Remove a shared emoji; owner or admin only. The image file stays in the media dir.</summary>
        public void DeleteEmoji(string meName, string shortcode, bool admin = false)
        {
            lock (_gate)
            {
                string me = Norm(meName);
                string sc = (shortcode ?? "").Trim().ToLowerInvariant();
                if (!_emojis.TryGet(sc, out EmojiRec? e)) throw new SocialException(404, "That emoji was not found.");
                if (!admin && !string.Equals(e.Owner, me, StringComparison.Ordinal))
                    throw new SocialException(403, "Only the uploader or an admin can remove this emoji.");
                _emojis.Remove(sc);
            }
        }
    }
}

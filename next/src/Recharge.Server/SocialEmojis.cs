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

        /// <summary>Add a custom emoji for everyone; the caller is recorded as its owner.</summary>
        public object UploadEmoji(string meName, string? shortcode, string? mime, string? dataBase64)
        {
            lock (_gate)
            {
                string me = Norm(meName);
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
                _emojis.Put(sc, new EmojiRec { Shortcode = sc, Media = file, Owner = me, Created = Now() });
                return new { shortcode = sc, url = MediaUrl(file) };
            }
        }

        /// <summary>Every registered emoji, for the picker and :shortcode: rendering.</summary>
        public object[] ListEmojis()
        {
            lock (_gate)
            {
                return _emojis.Items.Values.OrderBy(e => e.Shortcode, StringComparer.Ordinal)
                    .Select(e => (object)new { shortcode = e.Shortcode, url = MediaUrl(e.Media) }).ToArray();
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

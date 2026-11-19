using System;
using System.Collections.Generic;

namespace Recharge.Server
{
    // Stored shapes (one JSON-lines file each). Names are stored in the hub's spelling; keys use the lower-case form.
    public sealed class UserRec { public string Name { get; set; } = ""; }

    public sealed class FriendRec
    {
        public string A { get; set; } = "";
        public string B { get; set; } = "";
        public long Since { get; set; }
    }

    public sealed class RequestRec
    {
        public string From { get; set; } = "";
        public string To { get; set; } = "";
        public long Created { get; set; }
    }

    public sealed class BlockRec
    {
        public string Blocker { get; set; } = "";
        public string Blocked { get; set; } = "";
        public long Created { get; set; }
    }

    public sealed class CardRec
    {
        public string Type { get; set; } = "";
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
    }

    public sealed class MessageRec
    {
        public long Id { get; set; }
        public string From { get; set; } = "";
        public string To { get; set; } = "";
        public string Text { get; set; } = "";
        public CardRec? Card { get; set; }
        public long Ts { get; set; }
        /// <summary>The sender's own id for this message; sending the same one again returns the stored message instead of a duplicate.</summary>
        public string Cid { get; set; } = "";
        /// <summary>The conversation this belongs to ("dm:a|b" or "g:xxxxxxxxxxxx"). Empty only in pre-groups data, which is migrated on load.</summary>
        public string ConvId { get; set; } = "";
        /// <summary>The id of the message this one replies to (same conversation), or 0.</summary>
        public long ReplyTo { get; set; }
        /// <summary>Emoji to lower-case usernames who reacted.</summary>
        public Dictionary<string, List<string>> Reactions { get; set; } = new();
        /// <summary>When the author last edited the text, or 0.</summary>
        public long EditedAt { get; set; }
        /// <summary>When the author deleted this message (tombstone), or 0.</summary>
        public long DeletedAt { get; set; }
        /// <summary>Stored media filenames (32 hex + extension) on this message.</summary>
        public List<string> Media { get; set; } = new();
    }

    public sealed class ConversationRec
    {
        public string Id { get; set; } = "";
        /// <summary>"dm" or "group".</summary>
        public string Kind { get; set; } = "dm";
        public string Name { get; set; } = "";
        /// <summary>Lower-case member keys.</summary>
        public string[] Members { get; set; } = Array.Empty<string>();
        public string Owner { get; set; } = "";
        /// <summary>Group look: <see cref="Color"/> is #rrggbb, <see cref="Avatar"/> a stored media filename; empty means default.</summary>
        public string Color { get; set; } = "";
        public string Avatar { get; set; } = "";
        public long Created { get; set; }
    }

    /// <summary>A Discord-style server; members are lower-case user keys. Its channels hold the messages.</summary>
    public sealed class ServerRec
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        /// <summary>Stored avatar media filename, or "".</summary>
        public string Icon { get; set; } = "";
        public string OwnerId { get; set; } = "";
        public string[] Members { get; set; } = Array.Empty<string>();
        public long Created { get; set; }
    }

    /// <summary>A channel in a server; text channel ids double as conversation ids, voice channels are call rooms.</summary>
    public sealed class ChannelRec
    {
        public string Id { get; set; } = "";
        public string ServerId { get; set; } = "";
        public string Name { get; set; } = "";
        /// <summary>"text" or "voice".</summary>
        public string Kind { get; set; } = "text";
        public string Topic { get; set; } = "";
        public int Position { get; set; }
        /// <summary>The category this channel sits under, or "" for the uncategorised group. Old rows read as "".</summary>
        public string CategoryId { get; set; } = "";
        public long Created { get; set; }
    }

    /// <summary>A named, ordered group of channels within a server (Discord-style category).</summary>
    public sealed class CategoryRec
    {
        public string Id { get; set; } = "";
        public string ServerId { get; set; } = "";
        public string Name { get; set; } = "";
        public int Position { get; set; }
        public long Created { get; set; }
    }

    /// <summary>A cosmetic role: a coloured name label; Admin grants server management. Higher Position wins for colour.</summary>
    public sealed class RoleRec
    {
        public string Id { get; set; } = "";
        public string ServerId { get; set; } = "";
        public string Name { get; set; } = "";
        /// <summary>A #rrggbb colour, or "" for none.</summary>
        public string Color { get; set; } = "";
        public bool Admin { get; set; }
        public int Position { get; set; }
        public long Created { get; set; }
    }

    /// <summary>One member's role assignments in a server; keyed "serverId|userId".</summary>
    public sealed class MemberRoleRec
    {
        public string ServerId { get; set; } = "";
        public string UserId { get; set; } = "";
        public string[] RoleIds { get; set; } = Array.Empty<string>();
    }

    /// <summary>A shortcode that belongs to a server's emoji set; keyed "serverId|shortcode". The image is the global EmojiRec.</summary>
    public sealed class ServerEmojiRec
    {
        public string ServerId { get; set; } = "";
        public string Shortcode { get; set; } = "";
    }

    /// <summary>A user's personal emoji arsenal: the shortcodes their picker offers, kept forever. Keyed by userId.</summary>
    public sealed class ArsenalRec
    {
        public string UserId { get; set; } = "";
        public string[] Shortcodes { get; set; } = Array.Empty<string>();
    }

    public sealed class ReadRec
    {
        public long UpTo { get; set; }
    }

    public sealed class SettingsRec
    {
        public bool AllowStrangers { get; set; }
        public bool Invisible { get; set; }
    }

    public sealed class ShareRec
    {
        public string Id { get; set; } = "";
        public string Owner { get; set; } = "";
        public string MapId { get; set; } = "";
        public string Name { get; set; } = "";
        public string ObjectKey { get; set; } = "";
        public string Mode { get; set; } = "view";
        /// <summary>The friend it is shared with, or empty for a private link.</summary>
        public string Target { get; set; } = "";
        public string TokenHash { get; set; } = "";
        public long Created { get; set; }
        public long Expires { get; set; }
        public bool Revoked { get; set; }
    }

    /// <summary>A global shared custom emoji; keyed by shortcode, image lives in the media dir.</summary>
    public sealed class EmojiRec
    {
        public string Shortcode { get; set; } = "";
        public string Media { get; set; } = "";
        public string Owner { get; set; } = "";
        public long Created { get; set; }
    }

    /// <summary>A user's extended profile, stored as its canonical JSON text (see <see cref="ProfileSchema"/>).</summary>
    public sealed class ProfileRec
    {
        public string Json { get; set; } = "";
        public int Version { get; set; } = 1;
        public long Updated { get; set; }
    }
}

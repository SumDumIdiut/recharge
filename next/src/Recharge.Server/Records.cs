using System;

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

    /// <summary>A user's extended profile, stored as its canonical JSON text (see <see cref="ProfileSchema"/>).</summary>
    public sealed class ProfileRec
    {
        public string Json { get; set; } = "";
        public int Version { get; set; } = 1;
        public long Updated { get; set; }
    }
}

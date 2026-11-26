using UnityEngine;

namespace Recharge.ModApi
{
    /// <summary>
    /// Lets the multiplayer module show each player's skin on their ghost without
    /// a hard reference to the Skins module. The Skins module registers an
    /// implementation; the Net module reads <see cref="SkinGhostBridge.Current"/>.
    /// </summary>
    public interface ISkinGhostBridge
    {
        /// <summary>The local player's current skin folder, transmitted to peers; null for vanilla.</summary>
        string LocalSkinFolder { get; }

        /// <summary>True when the named skin folder exists locally and can be applied.</summary>
        bool HasSkin(string folder);

        /// <summary>
        /// The skinned sprite for a given vanilla animation frame using the named
        /// skin, or null when the skin is unavailable or the frame doesn't map
        /// (the caller then keeps the vanilla sprite as the fallback).
        /// </summary>
        Sprite ResolveSprite(string folder, Sprite vanillaSprite);
    }

    public static class SkinGhostBridge
    {
        /// <summary>Set by the Skins module on init; null when skins aren't loaded.</summary>
        public static ISkinGhostBridge Current;
    }
}

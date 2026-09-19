namespace Recharge.ModApi
{
    /// <summary>
    /// Well-known event names the loader itself emits on <see cref="IRechargeHost.Events"/> -
    /// use these constants instead of retyping the raw strings so a typo
    /// doesn't silently turn into "nothing ever fires." A mod is equally
    /// free to <c>Emit</c>/<c>On</c> its own arbitrary event names for
    /// talking to other mods - these are just the ones the loader itself
    /// promises to fire.
    /// </summary>
    public static class RechargeEvents
    {
        /// <summary>
        /// Fires once, after every mod's <see cref="IRechargeMod.OnLoad"/>
        /// has returned (in dependency order - see mod.json's
        /// "dependencies"). No payload. The right place to look up another
        /// mod via <see cref="IRechargeHost.GetMod"/> if you'd rather wait
        /// for everyone to be loaded than assume your own load order.
        /// </summary>
        public const string ModsReady = "recharge.mods_ready";

        /// <summary>Fires once per mod right after that mod's OnLoad returns successfully. Payload: that mod's <see cref="IRechargeMod.Id"/> (string).</summary>
        public const string ModLoaded = "recharge.mod_loaded";

        /// <summary>Mirrors UnityEngine.SceneManagement.SceneManager.sceneLoaded. Payload: the loaded scene's name (string).</summary>
        public const string SceneLoaded = "recharge.scene_loaded";

        /// <summary>
        /// Fires the first time a GameObject tagged "Player" with a real
        /// Movement component is found after a scene load (polled once per
        /// scene via the loader's own ticker, not a real game hook - there's
        /// no cheaper way to know without one). Payload: the player GameObject.
        /// </summary>
        public const string PlayerSpawned = "recharge.player_spawned";
    }
}

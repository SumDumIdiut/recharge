using System;

namespace Recharge.ModApi
{
    /// <summary>
    /// The contract every RechargeLoader mod implements. Exactly one public,
    /// non-abstract class implementing this interface must exist in a mod's
    /// entry assembly - <c>RechargeLoaderBootstrap</c> finds it by scanning
    /// the assembly's types via reflection, so there's nothing else to
    /// register. See loader/docs/creating-a-mod.md for a full walkthrough.
    /// </summary>
    public interface IRechargeMod
    {
        /// <summary>
        /// Stable unique identifier, e.g. "yourname.modname". Should match
        /// mod.json's "id" - used as the deploy folder name and as this
        /// mod's <see cref="IRechargeHost.ModDataDir"/> key.
        /// </summary>
        string Id { get; }

        /// <summary>Human-readable name shown in load-order logs and Recharge's own UI. Purely cosmetic.</summary>
        string DisplayName { get; }

        /// <summary>This mod's own version. Logged on load; not currently compared against anything.</summary>
        Version Version { get; }

        /// <summary>
        /// Called once, the first time the player opens the pause menu in a
        /// session - by then the whole game is up, so ordinary Unity APIs
        /// (GameObject.Find, FindObjectOfType, coroutines, ...) all work
        /// normally from here. Exceptions thrown here are caught and logged
        /// per-mod by RechargeLoaderBootstrap - one mod failing to load
        /// doesn't take down the others.
        /// </summary>
        void OnLoad(IRechargeHost host);

        /// <summary>
        /// Reserved for a future hot-unload feature - not currently called
        /// (mods load once per session and live until the process exits).
        /// Implement it anyway: unsubscribe from any static events you
        /// subscribed to, stop coroutines, destroy GameObjects you created.
        /// </summary>
        void OnUnload();
    }
}

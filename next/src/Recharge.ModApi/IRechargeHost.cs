using System;
using UnityEngine;

namespace Recharge.ModApi
{
    /// <summary>
    /// The one loader-provided entry point a mod's <see cref="IRechargeMod.OnLoad"/>
    /// receives. Everything else (scene objects, SceneManager, coroutines)
    /// is reached through ordinary Unity APIs from there, not through this
    /// interface. See loader/docs/api-reference.md for the full reference.
    /// </summary>
    public interface IRechargeHost
    {
        /// <summary>
        /// The real, live pauseMenuScript instance whose Awake() triggered
        /// loading. <see cref="PauseMenuHelper"/> uses it to add a row -
        /// prefer that over hand-rolling the same UI hierarchy cloning
        /// again. Its <c>mainBitPublic</c>/<c>settingsBitPublic</c>
        /// properties (added by RechargeLoader's own game patch, since the
        /// real fields are private) are still there for your own mod code
        /// to use directly if you need them - PauseMenuHelper itself reads
        /// the underlying fields via reflection instead, since it builds as
        /// part of Recharge.ModApi, before the patch that adds them runs.
        /// </summary>
        pauseMenuScript PauseMenu { get; }

        /// <summary>Logs via Debug.Log with a "[Recharge:&lt;modId&gt;] " prefix - prefer this over calling Debug.Log directly so your mod's lines are attributable and greppable in Player.log. The modId is whatever you passed to the call that produced this host, i.e. your own <see cref="IRechargeMod.Id"/>.</summary>
        void Log(string message);

        /// <summary>Logs via Debug.LogWarning with a "[Recharge:&lt;modId&gt;] " prefix.</summary>
        void LogWarning(string message);

        /// <summary>Logs via Debug.LogError with a "[Recharge:&lt;modId&gt;] " prefix.</summary>
        void LogError(string message);

        /// <summary>
        /// Returns (creating if needed) this mod's private data folder,
        /// <c>&lt;GameDir&gt;\Recharge\Mods\&lt;modId&gt;\data\</c> - pass
        /// your own <see cref="IRechargeMod.Id"/>. Create whatever further
        /// subfolders your mod needs inside it on first use.
        /// </summary>
        string ModDataDir(string modId);

        /// <summary>
        /// The session-wide pub/sub bus every mod shares - the "custom event
        /// calls" mechanism for reacting to loader lifecycle events (see
        /// <see cref="RechargeEvents"/>) and for talking to other mods
        /// without a compile-time reference to their assembly.
        /// </summary>
        IEventBus Events { get; }

        /// <summary>Fires every frame, from a single shared MonoBehaviour's Update() - saves a mod from creating its own GameObject solely to get a per-frame callback. A handler that throws is logged and does not stop other subscribers from running that frame.</summary>
        event Action OnUpdate;

        /// <summary>Fires every frame from LateUpdate() - after every OnUpdate subscriber has run.</summary>
        event Action OnLateUpdate;

        /// <summary>Fires every physics step from FixedUpdate().</summary>
        event Action OnFixedUpdate;

        /// <summary>
        /// Looks up another already-loaded mod by its <see cref="IRechargeMod.Id"/>.
        /// Returns null if no mod with that id is loaded (including "not
        /// loaded yet" - load order across mods isn't guaranteed unless one
        /// declares the other in mod.json's "dependencies", so prefer
        /// calling this from a <see cref="RechargeEvents.ModsReady"/>
        /// handler over directly inside your own OnLoad if you're not sure).
        /// </summary>
        IRechargeMod GetMod(string modId);

        /// <summary>Same as <see cref="GetMod"/>, but casts the result to <typeparamref name="T"/> for you (typically an interface or base type the target mod's class implements) - returns null if the mod isn't loaded OR doesn't implement <typeparamref name="T"/>.</summary>
        T GetModApi<T>(string modId) where T : class;

        /// <summary>
        /// Loads this mod's JSON-backed config from its data folder
        /// (<see cref="ModDataDir"/>/<paramref name="fileName"/>), or returns
        /// a fresh <c>new T()</c> if the file doesn't exist yet or fails to
        /// parse (logged as a warning, not thrown - a corrupt config
        /// shouldn't stop your mod from loading, just fall back to defaults).
        /// </summary>
        T LoadConfig<T>(string modId, string fileName = "config.json") where T : new();

        /// <summary>Writes <paramref name="config"/> as indented JSON to this mod's data folder. Call this whenever your config changes - there's no autosave.</summary>
        void SaveConfig<T>(string modId, T config, string fileName = "config.json");

        /// <summary>
        /// Decodes raw PNG/JPG bytes into a real Sprite (pivot centered),
        /// ready to assign to a SpriteRenderer or Image - wraps the
        /// ImageConversion.LoadImage + Sprite.Create pair every mod that
        /// shows a custom image otherwise hand-rolls itself. Returns null if
        /// the bytes don't decode as an image.
        /// </summary>
        Sprite LoadSprite(byte[] imageBytes, float pixelsPerUnit = 100f);
    }
}

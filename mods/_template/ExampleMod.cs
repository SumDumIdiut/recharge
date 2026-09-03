using System;
using Recharge.ModApi;

// The one required type: exactly one public, non-abstract class in this
// assembly must implement IRechargeMod. RechargeLoaderBootstrap finds it via
// reflection when it loads this DLL - no registration anywhere else needed,
// see IRechargeMod.cs for the full contract.
//
// This template demonstrates every IRechargeHost capability at least once -
// delete whichever parts your real mod doesn't need. See
// loader/docs/api-reference.md for the full reference on each of these.
public class ExampleMod : IRechargeMod
{
    // Keep Id identical to mod.json's "id" - it's this mod's key everywhere
    // (deploy folder, ModDataDir, and how another mod finds it via
    // host.GetMod("yourname.modname")).
    public string Id => "yourname.modname";
    public string DisplayName => "My Mod";
    public Version Version => new Version(1, 0, 0);

    private class MyConfig
    {
        public int TimesLoaded;
        public bool ShowPauseMenuButton = true;
    }

    public void OnLoad(IRechargeHost host)
    {
        host.Log(DisplayName + " loaded!");

        // --- Config -----------------------------------------------------
        // JSON-backed, stored under this mod's own data folder. Returns
        // fresh defaults the first time (or if the file is missing/corrupt).
        var config = host.LoadConfig<MyConfig>(Id);
        config.TimesLoaded++;
        host.SaveConfig(Id, config);
        host.Log("Loaded " + config.TimesLoaded + " time(s) total.");

        // --- Events -------------------------------------------------------
        // React to loader lifecycle events, or define your own for other
        // mods to react to (host.Events.Emit("yourname.modname.something", data)).
        host.Events.On(RechargeEvents.ModsReady, _ =>
        {
            // Every mod's OnLoad has now run - the right place to look up
            // another mod, since load order across mods isn't otherwise
            // guaranteed (declare "dependencies" in mod.json instead if you
            // need a specific one loaded before you, not just "eventually").
            var maps = host.GetMod("recharge.maps");
            if (maps != null) host.Log("Found the real Maps mod: " + maps.DisplayName);
        });
        host.Events.On(RechargeEvents.PlayerSpawned, payload =>
        {
            host.Log("A real Player appeared in the scene.");
        });

        // --- Per-frame hook -------------------------------------------------
        // No need to create your own GameObject just to get an Update() call.
        int frames = 0;
        host.OnUpdate += () =>
        {
            frames++;
            if (frames == 300) host.Log("300 frames have ticked since load.");
        };

        // --- Pause-menu integration ---------------------------------------
        if (config.ShowPauseMenuButton)
        {
            var panel = PauseMenuHelper.AddPanelRow(host.PauseMenu, "MyModRow", DisplayName);
            // panel is a blank sub-panel with its title/Back button already
            // wired up - add your own UI content to it here, e.g. via
            // UnityEngine.UI/TextMeshPro components, same as any other
            // runtime-built Unity UI. See mods/recharge-maps/MapMenuBuilder.cs
            // (pre-PauseMenuHelper) for a hand-built full example if you want
            // to go further than the helper.
        }

        // --- Reaching real game state ---------------------------------------
        // host.PauseMenu is the real, live pauseMenuScript instance. Most
        // real game classes expose almost nothing public - Reflect wraps the
        // BindingFlags boilerplate for reaching what they don't:
        //   var respawnPoint = Reflect.GetField<UnityEngine.Vector3>(movement, "respawnPoint");
        //   Reflect.SetField(spring, "strength", 2.5f);
        //   Reflect.InvokeMethod(platform, "JumpToState", 0);

        // --- Custom images --------------------------------------------------
        // var sprite = host.LoadSprite(File.ReadAllBytes(imagePath));
        // (then assign it to a SpriteRenderer/Image as usual)
    }

    // Called if the loader ever supports hot-unloading mods (not yet - OnLoad
    // currently only runs once per game session). Implement defensively:
    // unsubscribe from events, stop coroutines, destroy GameObjects you made.
    public void OnUnload()
    {
    }
}

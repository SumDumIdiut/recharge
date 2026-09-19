using System;
using UnityEngine;
using TMPro;
using Recharge.ModApi;

// Demonstrates every IRechargeHost/IRechargeMod capability at least once.
// Copy this folder to start a real mod - delete whatever you don't need.
public class ExampleMod : IRechargeMod
{
    public string Id => "recharge.example";
    public string DisplayName => "Example Mod";
    public Version Version => new Version(1, 0, 0);

    private class MyConfig
    {
        public int TimesLoaded;
    }

    public void OnLoad(IRechargeHost host)
    {
        // --- Logging ---
        host.Log("Example Mod loaded.");
        host.LogWarning("This is a warning-level log line.");
        host.LogError("This is an error-level log line (not a real error).");

        // --- Config: JSON-backed, stored under this mod's own data folder ---
        var config = host.LoadConfig<MyConfig>(Id);
        config.TimesLoaded++;
        host.SaveConfig(Id, config);
        host.Log($"Loaded {config.TimesLoaded} time(s) total.");

        // --- Events: react to the loader's own lifecycle events ---
        host.Events.On(RechargeEvents.ModsReady, _ => host.Log("Every mod has now loaded."));
        host.Events.On(RechargeEvents.ModLoaded, id => host.Log($"Mod loaded: {id}"));
        host.Events.On(RechargeEvents.SceneLoaded, scene => host.Log($"Scene loaded: {scene}"));
        host.Events.On(RechargeEvents.PlayerSpawned, _ => host.Log("A real Player appeared in the scene."));

        // Mods can also define and fire their own event names for other mods to react to.
        host.Events.On("recharge.example.ping", payload => host.Log($"Got a ping: {payload}"));
        host.Events.Emit("recharge.example.ping", "hello from OnLoad");

        // --- Looking up another mod (after everyone's loaded) ---
        host.Events.On(RechargeEvents.ModsReady, _ =>
        {
            var maps = host.GetMod("recharge.maps");
            if (maps != null) host.Log($"Found the real Maps mod: {maps.DisplayName}");
        });

        // --- Per-frame hooks - no need for your own GameObject/Update() ---
        int updates = 0, lateUpdates = 0, fixedUpdates = 0;
        host.OnUpdate += () => { if (++updates == 1) host.Log("First OnUpdate tick."); };
        host.OnLateUpdate += () => { if (++lateUpdates == 1) host.Log("First OnLateUpdate tick."); };
        host.OnFixedUpdate += () => { if (++fixedUpdates == 1) host.Log("First OnFixedUpdate tick."); };

        // --- Reflection: reaching the game's private fields/methods ---
        var mainBit = Reflect.GetField<GameObject>(host.PauseMenu, "mainBit");
        host.Log($"Reflected pauseMenuScript.mainBit: {(mainBit != null ? mainBit.name : "null")}");

        // --- Pause-menu integration: adds a row that opens a sub-panel ---
        var panel = PauseMenuHelper.AddPanelRow(host.PauseMenu, "ExampleModRow", DisplayName);
        if (panel != null)
        {
            var textGo = new GameObject("Label", typeof(RectTransform));
            textGo.transform.SetParent(panel.transform, false);
            var text = textGo.AddComponent<TextMeshProUGUI>();
            text.text = $"Example Mod - loaded {config.TimesLoaded} time(s).";
            text.fontSize = 24;
            text.alignment = TextAlignmentOptions.Center;
        }

        // --- Custom images: decode bytes into a ready-to-use Sprite ---
        // var sprite = host.LoadSprite(File.ReadAllBytes(imagePath));
    }

    public void OnUnload()
    {
    }
}

using System;
using System.IO;
using TMPro;
using UnityEngine;
using Recharge.ModApi;

// Demonstrates every IRechargeHost/IRechargeMod capability at least once,
// including a real interactive pause-menu panel (button, input field,
// procedurally-generated image). Copy this folder to start a real mod -
// delete whatever you don't need. See ExamplePanelUI.cs for the UI half.
public class ExampleMod : IRechargeMod
{
    public string Id => "recharge.example";
    public string DisplayName => "Example Mod";
    public Version Version => new Version(1, 0, 0);

    public class MyConfig
    {
        public int TimesLoaded;
        public int TimesClicked;
    }

    private IRechargeHost _host;
    private MyConfig _config;
    private Action<object> _pingHandler;

    public void OnLoad(IRechargeHost host)
    {
        _host = host;

        // --- Logging: Debug.Log/Warning/Error, tagged "[Recharge:recharge.example]" in Player.log ---
        host.Log("Example Mod loaded.");
        host.LogWarning("This is a warning-level log line.");
        host.LogError("This is an error-level log line (not a real error).");

        // --- Config: JSON-backed, stored under this mod's own data folder ---
        _config = host.LoadConfig<MyConfig>(Id);
        _config.TimesLoaded++;
        host.SaveConfig(Id, _config);
        host.Log($"Loaded {_config.TimesLoaded} time(s), clicked the demo button {_config.TimesClicked} time(s) so far.");

        // --- Data folder: for anything that isn't the JSON config - the mod owns this folder outright ---
        var notesPath = Path.Combine(host.ModDataDir(Id), "notes.txt");
        File.AppendAllText(notesPath, $"Loaded at {DateTime.Now:O}\n");

        // --- Events: react to the loader's own lifecycle events ---
        host.Events.On(RechargeEvents.ModsReady, _ =>
        {
            host.Log("Every mod has now loaded.");
            var maps = host.GetMod("recharge.maps");
            if (maps != null) host.Log($"Found the real Maps mod: {maps.DisplayName}");
        });
        host.Events.On(RechargeEvents.ModLoaded, id => host.Log($"Mod loaded: {id}"));
        host.Events.On(RechargeEvents.SceneLoaded, scene => host.Log($"Scene loaded: {scene}"));
        host.Events.On(RechargeEvents.PlayerSpawned, _ => host.Log("A real Player appeared in the scene."));

        // Mods can also define and fire their own event names for other mods to react to -
        // keep a reference to the handler so OnUnload can cleanly Off() it again.
        _pingHandler = payload => host.Log($"Got a ping: {payload}");
        host.Events.On("recharge.example.ping", _pingHandler);
        host.Events.Emit("recharge.example.ping", "hello from OnLoad");

        // --- Per-frame hooks - no need for your own GameObject/Update() ---
        int updates = 0, lateUpdates = 0, fixedUpdates = 0;
        host.OnUpdate += () => { if (++updates == 1) host.Log("First OnUpdate tick."); };
        host.OnLateUpdate += () => { if (++lateUpdates == 1) host.Log("First OnLateUpdate tick."); };
        host.OnFixedUpdate += () => { if (++fixedUpdates == 1) host.Log("First OnFixedUpdate tick."); };

        // --- Reflection: reaching the game's private fields ---
        var mainBit = Reflect.GetField<GameObject>(host.PauseMenu, "mainBit");
        host.Log($"Reflected pauseMenuScript.mainBit: {(mainBit != null ? mainBit.name : "null")}");
        var settingsBit = Reflect.TryGetField<GameObject>(host.PauseMenu, "settingsBit", fallback: null);
        host.Log($"Reflected pauseMenuScript.settingsBit (via TryGetField, falls back instead of throwing): {(settingsBit != null ? settingsBit.name : "null")}");

        // --- Pause-menu integration ---
        // mainBit/settingsBit get destroyed and rebuilt on every scene load, so
        // AddRow/AddPanelRow have to be re-run against the CURRENT live menu each
        // time - host.PauseMenu here is only the instance that was alive when
        // THIS OnLoad happened to run. InstallMenuRow re-finds the live one.
        InstallMenuRow(host.PauseMenu);
        host.Events.On(RechargeEvents.SceneLoaded, _ =>
            InstallMenuRow(UnityEngine.Object.FindFirstObjectByType<pauseMenuScript>()));
    }

    private void InstallMenuRow(pauseMenuScript menu)
    {
        if (menu == null) return;

        // A plain row: no sub-panel, just runs an action on click.
        PauseMenuHelper.AddRow(menu, "ExamplePing", "Example: Send a Ping", () =>
        {
            _host.Log("Ping row clicked.");
            _host.Events.Emit("recharge.example.ping", "hello from the pause menu");
        });

        // A row that opens its own sub-panel. MenuPanelRegistry hands back the
        // same GameObject on every later call (for this scene and every scene
        // after it), so only Build its contents once.
        var panel = PauseMenuHelper.AddPanelRow(menu, "ExamplePanel", DisplayName);
        if (panel != null && panel.GetComponent<ExamplePanelUI>() == null)
        {
            var title = panel.transform.Find("Settings") ?? (panel.transform.childCount > 0 ? panel.transform.GetChild(0) : null);
            var font = title != null ? title.GetComponent<TMP_Text>()?.font : null;
            panel.AddComponent<ExamplePanelUI>().Build(panel, font, _host, _config, Id);
        }
    }

    public void OnUnload()
    {
        if (_pingHandler != null) _host.Events.Off("recharge.example.ping", _pingHandler);
    }
}

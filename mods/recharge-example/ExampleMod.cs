using System;
using System.IO;
using TMPro;
using UnityEngine;
using Recharge.ModApi;

// Demonstrates every IRechargeHost/IRechargeMod capability, plus real game
// interaction (player/physics/scene/audio/tweening/coroutines/input) across
// three interactive pause-menu panels. Copy this folder to start a real mod -
// delete whatever you don't need. Each Demos/*.cs file is a self-contained
// deep dive into one topic; this file just wires them together and owns the
// mod's lifecycle.
public class ExampleMod : IRechargeMod, IExampleModApi
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
    private LoggingConfigDemo.ExtendedConfig _extendedConfig;
    private Action<object> _pingHandler;

    private EventsDemo _eventsDemo;
    private PlayerPhysicsDemo _playerPhysicsDemo;
    private UpdateLoopDemo _updateLoopDemo;
    private SceneDemo _sceneDemo;
    private InputDemo _inputDemo;

    // IExampleModApi - what another mod sees via
    // host.GetModApi<IExampleModApi>("recharge.example").
    public int ClickCount => _config.TimesClicked;
    public void Ping() => _host.Events.Emit("recharge.example.ping", "hello from IExampleModApi.Ping()");

    public void OnLoad(IRechargeHost host)
    {
        _host = host;

        // --- Logging: Debug.Log/Warning/Error, tagged "[Recharge:recharge.example]" in Player.log ---
        host.Log("Example Mod loaded.");
        host.LogWarning("This is a warning-level log line.");
        host.LogError("This is an error-level log line (not a real error).");

        // --- Config: the simple one-JSON-file case ---
        _config = host.LoadConfig<MyConfig>(Id);
        _config.TimesLoaded++;
        host.SaveConfig(Id, _config);
        host.Log($"Loaded {_config.TimesLoaded} time(s), clicked the demo button {_config.TimesClicked} time(s) so far.");

        // --- Config: nested types, lists, dictionaries, enums, schema migration ---
        _extendedConfig = LoggingConfigDemo.LoadAndMigrate(host, Id);

        // --- Data folder: raw file I/O beyond LoadConfig/SaveConfig ---
        var notesPath = Path.Combine(host.ModDataDir(Id), "notes.txt");
        File.AppendAllText(notesPath, $"Loaded at {DateTime.Now:O}\n");
        DataFolderDemo.AppendDemoScore(host, Id);
        DataFolderDemo.RoundTripBinaryBlob(host, Id);
        DataFolderDemo.ListDataFiles(host, Id);

        // --- Events: built-in lifecycle events ---
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

        // --- Events: deeper patterns (typed payloads, request/response, cross-mod API) ---
        _eventsDemo = new EventsDemo(host);

        // --- Per-frame hooks - no need for your own GameObject/Update() ---
        int updates = 0, lateUpdates = 0, fixedUpdates = 0;
        host.OnUpdate += () => { if (++updates == 1) host.Log("First OnUpdate tick."); };
        host.OnLateUpdate += () => { if (++lateUpdates == 1) host.Log("First OnLateUpdate tick."); };
        host.OnFixedUpdate += () => { if (++fixedUpdates == 1) host.Log("First OnFixedUpdate tick."); };

        // --- Deeper per-frame patterns: a polling state machine and a direct Input System keybind ---
        _updateLoopDemo = new UpdateLoopDemo(host);

        // --- Finding and reading the live player/physics state ---
        _playerPhysicsDemo = new PlayerPhysicsDemo(host);
        _updateLoopDemo.IcyPhysicsToggleRequested += icy => _playerPhysicsDemo.SetIcyPhysics(icy);

        // --- SceneManager access beyond the wrapped RechargeEvents.SceneLoaded, and spawning a world object ---
        _sceneDemo = new SceneDemo(host);

        // --- Deeper Input System usage: mouse/gamepad reads and a persisted, rebindable keybind ---
        _inputDemo = new InputDemo(host, Id);

        // --- Reflection: every Reflect.* method at least once ---
        ReflectionDemo.Run(host);

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

        // Three rows that each open their own sub-panel. MenuPanelRegistry
        // hands back the same GameObject on every later call (for this scene
        // and every scene after it), so only Build each panel's contents once.
        InstallSimplePanel(menu);
        InstallAdvancedPanel(menu);
        InstallExtraPanel(menu);
    }

    private void InstallSimplePanel(pauseMenuScript menu)
    {
        var panel = PauseMenuHelper.AddPanelRow(menu, "ExamplePanel", DisplayName);
        if (panel == null || panel.GetComponent<ExamplePanelUI>() != null) return;
        var font = FindTitleFont(panel);
        panel.AddComponent<ExamplePanelUI>().Build(panel, font, _host, _config, Id);
    }

    private void InstallAdvancedPanel(pauseMenuScript menu)
    {
        var panel = PauseMenuHelper.AddPanelRow(menu, "ExampleAdvancedPanel", "Example Mod: Advanced");
        if (panel == null || panel.GetComponent<AdvancedPanelUI>() != null) return;
        var font = FindTitleFont(panel);
        panel.AddComponent<AdvancedPanelUI>().Build(panel, font, _host, Id, _playerPhysicsDemo, _updateLoopDemo, _sceneDemo, _eventsDemo, _extendedConfig);
    }

    private void InstallExtraPanel(pauseMenuScript menu)
    {
        var panel = PauseMenuHelper.AddPanelRow(menu, "ExampleExtraPanel", "Example Mod: Extra");
        if (panel == null || panel.GetComponent<ExtraPanelUI>() != null) return;
        var font = FindTitleFont(panel);
        panel.AddComponent<ExtraPanelUI>().Build(panel, font, _host, Id, _inputDemo);
    }

    private static TMP_FontAsset FindTitleFont(GameObject panel)
    {
        var title = panel.transform.Find("Settings") ?? (panel.transform.childCount > 0 ? panel.transform.GetChild(0) : null);
        return title != null ? title.GetComponent<TMP_Text>()?.font : null;
    }

    public void OnUnload()
    {
        if (_pingHandler != null) _host.Events.Off("recharge.example.ping", _pingHandler);
        _eventsDemo?.Dispose();
        _sceneDemo?.Dispose();
    }
}

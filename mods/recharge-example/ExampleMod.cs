using System;
using System.IO;
using TMPro;
using UnityEngine;
using Recharge.ModApi;

// Demonstrates every IRechargeHost/IRechargeMod capability, plus real game
// interaction across three interactive pause-menu panels. Copy this folder to
// start a real mod - delete whatever you don't need. Each Demos/*.cs file is
// a self-contained deep dive into one topic; this file just wires them
// together and owns the mod's lifecycle.
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

    public int ClickCount => _config.TimesClicked;
    public void Ping() => _host.Events.Emit("recharge.example.ping", "hello from IExampleModApi.Ping()");

    public void OnLoad(IRechargeHost host)
    {
        _host = host;

        host.Log("Example Mod loaded.");
        host.LogWarning("This is a warning-level log line.");
        host.LogError("This is an error-level log line (not a real error).");

        _config = host.LoadConfig<MyConfig>(Id);
        _config.TimesLoaded++;
        host.SaveConfig(Id, _config);
        host.Log($"Loaded {_config.TimesLoaded} time(s), clicked the demo button {_config.TimesClicked} time(s) so far.");

        _extendedConfig = LoggingConfigDemo.LoadAndMigrate(host, Id);

        var notesPath = Path.Combine(host.ModDataDir(Id), "notes.txt");
        File.AppendAllText(notesPath, $"Loaded at {DateTime.Now:O}\n");
        DataFolderDemo.AppendDemoScore(host, Id);
        DataFolderDemo.RoundTripBinaryBlob(host, Id);
        DataFolderDemo.ListDataFiles(host, Id);

        host.Events.On(RechargeEvents.ModsReady, _ =>
        {
            host.Log("Every mod has now loaded.");
            var maps = host.GetMod("recharge.maps");
            if (maps != null) host.Log($"Found the real Maps mod: {maps.DisplayName}");
        });
        host.Events.On(RechargeEvents.ModLoaded, id => host.Log($"Mod loaded: {id}"));
        host.Events.On(RechargeEvents.SceneLoaded, scene => host.Log($"Scene loaded: {scene}"));
        host.Events.On(RechargeEvents.PlayerSpawned, _ => host.Log("A real Player appeared in the scene."));

        _pingHandler = payload => host.Log($"Got a ping: {payload}");
        host.Events.On("recharge.example.ping", _pingHandler);
        host.Events.Emit("recharge.example.ping", "hello from OnLoad");
        _eventsDemo = new EventsDemo(host);

        int updates = 0, lateUpdates = 0, fixedUpdates = 0;
        host.OnUpdate += () => { if (++updates == 1) host.Log("First OnUpdate tick."); };
        host.OnLateUpdate += () => { if (++lateUpdates == 1) host.Log("First OnLateUpdate tick."); };
        host.OnFixedUpdate += () => { if (++fixedUpdates == 1) host.Log("First OnFixedUpdate tick."); };
        _updateLoopDemo = new UpdateLoopDemo(host);

        _playerPhysicsDemo = new PlayerPhysicsDemo(host);
        _updateLoopDemo.IcyPhysicsToggleRequested += icy => _playerPhysicsDemo.SetIcyPhysics(icy);

        _sceneDemo = new SceneDemo(host);
        _inputDemo = new InputDemo(host, Id);
        ReflectionDemo.Run(host);

        // mainBit/settingsBit are destroyed and rebuilt every scene load, so
        // AddRow/AddPanelRow have to be re-run against the CURRENT live menu -
        // host.PauseMenu here is only the instance alive when OnLoad ran.
        InstallMenuRow(host.PauseMenu);
        host.Events.On(RechargeEvents.SceneLoaded, _ =>
            InstallMenuRow(UnityEngine.Object.FindFirstObjectByType<pauseMenuScript>()));
    }

    private void InstallMenuRow(pauseMenuScript menu)
    {
        if (menu == null) return;

        PauseMenuHelper.AddRow(menu, "ExamplePing", "Example: Send a Ping", () =>
        {
            _host.Log("Ping row clicked.");
            _host.Events.Emit("recharge.example.ping", "hello from the pause menu");
        });

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

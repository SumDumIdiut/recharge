using System;
using Recharge.ModApi;
using TMPro;
using UnityEngine;

public class RechargeIcyPhysicsMod : IRechargeMod
{
    public string Id => "recharge.icyphysics";
    public string DisplayName => "Icy Physics";
    public Version Version => new Version(1, 0, 0);

    public class Config { public bool Enabled = true; }

    private IRechargeHost _host;
    private Config _config;
    private IcyPhysicsController _controller;

    public void OnLoad(IRechargeHost host)
    {
        _host = host;
        _config = host.LoadConfig<Config>(Id);

        var go = new GameObject("IcyPhysicsController");
        UnityEngine.Object.DontDestroyOnLoad(go);
        _controller = go.AddComponent<IcyPhysicsController>();
        _controller.Enabled = _config.Enabled;

        host.Events.On(RechargeEvents.SceneLoaded, _ =>
        {
            var menu = UnityEngine.Object.FindFirstObjectByType<pauseMenuScript>();
            if (menu != null) InstallMenuRow(menu);
        });
    }

    private void InstallMenuRow(pauseMenuScript menu)
    {
        if (menu.mainBitPublic == null) return;
        var panel = PauseMenuHelper.AddPanelRow(menu, "IcyPhysics", "Icy Physics");
        if (panel == null) return;
        if (panel.GetComponent<IcyPhysicsPanelUI>() != null) return;

        var title = panel.transform.Find("Settings") ?? (panel.transform.childCount > 0 ? panel.transform.GetChild(0) : null);
        var font = title != null ? title.GetComponent<TMP_Text>()?.font : null;

        var ui = panel.AddComponent<IcyPhysicsPanelUI>();
        ui.Build(panel, font, _config.Enabled, enabled =>
        {
            _config.Enabled = enabled;
            _host.SaveConfig(Id, _config);
            _controller.Enabled = enabled;
        });
    }

    public void OnUnload() { }
}

using System;
using Recharge.ModApi;

public class RechargeMultiplayerMod : IRechargeMod
{
    public string Id => "recharge.multiplayer";
    public string DisplayName => "DOTnet";
    public Version Version => new Version(1, 6, 3);

    public void OnLoad(IRechargeHost host)
    {
        MpNetworkManager.Host = host;
        MpMenuBuilder.Install(host.PauseMenu);

        var hostPanelGo = new UnityEngine.GameObject("HostPanelController");
        UnityEngine.Object.DontDestroyOnLoad(hostPanelGo);
        var hostPanel = hostPanelGo.AddComponent<HostPanelController>();
        hostPanel.Init(host);

        // Every scene load creates a fresh, undecorated pauseMenuScript - reinstall each time.
        host.Events.On(RechargeEvents.SceneLoaded, _ =>
        {
            var menu = UnityEngine.Object.FindFirstObjectByType<pauseMenuScript>();
            if (menu != null)
            {
                MpMenuBuilder.Install(menu);
                hostPanel.InstallMenuRow(menu);
            }
        });
    }

    public void OnUnload() { }
}

using System;
using Recharge.ModApi;

public class RechargeMultiplayerMod : IRechargeMod
{
    public string Id => "recharge.multiplayer";
    public string DisplayName => "DOTnet";
    public Version Version => new Version(1, 7, 8);

    public void OnLoad(IRechargeHost host)
    {
        MpNetworkManager.Host = host;
        MpMenuBuilder.Install(host.PauseMenu);

        var hostPanelGo = new UnityEngine.GameObject("HostPanelController");
        UnityEngine.Object.DontDestroyOnLoad(hostPanelGo);
        var hostPanel = hostPanelGo.AddComponent<HostPanelController>();
        hostPanel.Init(host);

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

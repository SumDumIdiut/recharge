using System;
using Recharge.ModApi;

public class RechargeMultiplayerMod : IRechargeMod
{
    public string Id => "recharge.multiplayer";
    public string DisplayName => "DOTnet";
    public Version Version => new Version(1, 0, 0);

    public void OnLoad(IRechargeHost host)
    {
        MpNetworkManager.Host = host;
        MpMenuBuilder.Install(host.PauseMenu);

        // host.PauseMenu is a one-time snapshot from loader init - every later
        // scene load creates a fresh pauseMenuScript with an undecorated menu
        // (e.g. returning to the main menu after playing), so re-install
        // against whatever instance is actually live each time a scene loads.
        host.Events.On(RechargeEvents.SceneLoaded, _ =>
        {
            var menu = UnityEngine.Object.FindFirstObjectByType<pauseMenuScript>();
            if (menu != null) MpMenuBuilder.Install(menu);
        });
    }

    public void OnUnload() { }
}

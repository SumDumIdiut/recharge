using System;
using Recharge.ModApi;

public class RechargeMapsMod : IRechargeMod
{
    public string Id => "recharge.maps";
    public string DisplayName => "Maps";
    public Version Version => new Version(1, 0, 0);

    public void OnLoad(IRechargeHost host)
    {
        MapManager.GetOrCreate();
        MapMenuBuilder.Install(host.PauseMenu);

        host.Events.On(RechargeEvents.SceneLoaded, _ =>
        {
            var menu = UnityEngine.Object.FindFirstObjectByType<pauseMenuScript>();
            if (menu != null) MapMenuBuilder.Install(menu);
        });

        host.Events.On("recharge.maps.load_requested", payload =>
        {
            var mapId = payload as string;
            if (string.IsNullOrEmpty(mapId)) return;
            var menu = UnityEngine.Object.FindFirstObjectByType<pauseMenuScript>();
            if (menu != null) MapManager.Instance.PlayMap(mapId, menu);
        });
    }

    public void OnUnload() { }
}

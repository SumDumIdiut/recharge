using System;
using Recharge.ModApi;
using UnityEngine;

public class RechargePartyGamesMod : IRechargeMod
{
    public string Id => "recharge.partygames";
    public string DisplayName => "Party Games";
    public Version Version => new Version(1, 0, 0);

    public void OnLoad(IRechargeHost host)
    {
        var go = new GameObject("PartyGamesController");
        UnityEngine.Object.DontDestroyOnLoad(go);
        var controller = go.AddComponent<PartyGamesController>();
        controller.Init(host);

        host.Events.On(RechargeEvents.SceneLoaded, _ =>
        {
            var menu = UnityEngine.Object.FindFirstObjectByType<pauseMenuScript>();
            if (menu != null) controller.InstallMenuRow(menu);
        });
    }

    public void OnUnload() { }
}

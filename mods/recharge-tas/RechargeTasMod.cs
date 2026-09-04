using System;
using Recharge.ModApi;
using UnityEngine;

public class RechargeTasMod : IRechargeMod
{
    public string Id => "recharge.tas";
    public string DisplayName => "TAS Tool";
    public Version Version => new Version(1, 0, 0);

    public void OnLoad(IRechargeHost host)
    {
        var go = new GameObject("RechargeTasController");
        UnityEngine.Object.DontDestroyOnLoad(go);
        var controller = go.AddComponent<TasController>();
        controller.Host = host;

        host.Events.On(RechargeEvents.PlayerSpawned, payload =>
        {
            controller.BindPlayer(payload as GameObject);
        });
    }

    public void OnUnload()
    {
    }
}

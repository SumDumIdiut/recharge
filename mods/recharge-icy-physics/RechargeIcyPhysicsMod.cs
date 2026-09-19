using System;
using Recharge.ModApi;

public class RechargeIcyPhysicsMod : IRechargeMod
{
    public string Id => "recharge.icyphysics";
    public string DisplayName => "Icy Physics";
    public Version Version => new Version(1, 0, 0);

    public void OnLoad(IRechargeHost host)
    {
        var go = new UnityEngine.GameObject("IcyPhysicsController");
        UnityEngine.Object.DontDestroyOnLoad(go);
        go.AddComponent<IcyPhysicsController>();
    }

    public void OnUnload() { }
}

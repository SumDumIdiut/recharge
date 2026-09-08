using System;
using Recharge.ModApi;

public class RechargePauseBufferingMod : IRechargeMod
{
    public string Id => "recharge.pausebuffering";
    public string DisplayName => "Pause Buffering";
    public Version Version => new Version(1, 0, 0);

    public void OnLoad(IRechargeHost host)
    {
        var go = new UnityEngine.GameObject("PauseBufferController");
        UnityEngine.Object.DontDestroyOnLoad(go);
        go.AddComponent<PauseBufferController>();
    }

    public void OnUnload() { }
}

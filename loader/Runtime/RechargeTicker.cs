using System;
using UnityEngine;

/// <summary>
/// One shared MonoBehaviour backing IRechargeHost.OnUpdate/OnLateUpdate/OnFixedUpdate -
/// so a mod that just wants a per-frame callback doesn't need to create its
/// own GameObject solely to get one. DontDestroyOnLoad, created once by
/// RechargeLoaderBootstrap.Init.
/// </summary>
internal class RechargeTicker : MonoBehaviour
{
    public event Action Tick;
    public event Action LateTick;
    public event Action FixedTick;

    public static RechargeTicker Create()
    {
        var go = new GameObject("RechargeTicker");
        UnityEngine.Object.DontDestroyOnLoad(go);
        return go.AddComponent<RechargeTicker>();
    }

    private void Update() => InvokeSafely(Tick, "OnUpdate");
    private void LateUpdate() => InvokeSafely(LateTick, "OnLateUpdate");
    private void FixedUpdate() => InvokeSafely(FixedTick, "OnFixedUpdate");

    private static void InvokeSafely(Action ev, string label)
    {
        if (ev == null) return;
        // Each subscriber runs even if an earlier one throws - one mod's bug
        // in an OnUpdate handler shouldn't silently stop every other mod's
        // per-frame logic too.
        foreach (var handler in ev.GetInvocationList())
        {
            try { ((Action)handler)(); }
            catch (Exception e) { Debug.LogError("[Recharge] " + label + " handler threw: " + e); }
        }
    }
}

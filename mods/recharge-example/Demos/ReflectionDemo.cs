using System;
using UnityEngine;
using Recharge.ModApi;

// Every Reflect.* method at least once. GetField/TryGetField/SetField target
// real, already-proven-stable game fields (mainBit/settingsBit are what
// PauseMenuHelper itself reflects into; framesToReachTopSpeed is the exact
// field recharge-icy-physics ships tweaking for real). InvokeMethod/
// GetStaticField/NestedType instead target a private nested type declared
// right here, since those three specifically invite a typo that only fails
// at runtime - the mechanism they demonstrate is identical either way.
internal static class ReflectionDemo
{
    private class PrivateTarget
    {
        private static readonly int Answer = 42;
        private int _multiplier = 3;

        private class Nested
        {
            public string Tag = "nested-type";
        }

        private int Multiply(int by) => _multiplier * by;
    }

    public static void Run(IRechargeHost host)
    {
        var mainBit = Reflect.GetField<GameObject>(host.PauseMenu, "mainBit");
        host.Log($"GetField mainBit: {(mainBit != null ? mainBit.name : "null")}");

        var settingsBit = Reflect.TryGetField<GameObject>(host.PauseMenu, "settingsBit", fallback: null);
        host.Log($"TryGetField settingsBit: {(settingsBit != null ? settingsBit.name : "null")}");

        var madeUp = Reflect.TryGetField(host.PauseMenu, "thisFieldDoesNotExist", fallback: "fallback value");
        host.Log($"TryGetField on a made-up name returns the fallback instead of throwing: {madeUp}");

        var enabled = Reflect.GetProperty<bool>(host.PauseMenu, "isActiveAndEnabled");
        host.Log($"GetProperty isActiveAndEnabled: {enabled}");

        var answer = Reflect.GetStaticField<PrivateTarget, int>("Answer");
        host.Log($"GetStaticField Answer: {answer}");

        var nestedType = Reflect.NestedType<PrivateTarget>("Nested");
        var nestedInstance = Activator.CreateInstance(nestedType, nonPublic: true);
        var tag = Reflect.GetField<string>(nestedInstance, "Tag");
        host.Log($"NestedType + GetField round trip: {tag}");

        var privateTargetInstance = Activator.CreateInstance(typeof(PrivateTarget), nonPublic: true);
        var result = Reflect.InvokeMethod(privateTargetInstance, "Multiply", 7);
        host.Log($"InvokeMethod Multiply(7): {result}");

        Reflect.SetField(privateTargetInstance, "_multiplier", 10);
        var afterSet = Reflect.InvokeMethod(privateTargetInstance, "Multiply", 7);
        host.Log($"SetField _multiplier then Multiply(7) again: {afterSet}");
    }

    public static void ToggleIcyPhysics(IRechargeHost host, GameObject playerGo, bool icy)
    {
        var movement = playerGo != null ? playerGo.GetComponent<Movement>() : null;
        if (movement == null) { host.LogWarning("No player Movement to toggle icy physics on."); return; }
        Reflect.SetField(movement, "framesToReachTopSpeed", icy ? 50f : 2f);
        host.Log(icy ? "Icy physics ON (framesToReachTopSpeed = 50)." : "Icy physics off (framesToReachTopSpeed = 2, vanilla).");
    }
}

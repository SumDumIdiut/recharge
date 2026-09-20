using System;
using System.Collections;
using UnityEngine;
using Recharge.ModApi;

// host.OnUpdate/OnLateUpdate/OnFixedUpdate cover "every frame forever," but a
// one-off sequence of waits is still easiest as a real Unity coroutine - that
// needs a live MonoBehaviour to run on, which a mod doesn't otherwise have
// (IRechargeMod is a plain class, not a Component). CoroutineRunner below is
// the one-GameObject trick every mod that needs coroutines ends up writing.
internal class CoroutineRunner : MonoBehaviour
{
    private static CoroutineRunner _instance;

    public static CoroutineRunner Instance
    {
        get
        {
            if (_instance != null) return _instance;
            var go = new GameObject("ExampleModCoroutineRunner");
            UnityEngine.Object.DontDestroyOnLoad(go);
            _instance = go.AddComponent<CoroutineRunner>();
            return _instance;
        }
    }
}

internal static class CoroutineDemo
{
    public static void RunDelayedAction(IRechargeHost host, float delaySeconds, Action action)
    {
        CoroutineRunner.Instance.StartCoroutine(DelayedActionRoutine(host, delaySeconds, action));
    }

    private static IEnumerator DelayedActionRoutine(IRechargeHost host, float delaySeconds, Action action)
    {
        host.Log($"Coroutine started - waiting {delaySeconds}s.");
        yield return new WaitForSeconds(delaySeconds);
        host.Log("Coroutine woke up.");
        action();
    }

    public static void RunCountdown(IRechargeHost host, int fromSeconds, Action<int> onTick, Action onDone)
    {
        CoroutineRunner.Instance.StartCoroutine(CountdownRoutine(host, fromSeconds, onTick, onDone));
    }

    private static IEnumerator CountdownRoutine(IRechargeHost host, int fromSeconds, Action<int> onTick, Action onDone)
    {
        for (int remaining = fromSeconds; remaining > 0; remaining--)
        {
            onTick(remaining);
            yield return new WaitForSeconds(1f);
        }
        onDone();
    }

    // WaitUntil is the coroutine equivalent of a polling loop that only ever
    // checks one condition - handy for "block until the player exists"
    // without hand-rolling that check inside an OnUpdate handler.
    public static void RunWhenPlayerExists(IRechargeHost host, Action<GameObject> onFound)
    {
        CoroutineRunner.Instance.StartCoroutine(WaitForPlayerRoutine(host, onFound));
    }

    private static IEnumerator WaitForPlayerRoutine(IRechargeHost host, Action<GameObject> onFound)
    {
        GameObject player = null;
        yield return new WaitUntil(() =>
        {
            player = GameObject.FindGameObjectWithTag("Player");
            return player != null;
        });
        host.Log("WaitUntil coroutine: player found.");
        onFound(player);
    }
}

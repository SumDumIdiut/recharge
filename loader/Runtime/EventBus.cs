using System;
using System.Collections.Generic;
using Recharge.ModApi;
using UnityEngine;

/// <summary>Concrete <see cref="IEventBus"/> - one shared instance per session, owned by RechargeHost.</summary>
internal class EventBus : IEventBus
{
    private readonly Dictionary<string, List<Action<object>>> _handlers = new Dictionary<string, List<Action<object>>>();

    public void Emit(string eventName, object payload = null)
    {
        if (!_handlers.TryGetValue(eventName, out var list) || list.Count == 0) return;
        // Snapshot before invoking - a handler that subscribes/unsubscribes
        // (including to the event currently firing) must not corrupt this
        // dispatch's own iteration.
        var snapshot = list.ToArray();
        foreach (var handler in snapshot)
        {
            try { handler(payload); }
            catch (Exception e) { Debug.LogError("[Recharge] event handler for '" + eventName + "' threw: " + e); }
        }
    }

    public void On(string eventName, Action<object> handler)
    {
        if (!_handlers.TryGetValue(eventName, out var list))
        {
            list = new List<Action<object>>();
            _handlers[eventName] = list;
        }
        list.Add(handler);
    }

    public void Off(string eventName, Action<object> handler)
    {
        if (_handlers.TryGetValue(eventName, out var list)) list.Remove(handler);
    }
}

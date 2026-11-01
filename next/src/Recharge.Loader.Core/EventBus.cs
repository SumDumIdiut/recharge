using System;
using System.Collections.Generic;

namespace Recharge.Loader.Core
{
    public interface IEventBus
    {
        void Emit(string eventName, object? payload = null);
        void On(string eventName, Action<object?> handler);
        void Off(string eventName, Action<object?> handler);
    }

    public sealed class EventBus : IEventBus
    {
        private readonly Dictionary<string, List<Action<object?>>> _handlers =
            new Dictionary<string, List<Action<object?>>>(StringComparer.Ordinal);
        private readonly Action<string>? _log;

        public EventBus(Action<string>? log = null)
        {
            _log = log;
        }

        public void Emit(string eventName, object? payload = null)
        {
            if (string.IsNullOrEmpty(eventName)) return;
            if (!_handlers.TryGetValue(eventName, out var list) || list.Count == 0) return;

            var snapshot = list.ToArray();
            foreach (var handler in snapshot)
            {
                try { handler(payload); }
                catch (Exception e)
                {
                    string msg = "[Recharge] event handler for '" + eventName + "' threw: " + e;
                    if (_log != null) _log(msg); else Console.Error.WriteLine(msg);
                }
            }
        }

        public void On(string eventName, Action<object?> handler)
        {
            if (string.IsNullOrEmpty(eventName) || handler == null) return;
            if (!_handlers.TryGetValue(eventName, out var list))
            {
                list = new List<Action<object?>>();
                _handlers[eventName] = list;
            }
            list.Add(handler);
        }

        public void Off(string eventName, Action<object?> handler)
        {
            if (string.IsNullOrEmpty(eventName) || handler == null) return;
            if (_handlers.TryGetValue(eventName, out var list)) list.Remove(handler);
        }
    }
}
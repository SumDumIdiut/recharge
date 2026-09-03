using System;

namespace Recharge.ModApi
{
    /// <summary>
    /// A simple named pub/sub bus, shared by every mod via <see cref="IRechargeHost.Events"/> -
    /// the "custom event calls" mechanism mods use both to react to loader
    /// lifecycle events (see <see cref="RechargeEvents"/>) and to talk to
    /// each other without needing a compile-time reference to one another's
    /// assembly. One bus instance per game session, shared by every mod.
    /// </summary>
    public interface IEventBus
    {
        /// <summary>
        /// Fires <paramref name="eventName"/> immediately (synchronously, on
        /// the calling thread/frame) to every currently-subscribed handler,
        /// in subscription order. A handler that throws is caught and logged
        /// (via the same host that owns this bus) - it does not stop the
        /// remaining handlers from running.
        /// </summary>
        void Emit(string eventName, object payload = null);

        /// <summary>Subscribes <paramref name="handler"/> to <paramref name="eventName"/>. The same delegate can be added more than once - it fires once per subscription.</summary>
        void On(string eventName, Action<object> handler);

        /// <summary>Removes a previously-added subscription. No-op if it isn't currently subscribed.</summary>
        void Off(string eventName, Action<object> handler);
    }
}

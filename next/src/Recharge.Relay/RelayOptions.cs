using System;

namespace Recharge.Relay
{
    /// <summary>Configuration for <see cref="RelayServer"/>. Defaults mirror server.js.</summary>
    public sealed class RelayOptions
    {
        public int Port { get; set; } = 7777;
        public int MaxConnections { get; set; } = 500;
        public int MaxConnectionsPerIp { get; set; } = 20;
        public int MaxPayloadBytes { get; set; } = 8 * 1024;
        public int MaxMsgsPerSec { get; set; } = 120;

        private TimeSpan _keepAliveInterval = TimeSpan.FromSeconds(8);
        private TimeSpan _keepAliveTimeout = TimeSpan.FromSeconds(24);

        public TimeSpan KeepAliveInterval
        {
            get => _keepAliveInterval;
            set => _keepAliveInterval = value < TimeSpan.Zero ? TimeSpan.Zero : value;
        }
        public TimeSpan KeepAliveTimeout
        {
            get => _keepAliveTimeout;
            set => _keepAliveTimeout = value < TimeSpan.Zero ? TimeSpan.Zero : value;
        }

        // Convenience aliases (interval).
        public TimeSpan HeartbeatInterval { get => KeepAliveInterval; set => KeepAliveInterval = value; }
        public TimeSpan HeartbeatTimeout { get => KeepAliveTimeout; set => KeepAliveTimeout = value; }

        public int HeartbeatMs { get => (int)KeepAliveInterval.TotalMilliseconds; set => KeepAliveInterval = TimeSpan.FromMilliseconds(value); }
        public int KeepAliveIntervalMs { get => (int)KeepAliveInterval.TotalMilliseconds; set => KeepAliveInterval = TimeSpan.FromMilliseconds(value); }
        public int HeartbeatIntervalMs { get => (int)KeepAliveInterval.TotalMilliseconds; set => KeepAliveInterval = TimeSpan.FromMilliseconds(value); }

        public int HeartbeatTimeoutMs { get => (int)KeepAliveTimeout.TotalMilliseconds; set => KeepAliveTimeout = TimeSpan.FromMilliseconds(value); }
        public int KeepAliveTimeoutMs { get => (int)KeepAliveTimeout.TotalMilliseconds; set => KeepAliveTimeout = TimeSpan.FromMilliseconds(value); }

        public int MaxMissedHeartbeats { get; set; } = 3;
        public int MaxLobbies { get; set; } = 500;
        public int MaxLobbyMembers { get; set; } = 16;
        public int MaxChatHistory { get; set; } = 50;
        public int BroadcastHz { get; set; } = 60;
        public int StaleMs { get; set; } = 5000;
    }
}
using System;

namespace Recharge.Server
{
    public sealed class SocialOptions
    {
        /// <summary>0 picks a free port (tests).</summary>
        public int Port { get; set; } = 8090;
        /// <summary>The address to listen on: "*" for every interface, or e.g. "127.0.0.1".</summary>
        public string Host { get; set; } = "*";
        public string DataDir { get; set; } = "data";

        public int MaxMessageChars { get; set; } = 2000;
        public int MessagesPerMinute { get; set; } = 20;
        public int FriendRequestsPerHour { get; set; } = 20;
        public int SharesPerHour { get; set; } = 30;
        public int ApiPerMinute { get; set; } = 240;
        public int MaxFriends { get; set; } = 500;
        public int MaxPendingRequests { get; set; } = 100;
        public int MaxSharesPerUser { get; set; } = 200;
        public int MaxConnectionsPerUser { get; set; } = 5;
        public int WsMessagesPerSecond { get; set; } = 10;
        public int ProfileWritesPerHour { get; set; } = 60;
        public int MaxGroupMembers { get; set; } = 20;
        public int MaxBodyBytes { get; set; } = 64 * 1024;

        public TimeSpan AuthCache { get; set; } = TimeSpan.FromSeconds(60);
        public TimeSpan DownloadLinkLifetime { get; set; } = TimeSpan.FromMinutes(5);
        public TimeSpan MaxLinkLifetime { get; set; } = TimeSpan.FromDays(30);

        public Func<DateTimeOffset> Clock { get; set; } = () => DateTimeOffset.UtcNow;
    }
}

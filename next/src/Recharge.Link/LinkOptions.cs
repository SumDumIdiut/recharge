using System;

namespace Recharge.Link;

/// <summary>Timing and size limits for both ends. The defaults are the protocol's; tests shorten them.</summary>
public sealed class LinkOptions
{
    /// <summary>The largest frame (payload bytes) either end accepts; a bigger one closes the connection.</summary>
    public int MaxFrameBytes { get; set; } = 1024 * 1024;

    /// <summary>How long the server waits for the client's hello.</summary>
    public TimeSpan HelloTimeout { get; set; } = TimeSpan.FromSeconds(3);

    /// <summary>How often each end sends a ping.</summary>
    public TimeSpan PingInterval { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>With nothing received for this long, the connection is dead.</summary>
    public TimeSpan PingTimeout { get; set; } = TimeSpan.FromSeconds(15);

    /// <summary>How often the client retries while the server is unreachable.</summary>
    public TimeSpan ReconnectInterval { get; set; } = TimeSpan.FromSeconds(2);
}

/// <summary>The game's answer to an intent. A missing or timed-out answer is reported as a failed ack.</summary>
public sealed class IntentAck
{
    public string Id { get; }
    public bool Ok { get; }
    public string? Error { get; }

    public IntentAck(string id, bool ok, string? error)
    {
        Id = id;
        Ok = ok;
        Error = error;
    }
}

/// <summary>The value of a state change.</summary>
public sealed class StateChange
{
    public string Key { get; }
    public Recharge.Core.Json.JsonNode Value { get; }

    public StateChange(string key, Recharge.Core.Json.JsonNode value)
    {
        Key = key;
        Value = value;
    }
}

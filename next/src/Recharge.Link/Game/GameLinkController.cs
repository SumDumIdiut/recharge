using System;
using System.Threading.Tasks;
using Recharge.Core.Json;

namespace Recharge.Link.Game;

/// <summary>What the game does for the app's intents. The Net module implements it on the Unity main thread.</summary>
public interface IGameLinkHost
{
    /// <summary>Connects to the relay (host/port, or the default when null) and joins the lobby. Throws with a readable message when it cannot.</summary>
    Task JoinLobbyAsync(int lobbyId, RelayAddress? relay);

    /// <summary>Asks the map runtime to load the map folder (raises recharge.maps.load_requested).</summary>
    void PlayMap(string folder);

    /// <summary>Connects to the relay (or the default when null) and opens a lobby. Throws with a readable message when it cannot.</summary>
    Task HostLobbyAsync(HostRequest request, RelayAddress? relay);
}

/// <summary>What lobby.host asks for: a lobby name, an optional installed map folder (loaded for the host) and its hub id and name, and Hard.</summary>
public sealed class HostRequest
{
    public const int MaxName = 40;
    public string Name { get; }
    public string? MapFolder { get; }
    public string? MapHubId { get; }
    public string? MapName { get; }
    public bool Hard { get; }

    public HostRequest(string name, string? mapFolder, string? mapHubId, string? mapName, bool hard)
    {
        Name = name; MapFolder = mapFolder; MapHubId = mapHubId; MapName = mapName; Hard = hard;
    }
}

/// <summary>A relay endpoint from an intent: "host" or "host:port".</summary>
public sealed class RelayAddress
{
    public string Host { get; }
    public int Port { get; }

    public RelayAddress(string host, int port)
    {
        Host = host;
        Port = port;
    }

    /// <summary>Null for empty or invalid text (the default relay is then used).</summary>
    public static RelayAddress? Parse(string? text, int defaultPort = 443)
    {
        if (text == null) return null;
        text = text.Trim();
        if (text.Length == 0) return null;
        int i = text.LastIndexOf(':');
        if (i < 0) return new RelayAddress(text, defaultPort);
        if (i == 0 || i == text.Length - 1) return null;
        if (!int.TryParse(text.Substring(i + 1), out var port) || port < 1 || port > 65535) return null;
        return new RelayAddress(text.Substring(0, i), port);
    }
}

/// <summary>The game's side of the app channel: runs the intents (<c>lobby.join</c>, <c>lobby.host</c>, <c>play.map</c>) and reports the state keys <c>running</c>, <c>lobby</c> and <c>map</c>.</summary>
public sealed class GameLinkController
{
    public const string JoinIntent = "lobby.join";
    public const string PlayIntent = "play.map";
    public const string HostIntent = "lobby.host";

    private readonly LinkClient _client;
    private readonly IGameLinkHost _host;

    public GameLinkController(LinkClient client, IGameLinkHost host)
    {
        _client = client ?? throw new ArgumentNullException(nameof(client));
        _host = host ?? throw new ArgumentNullException(nameof(host));
        _client.OnIntent(JoinIntent, (Func<JsonNode, Task>)OnJoin);
        _client.OnIntent(PlayIntent, (Action<JsonNode>)OnPlay);
        _client.OnIntent(HostIntent, (Func<JsonNode, Task>)OnHost);
    }

    private Task OnJoin(JsonNode args)
    {
        var o = args as JsonObject ?? throw new ArgumentException("lobby.join needs {lobbyId}");
        if (!o.TryGetValue("lobbyId", out var id) || !(id is JsonNumber n))
            throw new ArgumentException("lobby.join needs a positive lobbyId");
        double lobby = n.AsDouble();
        if (lobby < 1 || lobby != Math.Floor(lobby) || lobby > int.MaxValue)
            throw new ArgumentException("lobby.join needs a positive lobbyId");
        RelayAddress? relay = null;
        if (o.TryGetValue("relay", out var r) && r is JsonString rs && rs.Value.Length > 0)
        {
            relay = RelayAddress.Parse(rs.Value) ?? throw new ArgumentException("lobby.join: bad relay address");
        }
        return _host.JoinLobbyAsync((int)lobby, relay);
    }

    private Task OnHost(JsonNode args)
    {
        var o = args as JsonObject ?? throw new ArgumentException("lobby.host needs {name}");
        string name = Text(o, "name")?.Trim() ?? "";
        if (name.Length == 0 || name.Length > HostRequest.MaxName) throw new ArgumentException("lobby.host needs a name of 1 to " + HostRequest.MaxName + " characters");
        string? folder = Text(o, "map");
        if (folder != null && folder.Length == 0) folder = null;
        if (folder != null && !IsSafeFolder(folder)) throw new ArgumentException("lobby.host: map must be a plain map folder name");
        string? hubId = Text(o, "mapHubId");
        if (hubId != null && (hubId.Length == 0 || hubId.Length > 80)) hubId = null;
        string? mapName = Text(o, "mapName");
        if (mapName != null && (mapName.Length == 0 || mapName.Length > 80)) mapName = null;
        bool hard = o.TryGetValue("hard", out var h) && h is JsonBool hb && hb.Value;
        RelayAddress? relay = null;
        if (o.TryGetValue("relay", out var r) && r is JsonString rs && rs.Value.Length > 0)
        {
            relay = RelayAddress.Parse(rs.Value) ?? throw new ArgumentException("lobby.host: bad relay address");
        }
        return _host.HostLobbyAsync(new HostRequest(name, folder, hubId, mapName ?? folder, hard), relay);
    }

    private static string? Text(JsonObject o, string key) => o.TryGetValue(key, out var v) && v is JsonString s ? s.Value : null;

    private void OnPlay(JsonNode args)
    {
        var o = args as JsonObject ?? throw new ArgumentException("play.map needs {folder}");
        if (!o.TryGetValue("folder", out var f) || !(f is JsonString fs) || !IsSafeFolder(fs.Value))
            throw new ArgumentException("play.map needs a plain map folder name");
        _host.PlayMap(fs.Value);
    }

    /// <summary>A map folder name only: no separators, no dots-up, not empty.</summary>
    public static bool IsSafeFolder(string? folder)
    {
        if (string.IsNullOrWhiteSpace(folder)) return false;
        if (folder!.IndexOf('/') >= 0 || folder.IndexOf('\\') >= 0 || folder.IndexOf('\0') >= 0) return false;
        return folder != "." && folder != "..";
    }

    public Task ReportRunningAsync(bool running) => _client.SetStateAsync("running", running ? JsonBool.True : JsonBool.False);

    /// <summary>The current lobby, or null when in none.</summary>
    public Task ReportLobbyAsync(int lobbyId, string? name, bool isHost)
    {
        if (lobbyId == 0) return _client.SetStateAsync("lobby", JsonNull.Instance);
        var o = new JsonObject();
        o["id"] = JsonNumber.From(lobbyId);
        o["name"] = new JsonString(name ?? "");
        o["host"] = isHost ? JsonBool.True : JsonBool.False;
        return _client.SetStateAsync("lobby", o);
    }

    /// <summary>The map folder being played, or null for the base game.</summary>
    public Task ReportMapAsync(string? folder) =>
        _client.SetStateAsync("map", folder == null ? (JsonNode)JsonNull.Instance : new JsonString(folder));
}

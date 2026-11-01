using System;
using System.IO;
using System.Threading.Tasks;
using Recharge.Link;
using Recharge.Link.Game;
using Recharge.ModApi;
using Recharge.Net;
using UnityEngine;

namespace Recharge.Module.Net;

/// <summary>The game's end of the app link: runs lobby.join, lobby.host and play.map, and reports running, lobby and map.</summary>
internal sealed class NetLink : IGameLinkHost
{
    public const string LoadRequestedEvent = "recharge.maps.load_requested";

    private readonly IRechargeHost _host;
    private readonly MpNetworkManager _mgr;
    private readonly LinkClient _client;
    private readonly GameLinkController _controller;

    private NetLink(IRechargeHost host, MpNetworkManager mgr, LinkClient client)
    {
        _host = host;
        _mgr = mgr;
        _client = client;
        _controller = new GameLinkController(client, this);
    }

    /// <summary>Null when the game wasn't launched by the app (no RECHARGE_LINK and no link file).</summary>
    public static NetLink TryStart(IRechargeHost host, MpNetworkManager mgr)
    {
        // The loader owns the one game connection and shares it; without it (a standalone run) connect our own.
        LinkClient client = RechargeNetModule.SharedLink ?? LinkClient.FromEnvironment();
        if (client == null)
        {
            var gameDir = Path.GetDirectoryName(Application.dataPath) ?? ".";
            client = LinkLaunchFile.Consume(gameDir);
        }
        if (client == null) return null;

        var link = new NetLink(host, mgr, client);
        link.Wire();
        return link;
    }

    private void Wire()
    {
        _ = _controller.ReportRunningAsync(true);
        _ = _controller.ReportLobbyAsync(0, null, false);
        _ = _controller.ReportMapAsync(null);

        _mgr.LobbyChanged += (id, name, isHost) => _ = _controller.ReportLobbyAsync(id, name, isHost);
        _host.Events.On(LoadRequestedEvent, payload =>
        {
            if (payload is string folder && GameLinkController.IsSafeFolder(folder)) _ = _controller.ReportMapAsync(folder);
        });
        // The Navigator raises these for every way a map can load, not only load_requested.
        _host.Events.On("recharge.maps.loaded", payload =>
        {
            if (payload is string folder && GameLinkController.IsSafeFolder(folder)) _ = _controller.ReportMapAsync(folder);
        });
        _host.Events.On("recharge.maps.unloaded", payload => _ = _controller.ReportMapAsync(null));
        Application.quitting += () =>
        {
            try { _controller.ReportRunningAsync(false).Wait(500); } catch (Exception) { }
            _client.Dispose();
        };
        _ = _client.ConnectAsync();
    }

    public async Task JoinLobbyAsync(int lobbyId, RelayAddress relay)
    {
        string h = relay != null ? relay.Host : NetUri.DefaultHost;
        int p = relay != null ? relay.Port : NetUri.DefaultPort;
        await _mgr.JoinFromLinkAsync(lobbyId, h, p).ConfigureAwait(false);
    }

    public async Task HostLobbyAsync(HostRequest request, RelayAddress relay)
    {
        string h = relay != null ? relay.Host : NetUri.DefaultHost;
        int p = relay != null ? relay.Port : NetUri.DefaultPort;
        await _mgr.HostFromLinkAsync(request.Name, request.MapFolder, request.MapHubId, request.MapName, request.Hard, h, p).ConfigureAwait(false);
    }

    public void PlayMap(string folder)
    {
        _mgr.RunOnMain(() => _host.Events.Emit(LoadRequestedEvent, folder));
    }
}

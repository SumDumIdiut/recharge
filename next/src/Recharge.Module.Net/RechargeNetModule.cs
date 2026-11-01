using System;
using Recharge.Loader.Core;
using Recharge.ModApi;

namespace Recharge.Module.Net;

/// <summary>
/// The Net (DOTnet) module built into RechargeLoader 2. Its id replaces the old hub mod "recharge.multiplayer", so a mod folder of
/// that name is skipped by the handover rule. The protocol is Recharge.Net's NetClient; the app link is Recharge.Link's LinkClient.
/// </summary>
public sealed class RechargeNetModule : IBuiltinModule, IRechargeMod
{
    public const string ModuleId = "recharge.multiplayer";

    /// <summary>The loader's own link client (the app admits one game connection). When null the module connects from RECHARGE_LINK or the link file itself.</summary>
    public static Recharge.Link.LinkClient SharedLink { get; set; }

    private NetLink _link;

    public string Id => ModuleId;
    public string Name => "DOTnet";
    public string DisplayName => Name;
    public string ReplacesModId => ModuleId;
    public string LegacyModId => ModuleId;
    public Version Version => new Version(2, 0, 0);

    public bool Handles(string modId) => string.Equals(modId, ModuleId, StringComparison.OrdinalIgnoreCase);

    public void OnLoad(IRechargeHost host)
    {
        MpNetworkManager.Host = host;
        MpGhostSpace.Install(host.Events);
        MpMenuBuilder.Install(host.PauseMenu);

        var hostPanelGo = new UnityEngine.GameObject("HostPanelController");
        UnityEngine.Object.DontDestroyOnLoad(hostPanelGo);
        var hostPanel = hostPanelGo.AddComponent<HostPanelController>();
        hostPanel.Init(host);

        PauseMenuHelper.OnMenuReady(host, menu =>
        {
            MpMenuBuilder.Install(menu);
            hostPanel.InstallMenuRow(menu);
        });

        try { _link = NetLink.TryStart(host, MpNetworkManager.GetOrCreate()); }
        catch (Exception e) { host.LogWarning("app link unavailable: " + e.Message); }
    }

    public void OnUnload() { }
}

using System;
using System.IO;
using System.Linq;
using Recharge.Loader.Core;
using Recharge.Loader.Core.Maps;
using Recharge.ModApi;
using UnityEngine;

namespace Recharge.Module.Maps;

/// <summary>
/// The Maps (Navigator) module built into RechargeLoader 2. Its id replaces the old hub mod "recharge.maps",
/// so a mod folder of that name is skipped by the handover rule. The loader constructs it and calls
/// <see cref="OnLoad"/> with the host once the pause menu exists.
/// </summary>
public sealed class RechargeMapsModule : IBuiltinModule, IRechargeMod
{
    public string Id => MapRules.ModuleId;
    public string Name => "Navigator";
    public string DisplayName => Name;
    public string ReplacesModId => MapRules.ModuleId;
    public string LegacyModId => MapRules.ModuleId;
    public Version Version => new Version(2, 0, 0);

    public bool Handles(string modId) => string.Equals(modId, MapRules.ModuleId, StringComparison.OrdinalIgnoreCase);

    public static string ResolveSavePath(string path) => SaveSlots.NativePath(path);
    public static string ResolveSavePreference(string key) => SaveSlots.PreferenceKey(key);
    public static void NativeSaveComplete() => SaveSlots.NativeSaveComplete();

    public void OnLoad(IRechargeHost host)
    {
        MapEvents.Host = host;
        MapSaves.Recover();
        SaveSlots.Initialize();
        MapManager.GetOrCreate();
        MapMenuBuilder.Install(host.PauseMenu);
        RechargeSettingsPanel.Install(host.PauseMenu);

        // host.PauseMenu is a one-time snapshot; every later scene load creates a new pauseMenuScript,
        // so re-install against whatever instance is live each time a scene loads.
        PauseMenuHelper.OnMenuReady(host, MapMenuBuilder.Install);
        PauseMenuHelper.OnMenuReady(host, RechargeSettingsPanel.Install);

        host.Events.On(MapRules.LoadRequestedEvent, payload =>
        {
            var mapId = payload as string;
            if (string.IsNullOrEmpty(mapId)) return;
            var menu = PauseMenuHelper.FindMenu();
            if (menu == null || DoorTransition.Busy) return;
            var id = SaveSlots.MapId(mapId);
            // App requests previously resumed the map's single save. Resume
            // the most recently used matching slot after that save migrates.
            var entry = SaveSlots.Library?.Scan().Where(e => e.Metadata?.Matches(SaveLibrary.Custom, id) == true)
                .OrderByDescending(e => e.Metadata.Saved ?? e.Metadata.Created).FirstOrDefault();
            MapManager.Instance.PlayMap(mapId, menu, false, entry == null ? null : SaveSlots.Prepare(entry, mapId));
        });

        PlayRequestedTestMap();
    }

    // The map maker's "Test in game" writes the map, then autoplay.txt naming it, then launches the game.
    private static void PlayRequestedTestMap()
    {
        var request = MapPaths.AutoplayFile;
        if (!File.Exists(request)) return;
        string mapId;
        try
        {
            mapId = File.ReadAllText(request).Trim();
            File.Delete(request);
        }
        catch (Exception e)
        {
            Debug.LogWarning("[RechargeMaps] couldn't read the map maker's test request: " + e.Message);
            return;
        }
        if (mapId.Length == 0) return;

        var menu = PauseMenuHelper.FindMenu();
        // Always start the game first and load the map once gameplay's Player exists.
        if (menu != null)
        {
            var session = SaveSlots.HasHooks ? SaveSlots.PrepareTest(mapId, MapDefinition.Read(mapId)?.Player != null) : null;
            MapManager.Instance.PlayMap(mapId, menu, true, session);
        }
        else Debug.LogWarning("[RechargeMaps] no menu to start test map '" + mapId + "' from");
    }

    public void OnUnload() { }
}

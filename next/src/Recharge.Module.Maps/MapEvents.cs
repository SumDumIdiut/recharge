using System;
using System.Collections.Generic;
using Recharge.Loader.Core.Maps;
using Recharge.ModApi;
using UnityEngine;

namespace Recharge.Module.Maps;

// What the Navigator tells other modules (the Net module places ghosts with it): the active map's coordinate space,
// the zones that are loaded, and when a map loads or unloads.
internal static class MapEvents
{
    public static IRechargeHost Host;

    private static void Emit(string name, object payload)
    {
        try { Host?.Events.Emit(name, payload); }
        catch (Exception e) { Debug.LogWarning("[RechargeMaps] event " + name + " failed: " + e.Message); }
    }

    public static void Loaded(MapWorld w)
    {
        // Overlay maps are the real level (Origin 0, shift 0); custom maps sit at the pocket origin with the map's shift.
        Emit(MapRules.SpaceEvent, new double[] { w.Origin.x, w.Origin.y, w.Shift.x, w.Shift.y });
        Zones(w);
        Emit(MapRules.LoadedEvent, w.MapId);
    }

    public static void Unloaded()
    {
        Emit(MapRules.ZonesEvent, null);
        Emit(MapRules.SpaceEvent, null);
        Emit(MapRules.UnloadedEvent, null);
    }

    // Overlay maps share the game's own zones: only the active ones are loaded, so a ghost elsewhere must be hidden.
    // A custom map is one island with no zones to tell apart, so nothing is culled there.
    public static void Zones(MapWorld w)
    {
        if (w == null || !w.Overlay) { Emit(MapRules.ZonesEvent, null); return; }
        var loader = Singleton<ZoneLoader>.Instance;
        var all = loader != null ? Recharge.ModApi.Reflect.GetField<GameObject[]>(loader, "allZones") : null;
        if (all == null) { Emit(MapRules.ZonesEvent, null); return; }
        var rects = new List<double>();
        foreach (var zone in all)
        {
            if (zone == null || !zone.activeInHierarchy) continue;
            bool any = false;
            Bounds b = default;
            foreach (var r in zone.GetComponentsInChildren<Renderer>(false))
            {
                if (!r.enabled) continue;
                if (!any) { b = r.bounds; any = true; }
                else b.Encapsulate(r.bounds);
            }
            if (!any) continue;
            // Live -> world (level) -> editor (world - shift).
            var min = MapWorld.LevelOf(b.min) - w.Shift;
            var max = MapWorld.LevelOf(b.max) - w.Shift;
            rects.Add(min.x); rects.Add(min.y); rects.Add(max.x); rects.Add(max.y);
        }
        Emit(MapRules.ZonesEvent, rects.Count == 0 ? null : rects.ToArray());
    }
}

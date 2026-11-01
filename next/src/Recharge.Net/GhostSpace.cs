using System;
using System.Collections.Generic;

namespace Recharge.Net
{
    /// <summary>An axis-aligned rectangle in editor coordinates (a loaded zone).</summary>
    public readonly struct ZoneRect
    {
        public double MinX { get; }
        public double MinY { get; }
        public double MaxX { get; }
        public double MaxY { get; }

        public ZoneRect(double minX, double minY, double maxX, double maxY)
        {
            MinX = Math.Min(minX, maxX);
            MinY = Math.Min(minY, maxY);
            MaxX = Math.Max(minX, maxX);
            MaxY = Math.Max(minY, maxY);
        }

        public bool Contains(double x, double y) => x >= MinX && x <= MaxX && y >= MinY && y <= MaxY;
    }

    /// <summary>
    /// The receiver's own map space for ghosts (vault "Multiplayer" section 4, "Navigator Runtime" section 2). Positions on the wire stay
    /// world coordinates exactly as the v1 client sends them, so old and new clients mix freely; nothing here changes where a ghost is
    /// placed. The receiver only uses its own map's <c>_shift</c> to decide whether a ghost stands in a zone that is loaded (zones are in
    /// editor coordinates: editor = world - _shift) and hides it when not. With no zones declared nothing is ever hidden.
    /// </summary>
    public sealed class GhostSpace
    {
        /// <summary>Event: the active map changed. Payload: <c>double[4]</c> {originX, originY, shiftX, shiftY}, or null when no map is active.</summary>
        public const string SpaceEvent = "recharge.maps.space";

        /// <summary>Event: the loaded zones changed. Payload: <c>double[]</c> of {minX, minY, maxX, maxY} per zone in editor coordinates; null or empty means "unknown, show every ghost".</summary>
        public const string ZonesEvent = "recharge.maps.zones";

        public static readonly GhostSpace None = new GhostSpace(0, 0, 0, 0, null);

        public double OriginX { get; }
        public double OriginY { get; }
        public double ShiftX { get; }
        public double ShiftY { get; }
        public IReadOnlyList<ZoneRect> Zones { get; }

        public GhostSpace(double originX, double originY, double shiftX, double shiftY, IReadOnlyList<ZoneRect>? zones)
        {
            OriginX = originX;
            OriginY = originY;
            ShiftX = shiftX;
            ShiftY = shiftY;
            Zones = zones ?? new ZoneRect[0];
        }

        public GhostSpace WithZones(IReadOnlyList<ZoneRect>? zones) => new GhostSpace(OriginX, OriginY, ShiftX, ShiftY, zones);

        /// <summary>World position to editor coordinates (what zones are measured in): editor = world - _shift.</summary>
        public void ToEditor(double worldX, double worldY, out double editorX, out double editorY)
        {
            editorX = worldX - ShiftX;
            editorY = worldY - ShiftY;
        }

        /// <summary>False when a ghost at this world position is in a zone that is not loaded here (so it must be hidden).</summary>
        public bool IsLoaded(double worldX, double worldY)
        {
            if (Zones.Count == 0) return true;
            ToEditor(worldX, worldY, out var ex, out var ey);
            foreach (var z in Zones)
                if (z.Contains(ex, ey)) return true;
            return false;
        }

        /// <summary>Reads the <see cref="SpaceEvent"/> payload; <see cref="None"/> for null or anything malformed.</summary>
        public static GhostSpace FromSpacePayload(object? payload)
        {
            if (payload is double[] a && a.Length >= 4 && Finite(a[0]) && Finite(a[1]) && Finite(a[2]) && Finite(a[3]))
                return new GhostSpace(a[0], a[1], a[2], a[3], null);
            return None;
        }

        /// <summary>Reads the <see cref="ZonesEvent"/> payload; an empty list (show everything) for null or anything malformed.</summary>
        public static IReadOnlyList<ZoneRect> ParseZones(object? payload)
        {
            var list = new List<ZoneRect>();
            if (payload is double[] a)
            {
                for (int i = 0; i + 3 < a.Length; i += 4)
                {
                    if (Finite(a[i]) && Finite(a[i + 1]) && Finite(a[i + 2]) && Finite(a[i + 3]))
                        list.Add(new ZoneRect(a[i], a[i + 1], a[i + 2], a[i + 3]));
                }
            }
            return list;
        }

        private static bool Finite(double d) => !double.IsNaN(d) && !double.IsInfinity(d);
    }
}

using System.IO;
using UnityEngine;

internal static class MapPaths
{
    public static string ModsRoot => Path.Combine(Path.GetDirectoryName(Application.dataPath) ?? ".", "Recharge", "Mods");
    public static string MapsDir => Path.Combine(ModsRoot, "recharge.maps", "maps");
    public static string TexturesDir => Path.Combine(ModsRoot, "recharge.maps", "textures");
    public static string SnapshotsDir => Path.Combine(ModsRoot, "recharge.maps", "course-snapshots");
}

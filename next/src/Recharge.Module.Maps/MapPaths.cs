using System.IO;
using Recharge.Loader.Core.Maps;
using UnityEngine;

namespace Recharge.Module.Maps;

// The path rules live in Recharge.Loader.Core.Maps.MapRules; this only supplies the game folder.
internal static class MapPaths
{
    private static string GameDir => Path.GetDirectoryName(Application.dataPath) ?? ".";
    public static string ModsRoot => MapRules.ModsRoot(GameDir);
    public static string MapsDir => MapRules.MapsDir(GameDir);
    public static string TexturesDir => MapRules.TexturesDir(GameDir);
    public static string AutoplayFile => MapRules.AutoplayFile(GameDir);
}

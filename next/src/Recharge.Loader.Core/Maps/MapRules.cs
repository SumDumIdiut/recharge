#nullable disable
using System.IO;
using System.Linq;

namespace Recharge.Loader.Core.Maps
{
    /// <summary>Unity-free path and naming rules of the Maps (Navigator) module. Same layout the old recharge.maps mod used, so existing maps and saves keep working.</summary>
    public static class MapRules
    {
        /// <summary>The module id; it replaces the old hub mod of the same name, so the old folder is skipped by the handover rule.</summary>
        public const string ModuleId = "recharge.maps";

        /// <summary>Event other modules emit to start a map (payload: map id string).</summary>
        public const string LoadRequestedEvent = "recharge.maps.load_requested";

        /// <summary>Raised after a map finishes loading, by whatever path started it. Payload: the map id (string).</summary>
        public const string LoadedEvent = "recharge.maps.loaded";

        /// <summary>Raised when the active map is unloaded or replaced (no payload).</summary>
        public const string UnloadedEvent = "recharge.maps.unloaded";

        /// <summary>Raised when the active map's coordinate space changes. Payload: double[4] {originX, originY, shiftX, shiftY}, or null when no map is active.</summary>
        public const string SpaceEvent = "recharge.maps.space";

        /// <summary>Raised when the loaded zones change. Payload: double[] of {minX, minY, maxX, maxY} per zone in editor coordinates; null means unknown.</summary>
        public const string ZonesEvent = "recharge.maps.zones";

        /// <summary>&lt;GameDir&gt;/Recharge/Mods</summary>
        public static string ModsRoot(string gameDir) => Path.Combine(gameDir ?? ".", "Recharge", "Mods");

        public static string MapsDir(string gameDir) => Path.Combine(ModsRoot(gameDir), ModuleId, "maps");

        public static string TexturesDir(string gameDir) => Path.Combine(ModsRoot(gameDir), ModuleId, "textures");

        /// <summary>The file the map maker's "Test in game" writes to name the map to start on launch.</summary>
        public static string AutoplayFile(string gameDir) => Path.Combine(ModsRoot(gameDir), ModuleId, "autoplay.txt");

        /// <summary>Each map keeps its own save under this folder (relative to the persistent data path).</summary>
        public const string SaveMapsRoot = "/SavedataMaps/";

        /// <summary>The save folder for a map id, with path-hostile characters replaced by '_'.</summary>
        public static string SaveFolderFor(string mapId) => SaveMapsRoot + SafeName(mapId);

        public static string SafeName(string mapId)
        {
            var bad = Path.GetInvalidFileNameChars();
            return new string(mapId.Select(c => bad.Contains(c) || c == '/' || c == '\\' ? '_' : c).ToArray());
        }

        /// <summary>FNV-1a over the UTF-16 chars of the key.</summary>
        public static uint Fnv1a(string key)
        {
            unchecked
            {
                uint hash = 2166136261;
                foreach (var c in key) { hash ^= c; hash *= 16777619; }
                return hash;
            }
        }

        /// <summary>The save's course number for a map's course: stable across plays, far above the game's own.</summary>
        public static int StableCourseNumber(string key) => 900000 + (int)(Fnv1a(key) % 100000);

        /// <summary>Whether a group's main spawn is in the Q/E cycle: an explicit spawnX, or anything except an overlay that keeps the game's own spawn.</summary>
        public static bool IncludesMainSpawn(bool hasSpawnX, bool overlay, bool keepSpawn) => hasSpawnX || !overlay || !keepSpawn;
    }
}

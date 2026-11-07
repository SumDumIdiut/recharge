using System;
using System.IO;
using Recharge.App.Create;
using Recharge.App.Library;
using Recharge.Core.Json;

namespace Recharge.App.Amp
{
    /// <summary>
    /// Reads and writes the maps the Amplifier edits: a folder under the game's Mods/recharge.maps/maps with a
    /// map.json in the format the game's map loader reads (MapDefinition.cs). The editor builds the JSON; this
    /// checks it is a map file, picks the folder and writes it safely (temp file, then replace).
    /// </summary>
    public static class AmpService
    {
        public const string MapFile = "map.json";
        public const int MaxBytes = 64 * 1024 * 1024;

        public static string MapsDir(string game) => CreateService.MapsDir(game);

        /// <summary>The map.json text of a map folder.</summary>
        public static string Load(string game, string id)
        {
            string dir = CreateService.Child(MapsDir(game), id);
            string file = Path.Combine(dir, MapFile);
            if (!File.Exists(file)) throw new FileNotFoundException("that map has no " + MapFile);
            return File.ReadAllText(file);
        }

        /// <summary>
        /// Writes the map. With an id the existing folder's map.json is replaced (its other files stay); without one a new
        /// folder is made from the name. Returns the folder name.
        /// </summary>
        public static string Save(string game, string? id, string name, string mapJson)
        {
            Validate(mapJson);
            string root = MapsDir(game);
            string dir;
            if (!string.IsNullOrEmpty(id))
            {
                dir = CreateService.Child(root, id);
            }
            else
            {
                Directory.CreateDirectory(root);
                dir = FolderStore.NewFolder(root, name, Guid.NewGuid().ToString("N"));
            }
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, MapFile);
            string temp = file + ".tmp-" + Environment.ProcessId;
            File.WriteAllText(temp, mapJson);
            File.Move(temp, file, true);
            return Path.GetFileName(dir);
        }

        /// <summary>Maps bigger than this are not drawn as a thumbnail (a whole level is megabytes).</summary>
        public const int PreviewMaxBytes = 6 * 1024 * 1024;

        /// <summary>
        /// What the Library needs to draw a map's picture: a revision (size and write time) and the map.json text, or no text
        /// when the revision is the one the caller already has (<paramref name="since"/>) or the map is too big or missing.
        /// </summary>
        public static (string Rev, string? Map, bool Same) Preview(string game, string id, string? since)
        {
            string file = Path.Combine(CreateService.Child(MapsDir(game), id), MapFile);
            var info = new FileInfo(file);
            if (!info.Exists) return ("missing", null, false);
            string rev = info.Length + "-" + info.LastWriteTimeUtc.Ticks;
            if (since == rev) return (rev, null, true);
            if (info.Length > PreviewMaxBytes) return (rev, null, false);
            return (rev, File.ReadAllText(file), false);
        }

        /// <summary>The text must be a JSON object with the pieces the game needs: a name and one group.</summary>
        public static void Validate(string mapJson)
        {
            if (string.IsNullOrWhiteSpace(mapJson) || mapJson.Length > MaxBytes) throw new ArgumentException("not a map file");
            JsonNode root;
            try { root = JsonFile.Parse(mapJson).Root; }
            catch (Exception e) { throw new ArgumentException("the map is not valid JSON: " + e.Message); }
            if (root is not JsonObject obj) throw new ArgumentException("the map must be a JSON object");
            if (!obj.TryGetValue("name", out JsonNode name) || name is not JsonString) throw new ArgumentException("the map has no name");
            if (!obj.TryGetValue("groups", out JsonNode groups) || groups is not JsonArray list || list.Count == 0 || list[0] is not JsonObject)
                throw new ArgumentException("the map has no group");
        }
    }
}

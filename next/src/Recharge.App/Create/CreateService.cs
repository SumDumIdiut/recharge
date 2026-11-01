using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using Recharge.App.Library;
using Recharge.Core.Json;
using Recharge.Core.Models;

namespace Recharge.App.Create
{
    /// <summary>Read-only listing of the user's own maps and skins for the Create page.</summary>
    public static class CreateService
    {
        public const string MapsModId = "recharge.maps";
        public const string SkinsModId = "recharge.customskins";

        /// <summary>A plain folder name: no separators, no "..", no leading dot, no control characters.</summary>
        public static bool IsPlainName(string? name)
        {
            if (string.IsNullOrEmpty(name) || name.Length > 200 || name[0] == '.' || name.Contains("..", StringComparison.Ordinal))
            {
                return false;
            }
            foreach (char c in name)
            {
                if (c == '/' || c == '\\' || c == ':' || char.IsControl(c))
                {
                    return false;
                }
            }
            return name.Trim().Length == name.Length;
        }

        public static string MapsDir(string game) => Path.Combine(game, "Recharge", "Mods", MapsModId, "maps");

        public static string SkinsDir(string game) => Path.Combine(game, "Recharge", "Mods", SkinsModId, "data", "skins");

        /// <summary>Resolves a folder the page asked for. kind is map, skin, maps or skins. Throws for bad names.</summary>
        public static string ResolveFolder(string game, string kind, string? folder)
        {
            switch (kind)
            {
                case "maps": return MapsDir(game);
                case "skins": return SkinsDir(game);
                case "map": return Child(MapsDir(game), folder);
                case "skin": return Child(SkinsDir(game), folder);
                default: throw new ArgumentException("unknown folder kind: " + kind);
            }
        }

        public static string Child(string parent, string? name)
        {
            if (!IsPlainName(name))
            {
                throw new ArgumentException("not a plain folder name");
            }
            string full = Path.GetFullPath(Path.Combine(parent, name!));
            string root = Path.GetFullPath(parent);
            if (!string.Equals(Path.GetDirectoryName(full), root, StringComparison.Ordinal))
            {
                throw new ArgumentException("folder is outside its parent");
            }
            return full;
        }

        public static JsonObject Maps(string mapsDir)
        {
            var rows = new List<(DateTime modified, string folder, JsonObject row)>();
            if (Directory.Exists(mapsDir))
            {
                foreach (string dir in Directory.GetDirectories(mapsDir))
                {
                    string folder = Path.GetFileName(dir);
                    string mapJson = Path.Combine(dir, "map.json");
                    if (!IsPlainName(folder) || !File.Exists(mapJson))
                    {
                        continue;
                    }
                    var info = new FileInfo(mapJson);
                    string? name = null;
                    try
                    {
                        using var stream = new FileStream(mapJson, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 65536);
                        using var reader = new StreamReader(stream, Encoding.UTF8, true, 65536);
                        name = InstalledScanner.ScanTopLevelString(reader, "name");
                    }
                    catch (IOException)
                    {
                        name = null;
                    }

                    string? hubId = null, hubName = null, hubUpdated = null;
                    int? revision = null;
                    string hubPath = Path.Combine(dir, "hub.json");
                    if (File.Exists(hubPath))
                    {
                        try
                        {
                            HubLink link = HubLink.Load(File.ReadAllText(hubPath));
                            hubId = link.Id;
                            // As the current app (autoupdate.js): an install from before revisions existed counts as revision 1.
                            revision = link.Revision ?? 1;
                            try { hubName = link.Name; } catch (KeyNotFoundException) { hubName = null; }
                            hubUpdated = ReadUpdatedAt(hubPath);
                        }
                        catch (Exception)
                        {
                            hubId = null;
                            revision = null;
                        }
                    }

                    var row = new JsonObject();
                    row["folder"] = new JsonString(folder);
                    // The game lists a hub map by its hub name (MapDefinition.ReadName), since two uploads can share the name in map.json.
                    row["name"] = new JsonString(!string.IsNullOrEmpty(hubName) ? hubName! : !string.IsNullOrEmpty(name) ? name! : folder);
                    row["mapName"] = name is null ? JsonNull.Instance : new JsonString(name);
                    row["hubId"] = hubId is null ? JsonNull.Instance : new JsonString(hubId);
                    row["hubName"] = hubName is null ? JsonNull.Instance : new JsonString(hubName);
                    row["revision"] = revision is null ? JsonNull.Instance : JsonNumber.From((long)revision.Value);
                    row["local"] = hubId is null ? JsonBool.True : JsonBool.False;
                    row["hasThumb"] = File.Exists(Path.Combine(dir, "thumb.png")) ? JsonBool.True : JsonBool.False;
                    // hasPreview: a render of this exact version (with its background). A packaged thumb.png can be the uploader's stale
                    // picture of an older version, so the page prefers the hub's picture over it.
                    string? preview = PreviewFor(dir);
                    row["hasPreview"] = preview != null && !preview.EndsWith("thumb.png", StringComparison.Ordinal) ? JsonBool.True : JsonBool.False;
                    DateTime modified = info.LastWriteTimeUtc;
                    // A map unzipped from a package can carry the zip's 1980 timestamp: then the hub's update time is used, else none.
                    if (modified.Year < 2000)
                    {
                        modified = hubUpdated != null && DateTime.TryParse(hubUpdated, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out DateTime hu)
                            ? hu : DateTime.MinValue;
                    }
                    row["modified"] = modified == DateTime.MinValue ? JsonNull.Instance : new JsonString(modified.ToString("o", CultureInfo.InvariantCulture));
                    row["sizeBytes"] = JsonNumber.From(info.Length);
                    rows.Add((modified, folder, row));
                }
            }

            rows.Sort((a, b) =>
            {
                int c = b.modified.CompareTo(a.modified);
                return c != 0 ? c : string.CompareOrdinal(a.folder, b.folder);
            });
            var maps = new JsonArray();
            foreach (var r in rows)
            {
                maps.Add(r.row);
            }
            var result = new JsonObject();
            result["maps"] = maps;
            return result;
        }

        private static string? ReadUpdatedAt(string hubPath)
        {
            try
            {
                return JsonReader.Parse(File.ReadAllText(hubPath)) is JsonObject o && o.TryGetValue("updatedAt", out JsonNode v) && v is JsonString str ? str.Value : null;
            }
            catch { return null; }
        }

        /// <summary>Where the current Recharge app keeps its rendered map pictures (the whole map with its background).</summary>
        public static string OldAppViewsDir =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "co.za.codecade.recharge", "map-thumbs");

        /// <summary>
        /// A map's preview: the picture the current app rendered for this exact version of the map (kept as
        /// "&lt;folder&gt;@&lt;map.json modified ms&gt;-r2.png", so a changed map never shows a stale picture), else its thumb.png.
        /// Interim until Amplifier 2 renders previews itself.
        /// </summary>
        public static string? PreviewFor(string mapDir, string? viewsDir = null)
        {
            string mapJson = Path.Combine(mapDir, "map.json");
            if (!File.Exists(mapJson)) return null;
            long ms = new DateTimeOffset(File.GetLastWriteTimeUtc(mapJson)).ToUnixTimeMilliseconds();
            string views = viewsDir ?? OldAppViewsDir;
            string render = Path.Combine(views, Path.GetFileName(mapDir) + "@" + ms.ToString(CultureInfo.InvariantCulture) + "-r2.png");
            if (File.Exists(render)) return render;
            string thumb = Path.Combine(mapDir, "thumb.png");
            return File.Exists(thumb) ? thumb : null;
        }

        public static JsonObject Skins(string skinsDir)
        {
            var list = new List<string>();
            if (Directory.Exists(skinsDir))
            {
                foreach (string dir in Directory.GetDirectories(skinsDir))
                {
                    if (IsPlainName(Path.GetFileName(dir)))
                    {
                        list.Add(dir);
                    }
                }
            }
            list.Sort(StringComparer.Ordinal);
            var skins = new JsonArray();
            foreach (string dir in list)
            {
                string? sheet = PlayerImage(dir);
                var row = new JsonObject();
                row["folder"] = new JsonString(Path.GetFileName(dir));
                row["hasSheet"] = sheet != null ? JsonBool.True : JsonBool.False;
                row["modified"] = new JsonString(Directory.GetLastWriteTimeUtc(dir).ToString("o", CultureInfo.InvariantCulture));
                skins.Add(row);
            }
            var result = new JsonObject();
            result["skins"] = skins;
            return result;
        }

        /// <summary>{mime, data} (base64) of a PNG file, or {data:null} when it is missing.</summary>
        public static JsonObject Image(string path)
        {
            var result = new JsonObject();
            if (!File.Exists(path))
            {
                result["data"] = JsonNull.Instance;
                return result;
            }
            string ext = Path.GetExtension(path).ToLowerInvariant();
            result["mime"] = new JsonString(ext == ".jpg" || ext == ".jpeg" ? "image/jpeg" : "image/png");
            result["data"] = new JsonString(Convert.ToBase64String(File.ReadAllBytes(path)));
            return result;
        }

        private static readonly string[] SkinImageExtensions = { ".png", ".jpg", ".jpeg" };
        private static readonly string[] IndicatorNames = { "dash", "doublejump", "double-jump", "double_jump", "jump" };

        /// <summary>
        /// The skin's player sheet the way the game picks it (Recharge.Loader.Core.Skins.SkinFiles.FindPlayerImage): the first image by
        /// name that isn't a dash or double-jump indicator. Not always skin-template.png: "pride.png", "box.png" and the like are sheets too.
        /// </summary>
        public static string? PlayerImage(string dir)
        {
            if (!Directory.Exists(dir)) return null;
            return Directory.EnumerateFiles(dir).OrderBy(f => f, StringComparer.OrdinalIgnoreCase).FirstOrDefault(f =>
                SkinImageExtensions.Contains(Path.GetExtension(f), StringComparer.OrdinalIgnoreCase) &&
                !IndicatorNames.Contains(Path.GetFileNameWithoutExtension(f), StringComparer.OrdinalIgnoreCase));
        }
}
}

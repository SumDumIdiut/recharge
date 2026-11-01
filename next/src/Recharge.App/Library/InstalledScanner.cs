using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Recharge.Core.Json;
using Recharge.Core.Models;

namespace Recharge.App.Library
{
    /// <summary>Read-only scan of an IGTAP Recharge/Mods folder: mods, maps and skins.</summary>
    public static class InstalledScanner
    {
        public const string MapsModId = "recharge.maps";
        public const string SkinsModId = "recharge.customskins";

        /// <summary>
        /// Scans <paramref name="modsDir"/>. Returns {game, mods, maps, skins, warnings}.
        /// Nothing is ever written.
        /// </summary>
        public static JsonObject Scan(string modsDir)
        {
            var warnings = new JsonArray();
            var mods = new JsonArray();
            var maps = new JsonArray();
            var skins = new JsonArray();

            if (Directory.Exists(modsDir))
            {
                foreach (string dir in SortedDirectories(modsDir))
                {
                    string manifestPath = Path.Combine(dir, "mod.json");
                    if (!File.Exists(manifestPath))
                    {
                        continue;
                    }
                    string folder = Path.GetFileName(dir);
                    try
                    {
                        ModManifest manifest = ModManifest.Load(File.ReadAllText(manifestPath));
                        var row = new JsonObject();
                        row["id"] = new JsonString(manifest.Id);
                        row["displayName"] = new JsonString(manifest.DisplayName);
                        row["version"] = new JsonString(manifest.Version);
                        row["enabled"] = manifest.Enabled ? JsonBool.True : JsonBool.False;
                        row["folder"] = new JsonString(folder);
                        AddHubLink(row, dir);
                        mods.Add(row);
                    }
                    catch (Exception e)
                    {
                        Warn(warnings, "skipped " + folder + "/mod.json: " + e.Message);
                    }
                }

                string mapsDir = Path.Combine(modsDir, MapsModId, "maps");
                if (Directory.Exists(mapsDir))
                {
                    foreach (string dir in SortedDirectories(mapsDir))
                    {
                        maps.Add(ReadMap(dir, warnings));
                    }
                }

                string skinsDir = Path.Combine(modsDir, SkinsModId, "data", "skins");
                if (Directory.Exists(skinsDir))
                {
                    foreach (string dir in SortedDirectories(skinsDir))
                    {
                        var row = new JsonObject();
                        row["folder"] = new JsonString(Path.GetFileName(dir));
                        ContentInstaller.Meta? meta = ContentInstaller.ReadMeta(dir);
                        row["name"] = new JsonString(string.IsNullOrEmpty(meta?.Name) ? Path.GetFileName(dir) : meta!.Name!);
                        AddHubLink(row, dir);
                        skins.Add(row);
                    }
                }
            }

            var result = new JsonObject();
            result["mods"] = mods;
            result["maps"] = maps;
            result["skins"] = skins;
            result["warnings"] = warnings;
            return result;
        }

        /// <summary>hubId and revision from the folder's HUB_META_FILE (null when it has none).</summary>
        private static void AddHubLink(JsonObject row, string dir)
        {
            ContentInstaller.Meta? meta = ContentInstaller.ReadMeta(dir);
            row["hubId"] = meta?.Id is null ? JsonNull.Instance : new JsonString(meta.Id);
            row["revision"] = meta?.Revision is null ? JsonNull.Instance : JsonNumber.From(meta.Revision.Value);
        }

        /// <summary>Backgrounds or playlists: one row per folder under dir, {folder, name, hubId, revision}.</summary>
        public static JsonArray ScanContent(string dir)
        {
            var rows = new JsonArray();
            foreach (string d in FolderStore.Folders(dir))
            {
                var row = new JsonObject();
                ContentInstaller.Meta? meta = ContentInstaller.ReadMeta(d);
                row["folder"] = new JsonString(Path.GetFileName(d));
                row["name"] = new JsonString(string.IsNullOrEmpty(meta?.Name) ? Path.GetFileName(d) : meta!.Name!);
                AddHubLink(row, d);
                rows.Add(row);
            }
            return rows;
        }

        private static JsonObject ReadMap(string dir, JsonArray warnings)
        {
            string folder = Path.GetFileName(dir);
            string? name = null;
            string? hubId = null;
            int? revision = null;

            string hubPath = Path.Combine(dir, "hub.json");
            if (File.Exists(hubPath))
            {
                try
                {
                    HubLink link = HubLink.Load(File.ReadAllText(hubPath));
                    hubId = link.Id;
                    revision = link.Revision;
                    try
                    {
                        name = link.Name;
                    }
                    catch (KeyNotFoundException)
                    {
                        name = null;
                    }
                }
                catch (Exception e)
                {
                    Warn(warnings, "ignored " + folder + "/hub.json: " + e.Message);
                    hubId = null;
                    revision = null;
                }
            }

            if (string.IsNullOrEmpty(name))
            {
                string mapPath = Path.Combine(dir, "map.json");
                if (File.Exists(mapPath))
                {
                    try
                    {
                        name = ReadTopLevelName(mapPath);
                    }
                    catch (IOException e)
                    {
                        Warn(warnings, "could not read " + folder + "/map.json: " + e.Message);
                    }
                }
            }

            var row = new JsonObject();
            row["folder"] = new JsonString(folder);
            row["name"] = new JsonString(string.IsNullOrEmpty(name) ? folder : name!);
            row["hubId"] = hubId is null ? JsonNull.Instance : new JsonString(hubId);
            row["revision"] = revision is null ? JsonNull.Instance : JsonNumber.From((long)revision.Value);
            return row;
        }

        private static void Warn(JsonArray warnings, string message)
        {
            warnings.Add(new JsonString(message));
            Console.Error.WriteLine("[library] " + message);
        }

        private static List<string> SortedDirectories(string path)
        {
            var list = new List<string>(Directory.GetDirectories(path));
            list.Sort(StringComparer.Ordinal);
            return list;
        }

        /// <summary>
        /// Streams the file and returns the first top-level string "name" member, or null.
        /// It never builds the document, so huge maps cost one pass of chars, not memory.
        /// </summary>
        public static string? ReadTopLevelName(string path)
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 65536);
            using var reader = new StreamReader(stream, Encoding.UTF8, true, 65536);
            return ScanTopLevelString(reader, "name");
        }

        /// <summary>The first top-level string member called <paramref name="key"/>, read in one streaming pass, or null.</summary>
        public static string? ScanTopLevelString(TextReader reader, string key)
        {
            var buffer = new char[65536];
            int depth = 0;
            bool inString = false;
            bool escaped = false;
            bool stringIsKey = false;
            char lastSignificant = '\0';
            var text = new StringBuilder();
            bool wantValue = false;
            bool afterKey = false;
            int count;
            while ((count = reader.Read(buffer, 0, buffer.Length)) > 0)
            {
                for (int i = 0; i < count; i++)
                {
                    char c = buffer[i];
                    if (inString)
                    {
                        if (escaped)
                        {
                            escaped = false;
                            if (depth == 1 && (stringIsKey || wantValue))
                            {
                                text.Append(c == 'n' ? '\n' : c == 't' ? '\t' : c);
                            }
                        }
                        else if (c == '\\')
                        {
                            escaped = true;
                        }
                        else if (c == '"')
                        {
                            inString = false;
                            if (depth == 1 && wantValue)
                            {
                                return text.ToString();
                            }
                            if (depth == 1 && stringIsKey)
                            {
                                afterKey = text.ToString() == key;
                            }
                            lastSignificant = '"';
                        }
                        else if (depth == 1 && (stringIsKey || wantValue))
                        {
                            text.Append(c);
                        }
                        continue;
                    }

                    if (char.IsWhiteSpace(c))
                    {
                        continue;
                    }

                    if (wantValue)
                    {
                        if (c == '"')
                        {
                            inString = true;
                            stringIsKey = false;
                            text.Clear();
                            continue;
                        }
                        return null;
                    }

                    if (afterKey && c == ':')
                    {
                        wantValue = true;
                        afterKey = false;
                        lastSignificant = c;
                        continue;
                    }

                    if (c == '"')
                    {
                        inString = true;
                        stringIsKey = depth == 1 && (lastSignificant == '{' || lastSignificant == ',');
                        afterKey = false;
                        text.Clear();
                        continue;
                    }

                    if (c == '{' || c == '[')
                    {
                        depth++;
                    }
                    else if (c == '}' || c == ']')
                    {
                        depth--;
                    }
                    lastSignificant = c;
                    afterKey = false;
                }
            }
            return null;
        }
    }
}

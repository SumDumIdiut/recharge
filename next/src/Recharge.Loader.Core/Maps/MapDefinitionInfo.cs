#nullable disable
using System;
using System.Collections.Generic;
using Recharge.Core.Json;

namespace Recharge.Loader.Core.Maps
{
    /// <summary>One course of a group (the parts the loader needs to reason about, Unity-free).</summary>
    public sealed class MapCourseInfo
    {
        public string Id = "";
        public float StartX, StartY, EndX, EndY;
        public bool IsLevelCopy;
    }

    /// <summary>One group of a map.json: gates, spawns, courses and object count.</summary>
    public sealed class MapGroupInfo
    {
        public float StartX, StartY, EndX, EndY;
        public float? SpawnX, SpawnY;
        public bool Gates = true;
        public bool KeepSpawn;
        public int ObjectCount;
        public List<MapCourseInfo> Courses = new List<MapCourseInfo>();
        public List<(float X, float Y)> ExtraSpawns = new List<(float, float)>();
    }

    /// <summary>
    /// A Unity-free summary of a map.json, read with Recharge.Core.Json, using the same field names and defaults
    /// as the in-game reader (MapDefinition).
    /// </summary>
    public sealed class MapDefinitionInfo
    {
        public int FormatVersion = 1;
        public string Name = "";
        public string Description = "";
        public bool Overlay;
        public bool Stages;
        public string BaseState;
        public float? CameraSize;
        public int StartZone;
        public string AreaState;
        public List<string> HiddenGroups = new List<string>();
        public List<MapGroupInfo> Groups = new List<MapGroupInfo>();

        public static MapDefinitionInfo Parse(string json)
        {
            var root = JsonReader.Parse(json) as JsonObject ?? throw new FormatException("map.json is not an object");
            var d = new MapDefinitionInfo
            {
                FormatVersion = (int)Num(root, "formatVersion", 1),
                Name = Str(root, "name") ?? "",
                Description = Str(root, "description") ?? "",
                Overlay = Bool(root, "overlay", false),
                Stages = Bool(root, "stages", false),
                BaseState = Str(root, "baseState"),
                StartZone = (int)Num(root, "startZone", 0),
                AreaState = Str(root, "areaState"),
            };
            if (root.TryGetValue("cameraSize", out var cs) && cs is JsonNumber cn) d.CameraSize = (float)cn.AsDouble();
            if (root.TryGetValue("hiddenGroups", out var hg) && hg is JsonArray ha)
                foreach (var h in ha) if (h is JsonString hs) d.HiddenGroups.Add(hs.Value);
            if (root.TryGetValue("groups", out var gs) && gs is JsonArray ga)
                foreach (var gn in ga) if (gn is JsonObject go) d.Groups.Add(ReadGroup(go));
            return d;
        }

        private static MapGroupInfo ReadGroup(JsonObject g)
        {
            var info = new MapGroupInfo
            {
                StartX = (float)Num(g, "startX", 0), StartY = (float)Num(g, "startY", 0),
                EndX = (float)Num(g, "endX", 0), EndY = (float)Num(g, "endY", 0),
                Gates = Bool(g, "gates", true), KeepSpawn = Bool(g, "keepSpawn", false),
            };
            if (g.TryGetValue("spawnX", out var sx) && sx is JsonNumber sxn) info.SpawnX = (float)sxn.AsDouble();
            if (g.TryGetValue("spawnY", out var sy) && sy is JsonNumber syn) info.SpawnY = (float)syn.AsDouble();
            if (g.TryGetValue("objects", out var os) && os is JsonArray oa) info.ObjectCount = oa.Count;
            if (g.TryGetValue("courses", out var cs) && cs is JsonArray ca)
                foreach (var cn in ca)
                    if (cn is JsonObject c)
                        info.Courses.Add(new MapCourseInfo
                        {
                            Id = Str(c, "id") ?? "",
                            StartX = (float)Num(c, "startX", 0), StartY = (float)Num(c, "startY", 0),
                            EndX = (float)Num(c, "endX", 0), EndY = (float)Num(c, "endY", 0),
                            IsLevelCopy = c.TryGetValue("level", out var lv) && lv is JsonObject,
                        });
            if (g.TryGetValue("spawns", out var ss) && ss is JsonArray sa)
                foreach (var sn in sa)
                    if (sn is JsonObject s) info.ExtraSpawns.Add(((float)Num(s, "x", 0), (float)Num(s, "y", 0)));
            return info;
        }

        /// <summary>The group's spawn points in Q/E cycle order, as map coordinates (main spawn first when it counts).</summary>
        public static List<(float X, float Y)> SpawnPoints(MapGroupInfo g, bool overlay)
        {
            var list = new List<(float X, float Y)>();
            if (MapRules.IncludesMainSpawn(g.SpawnX != null, overlay, g.KeepSpawn))
                list.Add((g.SpawnX ?? g.StartX, g.SpawnY ?? g.StartY));
            list.AddRange(g.ExtraSpawns);
            return list;
        }

        /// <summary>The hub.json name (what a Hub map goes by), or null when absent or blank.</summary>
        public static string ReadHubName(string hubJson)
        {
            try
            {
                if (JsonReader.Parse(hubJson) is JsonObject o && Str(o, "name") is string n && !string.IsNullOrWhiteSpace(n)) return n;
            }
            catch (JsonParseException) { }
            return null;
        }

        private static string Str(JsonObject o, string key) => o.TryGetValue(key, out var n) && n is JsonString s ? s.Value : null;
        private static double Num(JsonObject o, string key, double dflt) => o.TryGetValue(key, out var n) && n is JsonNumber x ? x.AsDouble() : dflt;
        private static bool Bool(JsonObject o, string key, bool dflt) => o.TryGetValue(key, out var n) && n is JsonBool b ? b.Value : dflt;
    }
}

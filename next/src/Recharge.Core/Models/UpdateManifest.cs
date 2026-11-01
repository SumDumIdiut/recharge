using System;
using System.Collections.Generic;
using System.Globalization;
using Recharge.Core.Json;

namespace Recharge.Core.Models
{
    /// <summary>Typed (read-only) view over an update manifest file.</summary>
    public sealed class UpdateManifest
    {
        private JsonFile _file;

        public sealed class UpdateFile
        {
            public string Path { get; }
            public long Size { get; }
            public string Sha256 { get; }
            public string Component { get; }

            public UpdateFile(string path, long size, string sha256, string component)
            {
                Path = path;
                Size = size;
                Sha256 = sha256;
                Component = component;
            }
        }

        public sealed class PlatformFiles
        {
            public string Launch { get; }
            public IReadOnlyList<UpdateFile> Files { get; }

            public PlatformFiles(string launch, IReadOnlyList<UpdateFile> files)
            {
                Launch = launch;
                Files = files;
            }
        }

        public UpdateManifest() : this(JsonFile.New(new JsonObject())) { }

        public UpdateManifest(JsonFile file)
        {
            _file = file ?? throw new ArgumentNullException(nameof(file));
        }

        public JsonFile File => _file;

        public JsonObject Root => _file.Root;

        public int Format => GetInt("format");

        public string Channel => GetString("channel");

        public string Version => GetString("version");

        public int Build => GetInt("build");

        public int ApiLevel => GetInt("apiLevel");

        public DateTimeOffset Published => ParseDate(GetString("published"));

        public string Commit => GetString("commit");

        public Dictionary<string, PlatformFiles> Platforms
        {
            get
            {
                var result = new Dictionary<string, PlatformFiles>(StringComparer.Ordinal);
                if (!_file.Root.TryGetValue("platforms", out var node) || node is not JsonObject platformsObj)
                {
                    return result;
                }
                foreach (var kv in platformsObj)
                {
                    if (kv.Value is not JsonObject po)
                    {
                        continue;
                    }
                    string launch = po.TryGetValue("launch", out var ln) && ln is JsonString ls ? ls.Value : string.Empty;
                    var files = new List<UpdateFile>();
                    if (po.TryGetValue("files", out var fn) && fn is JsonArray arr)
                    {
                        foreach (var item in arr)
                        {
                            if (item is not JsonObject fo)
                            {
                                continue;
                            }
                            string path = fo.TryGetValue("path", out var pn) && pn is JsonString ps ? ps.Value : string.Empty;
                            long size = 0;
                            if (fo.TryGetValue("size", out var sn) && sn is JsonNumber ns)
                            {
                                size = ns.AsInt64();
                            }
                            string sha = fo.TryGetValue("sha256", out var shn) && shn is JsonString shs ? shs.Value : string.Empty;
                            string comp = fo.TryGetValue("component", out var cn) && cn is JsonString cs ? cs.Value : string.Empty;
                            files.Add(new UpdateFile(path, size, sha, comp));
                        }
                    }
                    result[kv.Key] = new PlatformFiles(launch, files);
                }
                return result;
            }
        }

        public static UpdateManifest Load(string text)
        {
            return new UpdateManifest(JsonFile.Parse(text));
        }


        public string Save() => _file.Write();

        private string GetString(string key)
        {
            if (!_file.Root.TryGetValue(key, out var node))
            {
                throw new KeyNotFoundException("Missing field: " + key);
            }
            if (node is JsonString s)
            {
                return s.Value;
            }
            return node.ToString();
        }

        private int GetInt(string key)
        {
            if (!_file.Root.TryGetValue(key, out var node))
            {
                throw new KeyNotFoundException("Missing field: " + key);
            }
            if (node is JsonNumber n)
            {
                return n.AsInt32();
            }
            if (int.TryParse(node.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int v))
            {
                return v;
            }
            throw new FormatException("Not an int: " + key);
        }

        private static DateTimeOffset ParseDate(string text)
        {
            return DateTimeOffset.Parse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind | DateTimeStyles.AssumeUniversal);
        }
    }
}

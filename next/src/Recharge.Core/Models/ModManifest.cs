using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using Recharge.Core.Json;

namespace Recharge.Core.Models
{
    /// <summary>Typed view over a mod.json file.</summary>
    public sealed class ModManifest
    {
        private JsonFile _file;

        public ModManifest() : this(JsonFile.New(new JsonObject())) { }

        public ModManifest(JsonFile file)
        {
            _file = file ?? throw new ArgumentNullException(nameof(file));
        }

        public JsonFile File => _file;

        public JsonObject Root => _file.Root;

        public string Id
        {
            get => GetString("id");
            set => SetNode("id", new JsonString(value));
        }

        public string DisplayName
        {
            get => GetString("displayName");
            set => SetNode("displayName", new JsonString(value));
        }

        public string Version
        {
            get => GetString("version");
            set => SetNode("version", new JsonString(value));
        }

        public string Author
        {
            get => GetString("author");
            set => SetNode("author", new JsonString(value));
        }

        public string? Description
        {
            get
            {
                if (!_file.Root.TryGetValue("description", out var node) || node is JsonNull)
                {
                    return null;
                }
                return node is JsonString s ? s.Value : node.ToString();
            }
            set
            {
                if (value is null)
                {
                    _file.Root.Remove("description");
                }
                else
                {
                    SetNode("description", new JsonString(value));
                }
            }
        }

        public string EntryAssembly
        {
            get => GetString("entryAssembly");
            set => SetNode("entryAssembly", new JsonString(value));
        }

        public string MinLoaderVersion
        {
            get => GetString("minLoaderVersion");
            set => SetNode("minLoaderVersion", new JsonString(value));
        }

        public bool Enabled
        {
            get
            {
                if (!_file.Root.TryGetValue("enabled", out var node))
                {
                    return true;
                }
                return node is JsonBool b && b.Value;
            }
            set => SetNode("enabled", value ? JsonBool.True : JsonBool.False);
        }

        public static ModManifest Load(string text)
        {
            return new ModManifest(JsonFile.Parse(text));
        }


        public string Save() => _file.Write();

        public List<string> Validate()
        {
            var problems = new List<string>();
            var root = _file.Root;

            // id
            if (!root.TryGetValue("id", out var idNode) || idNode is not JsonString idStr ||
                !Regex.IsMatch(idStr.Value, @"^[a-z0-9]+(\.[a-z0-9-]+)+$"))
            {
                problems.Add("id must match ^[a-z0-9]+(\\.[a-z0-9-]+)+$");
            }

            // version
            if (!root.TryGetValue("version", out var verNode) || verNode is not JsonString verStr ||
                !RechargeVersion.TryParse(verStr.Value, out _))
            {
                problems.Add("version must parse as RechargeVersion");
            }

            // minLoaderVersion
            if (!root.TryGetValue("minLoaderVersion", out var minNode) || minNode is not JsonString minStr ||
                !RechargeVersion.TryParse(minStr.Value, out _))
            {
                problems.Add("minLoaderVersion must parse as RechargeVersion");
            }

            // entryAssembly
            if (!root.TryGetValue("entryAssembly", out var entryNode) || entryNode is not JsonString entryStr)
            {
                problems.Add("entryAssembly must end in .dll and have no path separators");
            }
            else
            {
                string e = entryStr.Value;
                if (!e.EndsWith(".dll", StringComparison.Ordinal) ||
                    e.IndexOf('/') >= 0 || e.IndexOf('\\') >= 0)
                {
                    problems.Add("entryAssembly must end in .dll and have no path separators");
                }
            }

            return problems;
        }

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

        private void SetNode(string key, JsonNode value)
        {
            // JsonObject setter keeps position for existing keys and appends new ones.
            _file.Root[key] = value;
        }
    }
}

using System;
using Recharge.Core.Json;

namespace Recharge.Core.Models
{
    /// <summary>Typed view over a hub.json file.</summary>
    public sealed class HubLink
    {
        private JsonFile _file;

        public HubLink() : this(JsonFile.New(new JsonObject())) { }

        public HubLink(JsonFile file)
        {
            _file = file ?? throw new ArgumentNullException(nameof(file));
        }

        public JsonFile File => _file;

        public JsonObject Root => _file.Root;

        public string Id
        {
            get => GetString("id");
            set => _file.Root["id"] = new JsonString(value);
        }

        public string Name
        {
            get => GetString("name");
            set => _file.Root["name"] = new JsonString(value);
        }

        public int? Revision
        {
            get
            {
                if (!_file.Root.TryGetValue("revision", out var node) || node is JsonNull)
                {
                    return null;
                }
                if (node is JsonNumber n)
                {
                    return n.AsInt32();
                }
                if (int.TryParse(node.ToString(), out int v))
                {
                    return v;
                }
                return null;
            }
            set
            {
                if (value is null)
                {
                    _file.Root.Remove("revision");
                }
                else
                {
                    _file.Root["revision"] = new JsonNumber(value.Value.ToString(System.Globalization.CultureInfo.InvariantCulture));
                }
            }
        }

        public static HubLink Load(string text)
        {
            return new HubLink(JsonFile.Parse(text));
        }


        public string Save() => _file.Write();

        private string GetString(string key)
        {
            if (!_file.Root.TryGetValue(key, out var node))
            {
                throw new System.Collections.Generic.KeyNotFoundException("Missing field: " + key);
            }
            if (node is JsonString s)
            {
                return s.Value;
            }
            return node.ToString();
        }
    }
}

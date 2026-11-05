using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Recharge.App.Account;
using Recharge.App.Settings;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>files.pick and hub.submit: choose files on disk, and upload them to the hub as a mod, map or skin.</summary>
    public static class UploadCommands
    {
        public static void Register(CommandRegistry registry)
        {
            // files.pick {title?, filters?: [{name, extensions: [string]}], multiple?: bool} -> {paths: [string]} (empty when cancelled)
            registry.Register("files.pick", async args =>
            {
                string title = Str(args, "title");
                var filters = new List<PickFilter>();
                if (args.TryGetValue("filters", out JsonNode f) && f is JsonArray list)
                {
                    foreach (JsonNode item in list)
                    {
                        if (item is not JsonObject o) continue;
                        var exts = new List<string>();
                        if (o.TryGetValue("extensions", out JsonNode e) && e is JsonArray ea)
                            foreach (JsonNode x in ea) if (x is JsonString xs) exts.Add(xs.Value);
                        filters.Add(new PickFilter(Str(o, "name") is { Length: > 0 } n ? n : "Files", exts.ToArray()));
                    }
                }
                bool multiple = args.TryGetValue("multiple", out JsonNode m) && m is JsonBool mb && mb.Value;
                string[] paths = await FilePicker.PickAsync(title.Length > 0 ? title : "Choose a file", filters, multiple).ConfigureAwait(false);
                var result = new JsonObject();
                var array = new JsonArray();
                foreach (string p in paths) array.Add(new JsonString(p));
                result["paths"] = array;
                return result;
            });

            // hub.submit {fields: {k: v}, file?: path, gallery?: [path]} -> the hub's reply ({id, status}); a non-2xx answer throws the hub's error text
            registry.Register("hub.submit", async args =>
            {
                var fields = new Dictionary<string, string>(StringComparer.Ordinal);
                if (args.TryGetValue("fields", out JsonNode f) && f is JsonObject fo)
                {
                    foreach (KeyValuePair<string, JsonNode> field in fo)
                    {
                        if (field.Value is JsonString s) fields[field.Key] = s.Value;
                        else if (field.Value is JsonNumber n) fields[field.Key] = n.Raw;
                        else if (field.Value is JsonBool b) fields[field.Key] = b.Value ? "true" : "false";
                    }
                }
                string zip = Str(args, "file");
                var gallery = new List<string>();
                if (args.TryGetValue("gallery", out JsonNode g) && g is JsonArray ga)
                    foreach (JsonNode item in ga) if (item is JsonString s && s.Value.Length > 0) gallery.Add(s.Value);
                return await HubSubmit.SubmitAsync(fields, zip.Length > 0 ? zip : null, gallery).ConfigureAwait(false);
            });
        }

        private static string Str(JsonObject args, string key) =>
            args.TryGetValue(key, out JsonNode n) && n is JsonString s ? s.Value : "";
    }
}

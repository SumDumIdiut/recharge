using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.Json;
using System.Threading.Tasks;
using Recharge.App.Settings;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>settings.get / set / setGamePath / pickFolder / openGameFolder / background.</summary>
    public static class SettingsCommands
    {
        public static void Register(CommandRegistry registry) => Register(registry, SettingsService.Default);

        public static void Register(CommandRegistry registry, Func<SettingsService> service)
        {
            try { service().ApplyGameOverride(); }
            catch (Exception e) { Console.Error.WriteLine("settings: " + e.Message); }

            BackgroundCommands.Register(registry, () => service().DataDir);
            registry.Register("settings.get", args => Task.FromResult(View(service().Get())));
            registry.Register("settings.set", args =>
            {
                var patch = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(JsonWriter.Write(args, 0)) ?? new Dictionary<string, JsonElement>();
                return Task.FromResult(View(service().Patch(patch)));
            });
            registry.Register("settings.setGamePath", args =>
            {
                string? path = args.TryGetValue("path", out JsonNode n) && n is JsonString s ? s.Value : null;
                return Task.FromResult(View(service().SetGamePath(path)));
            });
            registry.Register("settings.validateGamePath", args =>
            {
                string? path = args.TryGetValue("path", out JsonNode n) && n is JsonString s ? s.Value : null;
                string? problem = SettingsService.ValidateGameFolder(path);
                return Task.FromResult(Obj(new { ok = problem == null, error = problem }));
            });
            registry.Register("settings.pickFolder", async args =>
            {
                string? start = args.TryGetValue("start", out JsonNode n) && n is JsonString s && s.Value.Length > 0 ? s.Value : null;
                string? chosen = await FolderPicker.PickAsync("Choose the IGTAP folder", start).ConfigureAwait(false);
                return Obj(new { path = chosen });
            });
            registry.Register("settings.openGameFolder", args =>
            {
                string game = GameFinder.Find() ?? throw new InvalidOperationException("IGTAP wasn't found");
                ShellOpen.Open(game);
                return Task.FromResult(Obj(new { opened = true }));
            });
            registry.Register("settings.background", args =>
            {
                string folder = args.TryGetValue("folder", out JsonNode n) && n is JsonString s ? s.Value : "";
                (string kind, string mime, byte[]? data) = service().ReadBackground(folder);
                return Task.FromResult(Obj(new { kind, mime, data = data == null ? null : Convert.ToBase64String(data) }));
            });
        }

        private static JsonNode View(AppSettings s) => Obj(s, SettingsStore.Options);

        internal static JsonNode Obj(object value, JsonSerializerOptions? options = null) =>
            JsonReader.Parse(JsonSerializer.Serialize(value, options ?? Camel));

        private static readonly JsonSerializerOptions Camel = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    }
}

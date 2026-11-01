using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Recharge.App.Scheme;
using Recharge.App.Settings;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>backgrounds.list / pickFile / import / createPlaylist / addFile / addInstalled / saveOrder / renamePlaylist / deletePlaylist.</summary>
    public static class BackgroundCommands
    {
        public static void Register(CommandRegistry registry, Func<string> dataDir)
        {
            BackgroundService Svc() => new BackgroundService(dataDir());
            string Str(JsonObject args, string key) =>
                args.TryGetValue(key, out JsonNode? n) && n is JsonString s ? s.Value : "";

            registry.Register("backgrounds.list", args =>
            {
                BackgroundService svc = Svc();
                return Task.FromResult(SettingsCommands.Obj(new { backgrounds = svc.Backgrounds(), playlists = svc.Playlists() }));
            });
            registry.Register("backgrounds.mediaBase", args =>
                Task.FromResult(SettingsCommands.Obj(new
                {
                    mediaBase = BackgroundHttpServer.Shared(() => BackgroundPathResolver.Root(dataDir())).BaseUrl,
                })));
            registry.Register("backgrounds.pickFile", async args =>
            {
                string? chosen = await FilePicker.PickMediaAsync("Choose a picture or a video").ConfigureAwait(false);
                return SettingsCommands.Obj(new { path = chosen });
            });
            registry.Register("backgrounds.import", args =>
                Task.FromResult(SettingsCommands.Obj(new { folder = Svc().ImportBackground(Str(args, "path"), Str(args, "name")) })));
            registry.Register("backgrounds.createPlaylist", args =>
                Task.FromResult(SettingsCommands.Obj(new { folder = Svc().CreatePlaylist(Str(args, "name")) })));
            registry.Register("backgrounds.addFile", args =>
                Task.FromResult(SettingsCommands.Obj(new { file = Svc().AddFile(Str(args, "playlist"), Str(args, "path")) })));
            registry.Register("backgrounds.addInstalled", args =>
                Task.FromResult(SettingsCommands.Obj(new { file = Svc().AddInstalled(Str(args, "playlist"), Str(args, "background")) })));
            registry.Register("backgrounds.saveOrder", args =>
            {
                var files = new List<string>();
                if (args.TryGetValue("files", out JsonNode? n) && n is JsonArray a)
                    foreach (JsonNode item in a) if (item is JsonString s) files.Add(s.Value);
                Svc().SaveOrder(Str(args, "playlist"), files);
                return Task.FromResult(SettingsCommands.Obj(new { ok = true }));
            });
            registry.Register("backgrounds.renamePlaylist", args =>
            {
                Svc().RenamePlaylist(Str(args, "playlist"), Str(args, "name"));
                return Task.FromResult(SettingsCommands.Obj(new { ok = true }));
            });
            registry.Register("backgrounds.deletePlaylist", args =>
            {
                Svc().DeletePlaylist(Str(args, "playlist"));
                return Task.FromResult(SettingsCommands.Obj(new { ok = true }));
            });
        }
    }
}

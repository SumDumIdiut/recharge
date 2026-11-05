using System;
using System.Diagnostics;
using System.Threading.Tasks;
using Recharge.App.Native;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>The built-in bridge commands.</summary>
    public static class Commands
    {
        /// <summary>Commands that can change the installed listing (library.* clears the memo itself as well).</summary>
        public static readonly string[] InvalidatesInstalled =
        {
            "library.install", "library.update", "library.remove", "library.setModEnabled", "library.removeFolder", "settings.setGamePath",
            "backgrounds.import", "backgrounds.createPlaylist", "backgrounds.addFile", "backgrounds.addInstalled",
            "backgrounds.saveOrder", "backgrounds.renamePlaylist", "backgrounds.deletePlaylist",
        };

        public static CommandRegistry CreateRegistry()
        {
            var registry = new CommandRegistry();
            registry.Register("app.info", AppInfo);
            registry.Register("hub.get", HubGet);
            registry.Register("hub.image", HubImage);
            registry.Register("game.find", GameFind);
            registry.Register("open.url", OpenUrl);
            registry.Register("library.installed", LibraryInstalled);
            registry.Register("library.install", LibraryInstall);
            registry.Register("library.update", LibraryInstall);
            registry.Register("library.remove", LibraryRemove);
            // library.setModEnabled {folder|id: string, enabled: bool}: writes "enabled" in that mod's mod.json (not while the game runs, not for built-ins)
            registry.Register("library.setModEnabled", args =>
            {
                string key = args.TryGetValue("folder", out JsonNode f) && f is JsonString fs && fs.Value.Length > 0 ? fs.Value : RequiredString(args, "id");
                bool on = args.TryGetValue("enabled", out JsonNode e) && e is JsonBool eb ? eb.Value : throw new ArgumentException("enabled (true or false) is required");
                return Task.FromResult<JsonNode>(Service().SetModEnabled(key, on));
            });
            registry.Register("library.removeFolder", args => Task.FromResult<JsonNode>(Service().RemoveFolder(RequiredString(args, "kind"), RequiredString(args, "folder"))));
            CreateCommands.Register(registry);
            IconCommands.Register(registry);
            AccountCommands.Register(registry);
            UploadCommands.Register(registry);
            LobbyCommands.Register(registry);
            SocialCommands.Register(registry);
            SkinCommands.Register(registry);
            LoaderCommands.Register(registry);
            GunCommands.Register(registry);
            GameCommands.Register(registry);
            UpdateCommands.Register(registry);
            PerfCommands.Register(registry);
            // whatever changes what is installed also drops the installed-scan memo (it checks file times as well; this is the exact rule)
            foreach (string name in InvalidatesInstalled)
            {
                if (!registry.TryGet(name, out CommandHandler inner)) continue;
                registry.Register(name, async args =>
                {
                    try { return await inner(args).ConfigureAwait(false); }
                    finally { Library.InstalledCache.Invalidate(); }
                });
            }
            return registry;
        }

        private static Task<JsonNode> AppInfo(JsonObject args)
        {
            var result = new JsonObject();
            result["name"] = new JsonString("Recharge");
            result["version"] = new JsonString(AppVersion.Value);
            result["dotnet"] = new JsonString(Environment.Version.ToString());
            result["engine"] = new JsonString(WebEngine());
            return Task.FromResult<JsonNode>(result);
        }

        /// <summary>The web engine drawing the app: WebView2 on Windows, WebKitGTK on Linux.</summary>
        private static string WebEngine()
        {
            if (OperatingSystem.IsWindows())
            {
                try { return "WebView2 " + Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString(); }
                catch (Exception) { return "WebView2"; }
            }
            return "WebKitGTK " + WebKit.webkit_get_major_version() + "." + WebKit.webkit_get_minor_version() + "." + WebKit.webkit_get_micro_version();
        }

        private static async Task<JsonNode> HubGet(JsonObject args)
        {
            string path = RequiredString(args, "path");
            if (!HubPath.IsValid(path))
            {
                throw new ArgumentException("hub path must start with /api/", nameof(args));
            }

            (int status, string body) = await HubClient.GetAsync(path).ConfigureAwait(false);
            var result = new JsonObject();
            result["status"] = JsonNumber.From(status);
            result["body"] = new JsonString(body);
            return result;
        }

        private static async Task<JsonNode> HubImage(JsonObject args)
        {
            string path = RequiredString(args, "path");
            if (!HubClient.IsGalleryPath(path))
            {
                throw new ArgumentException("not a hub gallery path", nameof(args));
            }

            (int status, string mime, byte[] data) = await HubClient.GetImageAsync(path).ConfigureAwait(false);
            var result = new JsonObject();
            result["status"] = JsonNumber.From(status);
            result["mime"] = new JsonString(mime);
            result["data"] = new JsonString(Convert.ToBase64String(data));
            return result;
        }

        private static Task<JsonNode> GameFind(JsonObject args)
        {
            string? path = GameFinder.Find();
            var result = new JsonObject();
            result["path"] = path is null ? JsonNull.Instance : new JsonString(path);
            return Task.FromResult<JsonNode>(result);
        }

        private static Library.LibraryService Service() =>
            new Library.LibraryService(GameFinder.Find(), Library.LibraryService.DefaultDataDir(), new Library.RealHubSource());

        private static Task<JsonNode> LibraryInstalled(JsonObject args) => Task.FromResult<JsonNode>(Service().Installed());

        /// <summary>Install or update a hub item of any kind (mods, maps, skins, backgrounds, playlists).</summary>
        private static async Task<JsonNode> LibraryInstall(JsonObject args)
        {
            string kind = RequiredString(args, "kind");
            string id = RequiredString(args, "id");
            // The UI passes the other hub maps' names so a legacy-collided folder (claimed by this id but installed from another entry) is never reused.
            var otherNames = new System.Collections.Generic.List<string>();
            if (args.TryGetValue("otherNames", out JsonNode on) && on is JsonArray arr)
                foreach (JsonNode item in arr) if (item is JsonString js) otherNames.Add(js.Value);
            return await Service().Install(kind, id, otherNames).ConfigureAwait(false);
        }

        private static Task<JsonNode> LibraryRemove(JsonObject args) =>
            Task.FromResult<JsonNode>(Service().Remove(RequiredString(args, "kind"), RequiredString(args, "id")));

        private static Task<JsonNode> OpenUrl(JsonObject args)
        {
            string value = RequiredString(args, "url");
            if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? uri) ||
                (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            {
                throw new ArgumentException("only http and https URLs can be opened", nameof(args));
            }

            ShellOpen.Open(uri.AbsoluteUri);

            var result = new JsonObject();
            result["opened"] = JsonBool.True;
            return Task.FromResult<JsonNode>(result);
        }

        private static string RequiredString(JsonObject args, string key)
        {
            if (!args.TryGetValue(key, out JsonNode node) || node is not JsonString value ||
                string.IsNullOrEmpty(value.Value))
            {
                throw new ArgumentException("missing string argument: " + key, nameof(args));
            }
            return value.Value;
        }
    }
}

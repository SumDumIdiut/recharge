using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Recharge.Core.Json;

namespace Recharge.App.Library
{
    /// <summary>Where the library gets hub rows and packages from (the real hub, or a stub in tests).</summary>
    public interface IHubSource
    {
        Task<(int Status, string Body)> GetJson(string path);
        Task<byte[]> GetPackage(string path, long maxBytes);
        Task<long> DownloadToFile(string path, string dest, long maxBytes);
    }

    public sealed class RealHubSource : IHubSource
    {
        public Task<(int Status, string Body)> GetJson(string path) => Bridge.HubClient.GetAsync(path);
        public Task<byte[]> GetPackage(string path, long maxBytes) => Bridge.HubClient.GetPackageAsync(path, maxBytes);
        public Task<long> DownloadToFile(string path, string dest, long maxBytes) => Bridge.HubClient.DownloadToFileAsync(path, dest, maxBytes);
    }

    /// <summary>
    /// The library.* commands without the bridge: install / update / remove of maps, mods, skins, backgrounds and playlists, and the
    /// installed listing. Where each kind lives:
    ///   mods         [game]/Recharge/Mods/[mod id]
    ///   maps         [game]/Recharge/Mods/recharge.maps/maps/[slug]        (hub.json)
    ///   skins        [game]/Recharge/Mods/recharge.customskins/data/skins/[slug]
    ///   backgrounds  [data]/backgrounds/backgrounds/[slug]                 (the media file inside)
    ///   playlists    [data]/backgrounds/playlists/[slug]
    /// where [data] is Recharge Next's own app-data folder. Mods, maps and skins change the game's files, so they are refused while IGTAP runs.
    /// </summary>
    public sealed class LibraryService
    {
        private readonly string? _game;
        private readonly string _data;
        private readonly IHubSource _hub;
        private readonly Func<bool> _gameRunning;
        private readonly Func<DateTime> _now;

        public LibraryService(string? game, string dataDir, IHubSource hub, Func<bool>? gameRunning = null, Func<DateTime>? now = null)
        {
            _game = game;
            _data = dataDir;
            _hub = hub;
            _gameRunning = gameRunning ?? (() => game != null && GameProcess.IsRunning(game));
            _now = now ?? (() => DateTime.Now);
        }

        /// <summary>Recharge Next's app-data folder: RECHARGE_NEXT_DATA, else the user's local data dir.</summary>
        public static string DefaultDataDir()
        {
            string? forced = Environment.GetEnvironmentVariable("RECHARGE_NEXT_DATA");
            return !string.IsNullOrEmpty(forced) ? forced : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "recharge-next");
        }

        public static readonly string[] Kinds = { "maps", "mods", "skins", "backgrounds", "playlists" };

        private string ModsDir => Path.Combine(_game ?? throw new InvalidOperationException("IGTAP wasn't found"), "Recharge", "Mods");
        private string Root(string kind) => kind switch
        {
            "mods" => ModsDir,
            "maps" => Path.Combine(ModsDir, InstalledScanner.MapsModId, "maps"),
            "skins" => Path.Combine(ModsDir, InstalledScanner.SkinsModId, "data", "skins"),
            "backgrounds" => Path.Combine(_data, "backgrounds", "backgrounds"),
            _ => Path.Combine(_data, "backgrounds", "playlists"),
        };
        private string Backups(string kind) => Path.Combine(_data, "backups", kind);
        private static bool InGame(string kind) => kind == "maps" || kind == "mods" || kind == "skins";

        private void Guard(string kind, string id)
        {
            if (!Kinds.Contains(kind)) throw new ArgumentException("unknown kind: " + kind);
            if (!FolderStore.SafeId(id)) throw new ArgumentException("bad hub id");
            if (InGame(kind))
            {
                if (_game == null) throw new InvalidOperationException("IGTAP wasn't found");
                if (_gameRunning()) throw new InvalidOperationException("IGTAP is running - close the game before changing " + kind + ".");
            }
        }

        /// <summary>Installs or updates (same thing: an install over the linked folder, with a backup).</summary>
        public async Task<JsonObject> Install(string kind, string id, IReadOnlyCollection<string>? otherNames = null)
        {
            try { return await InstallCore(kind, id, otherNames).ConfigureAwait(false); }
            finally { InstalledCache.Invalidate(); } // even a failed install may have moved folders
        }

        private async Task<JsonObject> InstallCore(string kind, string id, IReadOnlyCollection<string>? otherNames)
        {
            Guard(kind, id);
            string api = "/api/" + kind + "/" + Uri.EscapeDataString(id);
            (int status, string body) = await _hub.GetJson(api).ConfigureAwait(false);
            if (status != 200 || JsonReader.Parse(body) is not JsonObject meta) throw new InvalidOperationException("the hub answered " + status);
            string name = Str(meta, "name") ?? id;
            string author = Str(meta, "author") ?? Str(meta, "uploader") ?? "";
            long revision = meta.TryGetValue("revision", out JsonNode r) && r is JsonNumber rn && long.TryParse(rn.Raw, out long rv) ? rv : 1;
            string? updatedAt = Str(meta, "updatedAt");

            string? folder, backedUp;
            if (kind == "maps")
            {
                byte[] package = await _hub.GetPackage(api + "/file", MapInstaller.MaxPackageBytes).ConfigureAwait(false);
                var done = new MapInstaller(Root(kind), Backups(kind), _now).Install(package, id, name, revision, updatedAt, otherNames);
                folder = done.Folder; backedUp = done.BackedUp;
            }
            else
            {
                var installer = new ContentInstaller(Kind(kind), Root(kind), Backups(kind), _now);
                ContentInstaller.Result done;
                if (kind == "playlists")
                {
                    string tmp = Path.Combine(Path.GetTempPath(), "recharge-playlist-" + Environment.ProcessId + "-" + Guid.NewGuid().ToString("N") + ".zip");
                    try
                    {
                        await _hub.DownloadToFile(api + "/file", tmp, installer.PackageLimit).ConfigureAwait(false);
                        using var file = new FileStream(tmp, FileMode.Open, FileAccess.Read);
                        done = installer.Install(file, id, name, revision, updatedAt, author);
                    }
                    finally { try { File.Delete(tmp); } catch { /* temp file */ } }
                }
                else
                {
                    byte[] package = await _hub.GetPackage(api + "/file", installer.PackageLimit).ConfigureAwait(false);
                    // A mod re-uploaded as a new hub entry: the folder may still carry the old entry's id. Ask the hub whether that
                    // entry is still listed; if it's gone, this entry takes the folder over.
                    Func<string, bool>? stillListed = kind == "mods"
                        ? other => { try { return _hub.GetJson("/api/mods/" + Uri.EscapeDataString(other)).GetAwaiter().GetResult().Status == 200; } catch { return true; } }
                        : null;
                    done = installer.Install(package, id, name, revision, updatedAt, author, stillListed);
                }
                folder = done.Folder; backedUp = done.BackedUp;
            }

            var result = new JsonObject();
            result["kind"] = new JsonString(kind);
            result["folder"] = new JsonString(folder);
            result["name"] = new JsonString(name);
            result["revision"] = JsonNumber.From(revision);
            result["backedUp"] = backedUp == null ? (JsonNode)JsonNull.Instance : new JsonString(backedUp);
            return result;
        }

        /// <summary>Removes the folder linked to this hub id (to the backup store). Nothing linked is an error, never a guess.</summary>
        public JsonObject Remove(string kind, string id)
        {
            try { return RemoveCore(kind, id); }
            finally { InstalledCache.Invalidate(); }
        }

        private JsonObject RemoveCore(string kind, string id)
        {
            Guard(kind, id);
            string? folder, backedUp;
            if (kind == "maps")
            {
                string? target = MapInstaller.LinkedFolder(FolderStore.Folders(Root(kind)), id, "", null);
                if (target == null) throw new InvalidOperationException("that " + kind.TrimEnd('s') + " isn't installed from the hub");
                folder = Path.GetFileName(target);
                backedUp = FolderStore.Backup(target, Backups(kind), _now);
            }
            else
            {
                var done = new ContentInstaller(Kind(kind), Root(kind), Backups(kind), _now).Remove(id)
                    ?? throw new InvalidOperationException("that " + kind.TrimEnd('s') + " isn't installed from the hub");
                folder = done.Folder; backedUp = done.BackedUp;
            }
            var result = new JsonObject();
            result["kind"] = new JsonString(kind);
            result["folder"] = new JsonString(folder);
            result["backedUp"] = backedUp == null ? (JsonNode)JsonNull.Instance : new JsonString(backedUp);
            return result;
        }

        /// <summary>
        /// Removes an installed folder by its name (to the backup store, like Remove), for content that isn't linked to the hub: a map,
        /// skin or mod you made or copied in yourself. Only a plain folder name directly inside the kind's folder.
        /// </summary>
        public JsonObject RemoveFolder(string kind, string folder)
        {
            try { return RemoveFolderCore(kind, folder); }
            finally { InstalledCache.Invalidate(); }
        }

        private JsonObject RemoveFolderCore(string kind, string folder)
        {
            if (!Kinds.Contains(kind)) throw new ArgumentException("unknown kind: " + kind);
            if (string.IsNullOrWhiteSpace(folder) || folder.Length > 200 || folder == "." || folder == ".." ||
                folder.IndexOfAny(new[] { '/', '\\', '\0' }) >= 0 || folder != folder.Trim())
                throw new ArgumentException("bad folder name");
            if (InGame(kind))
            {
                if (_game == null) throw new InvalidOperationException("IGTAP wasn't found");
                if (_gameRunning()) throw new InvalidOperationException("IGTAP is running - close the game before changing " + kind + ".");
            }
            string root = Path.GetFullPath(Root(kind));
            string target = Path.GetFullPath(Path.Combine(root, folder));
            if (Path.GetDirectoryName(target) != root.TrimEnd(Path.DirectorySeparatorChar)) throw new ArgumentException("bad folder name");
            if (!Directory.Exists(target) || (File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("that folder isn't installed");
            string backedUp = FolderStore.Backup(target, Backups(kind), _now);
            var result = new JsonObject();
            result["kind"] = new JsonString(kind);
            result["folder"] = new JsonString(folder);
            result["backedUp"] = new JsonString(backedUp);
            return result;
        }

        /// <summary>Ids of mods RechargeLoader 2 carries built in. Their folders, when present, are skipped by the loader, so an on/off switch means nothing for them.</summary>
        public static readonly string[] BuiltInModIds = { "recharge.maps", "recharge.multiplayer", "recharge.customskins", "Skins", "Skinmod" };

        /// <summary>
        /// Switches an installed mod on or off by writing "enabled" in its mod.json (the loader skips a disabled mod). <paramref name="folderOrId"/> is the
        /// mod's folder name or its id. Refused while IGTAP runs and for built-in modules; every other field in the file is kept, and the write is a temp file then a rename.
        /// </summary>
        public JsonObject SetModEnabled(string folderOrId, bool enabled)
        {
            try { return SetModEnabledCore(folderOrId, enabled); }
            finally { InstalledCache.Invalidate(); }
        }

        private JsonObject SetModEnabledCore(string folderOrId, bool enabled)
        {
            if (string.IsNullOrEmpty(folderOrId) || folderOrId.IndexOfAny(new[] { '/', '\\' }) >= 0 || folderOrId.StartsWith(".", StringComparison.Ordinal))
                throw new ArgumentException("bad mod name");
            if (_game == null) throw new InvalidOperationException("IGTAP wasn't found");
            if (_gameRunning()) throw new InvalidOperationException("IGTAP is running - close the game before changing mods.");
            string mods = ModsDir;
            string? dir = null;
            string direct = Path.Combine(mods, folderOrId);
            if (File.Exists(Path.Combine(direct, "mod.json"))) dir = direct;
            else
            {
                foreach (string d in FolderStore.Folders(mods))
                {
                    try
                    {
                        if (JsonReader.Parse(File.ReadAllText(Path.Combine(d, "mod.json"))) is JsonObject o && o.TryGetValue("id", out JsonNode idNode)
                            && idNode is JsonString ids && ids.Value == folderOrId) { dir = d; break; }
                    }
                    catch { /* not a mod folder */ }
                }
            }
            if (dir == null) throw new InvalidOperationException("that mod isn't installed");
            if ((File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("that mod isn't installed");

            string file = Path.Combine(dir, "mod.json");
            JsonObject manifest = JsonReader.Parse(File.ReadAllText(file)) as JsonObject ?? throw new InvalidOperationException("mod.json isn't a JSON object");
            string id = manifest.TryGetValue("id", out JsonNode n) && n is JsonString js ? js.Value : "";
            if (Array.IndexOf(BuiltInModIds, id) >= 0 || Array.IndexOf(BuiltInModIds, Path.GetFileName(dir)) >= 0)
                throw new InvalidOperationException("that module is built into Recharge and can't be switched off");

            manifest["enabled"] = enabled ? JsonBool.True : JsonBool.False;
            string tmp = file + ".rn-tmp";
            File.WriteAllText(tmp, JsonWriter.Write(manifest, 2) + "\n");
            File.Move(tmp, file, true);

            var result = new JsonObject();
            result["folder"] = new JsonString(Path.GetFileName(dir));
            result["id"] = new JsonString(id);
            result["enabled"] = enabled ? JsonBool.True : JsonBool.False;
            return result;
        }

        /// <summary>Everything installed: the game's mods, maps and skins (when the game is found) and the app's backgrounds and playlists.</summary>
        public JsonObject Installed()
        {
            string[] roots = _game == null
                ? new[] { Root("backgrounds"), Root("playlists") }
                : new[] { ModsDir, Root("maps"), Root("skins"), Root("backgrounds"), Root("playlists") };
            return InstalledCache.Get((_game ?? "") + "|" + _data, roots, ScanInstalled);
        }

        private JsonObject ScanInstalled()
        {
            JsonObject result = _game == null
                ? new JsonObject { ["mods"] = new JsonArray(), ["maps"] = new JsonArray(), ["skins"] = new JsonArray(), ["warnings"] = new JsonArray() }
                : InstalledScanner.Scan(ModsDir);
            result["game"] = _game == null ? JsonNull.Instance : new JsonString(_game);
            result["backgrounds"] = InstalledScanner.ScanContent(Root("backgrounds"));
            result["playlists"] = InstalledScanner.ScanContent(Root("playlists"));
            return result;
        }

        private static ContentKind Kind(string kind) => kind switch
        {
            "mods" => ContentKind.Mod,
            "skins" => ContentKind.Skin,
            "backgrounds" => ContentKind.Background,
            _ => ContentKind.Playlist,
        };

        private static string? Str(JsonObject o, string key) => o.TryGetValue(key, out JsonNode v) && v is JsonString s && s.Value.Length > 0 ? s.Value : null;
    }
}

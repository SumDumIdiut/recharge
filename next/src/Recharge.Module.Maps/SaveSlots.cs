using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Recharge.Loader.Core.Maps;
using UnityEngine;

namespace Recharge.Module.Maps;

// A session lives under persistentDataPath so the game's own SaveableObject
// methods can still receive their usual relative folder argument.
internal sealed class SaveSession
{
    public SaveEntry Entry;
    public string Folder;
    public bool Fresh;
    public bool CanCommit;
    public bool Temporary;
    public bool PublishFailed;
    public bool InGameplay;
    public string RuntimeMap;
}

internal static class SaveSlots
{
    // These keys were checked in the game's progression and reset methods.
    // Display, input, audio and Steam achievements still use the native state.
    private static readonly string[] ProgressKeys = { "OpenA2Door", "snfDemoCompleted", "UsingCheckpoints" };
    private static SaveLibrary _library;
    private static bool _started;
    private static bool _hooksSeen;
    public static SaveSession Active { get; private set; }
    public static SaveLibrary Library => _library;
    public static bool HasHooks => _hooksSeen;

    public static string NativePath(string path)
    {
        _hooksSeen = true;
        return Active == null ? path : Active.Folder + path.Substring(SaveSwap.Game.Length);
    }

    public static string PreferenceKey(string key) => Active == null ? key : Key(Active.Entry.Metadata.Id, key);

    public static void Initialize()
    {
        // Old loader installs have no native redirect. Leave their saves in
        // place until Repair has installed the matching hooks and loader.
        if (_started || !_hooksSeen) return;
        _started = true;
        try
        {
            _library = new SaveLibrary(MapPaths.GameDir);
            MigrateLegacy();
        }
        catch (Exception e)
        {
            Debug.LogWarning("[RechargeMaps] save library: " + e.Message);
        }
    }

    public static string MapId(string folder)
    {
        try
        {
            var hub = Path.Combine(MapPaths.MapsDir, folder, "hub.json");
            if (File.Exists(hub))
            {
                var id = Newtonsoft.Json.Linq.JObject.Parse(File.ReadAllText(hub))["id"]?.ToString();
                if (!string.IsNullOrWhiteSpace(id)) return "hub:" + id;
            }
        }
        catch (IOException) { }
        catch (Newtonsoft.Json.JsonException) { }
        return "local:" + folder;
    }

    public static string Revision(string folder)
    {
        try
        {
            var hub = Path.Combine(MapPaths.MapsDir, folder, "hub.json");
            if (File.Exists(hub)) return Newtonsoft.Json.Linq.JObject.Parse(File.ReadAllText(hub))["revision"]?.ToString();
        }
        catch (IOException) { }
        catch (Newtonsoft.Json.JsonException) { }
        return null;
    }

    public static SaveEntry ImportBaseGame()
    {
        var primary = SaveSwap.Full(SaveSwap.Game);
        var backup = SaveSwap.Full(SaveSwap.GameBackup);
        if (SaveSwap.IsSwapped || !SaveLibrary.HasPlayer(primary, backup))
            throw new IOException("There is no original Base Game save to import right now.");
        return Library.Create(SaveLibrary.Vanilla, SaveLibrary.BaseGame, "Base Game", null,
            primary, backup, ReadFlags(key => key));
    }

    public static bool CanImportBaseGame => !SaveSwap.IsSwapped &&
        SaveLibrary.HasPlayer(SaveSwap.Full(SaveSwap.Game), SaveSwap.Full(SaveSwap.GameBackup));

    public static SaveSession Prepare(SaveEntry entry, string runtimeMap = null)
    {
        if (runtimeMap == null ? !entry.Metadata.Matches(SaveLibrary.Vanilla, SaveLibrary.BaseGame)
            : !entry.Metadata.Matches(SaveLibrary.Custom, MapId(runtimeMap)))
            throw new IOException("This save belongs to another map.");
        var folder = "/RechargeSaveWork/" + Guid.NewGuid().ToString("N") + SaveSwap.Game;
        Library.LoadInto(entry, SaveSwap.Full(folder), SaveSwap.Full(folder + "backup"));
        return new SaveSession
        {
            Entry = entry, Folder = folder, Fresh = !SaveLibrary.HasPlayer(SaveSwap.Full(folder), SaveSwap.Full(folder + "backup")),
            CanCommit = entry.Metadata.Kind == SaveLibrary.Vanilla,
            RuntimeMap = runtimeMap,
        };
    }

    public static SaveSession PrepareTest(string runtimeMap, bool fresh)
    {
        var id = Guid.NewGuid().ToString("N");
        var folder = "/RechargeSaveWork/" + id + SaveSwap.Game;
        if (!fresh)
        {
            SaveLibrary.Copy(SaveSwap.Full(SaveSwap.Game), SaveSwap.Full(folder));
            SaveLibrary.Copy(SaveSwap.Full(SaveSwap.GameBackup), SaveSwap.Full(folder + "backup"));
        }
        return new SaveSession
        {
            Entry = new SaveEntry { Metadata = new SaveMetadata { Id = id, Kind = SaveLibrary.Custom } },
            Folder = folder, RuntimeMap = runtimeMap, Fresh = fresh, Temporary = true,
        };
    }

    public static void Activate(SaveSession session)
    {
        EndSession();
        Active = session;
        if (session == null) return;
        foreach (var key in ProgressKeys)
        {
            var scoped = PreferenceKey(key);
            if (session.Entry.Metadata.Flags != null && session.Entry.Metadata.Flags.TryGetValue(key, out int value))
                PlayerPrefs.SetInt(scoped, value);
            else PlayerPrefs.DeleteKey(scoped);
        }
    }

    public static void NativeSaveComplete()
    {
        if (Active?.Entry.Metadata.Kind == SaveLibrary.Vanilla) Commit();
    }

    public static void Commit()
    {
        var session = Active;
        if (session == null || !session.CanCommit || session.Temporary) return;
        try
        {
            var primary = SaveSwap.Full(session.Folder);
            var backup = primary + "backup";
            session.Entry.Metadata.Flags = ReadFlags(PreferenceKey);
            Library.Update(session.Entry, primary, backup);
            session.PublishFailed = false;
        }
        catch (Exception e)
        {
            // The previous published snapshot is recoverable, and the
            // working copy remains on disk if the install drive is full.
            session.PublishFailed = true;
            Debug.LogError("[RechargeMaps] couldn't publish save '" + session.Entry.Label + "': " + e.Message);
        }
    }

    public static void EndSession()
    {
        var session = Active;
        Active = null;
        if (session == null || session.PublishFailed) return;
        try
        {
            var work = Path.GetDirectoryName(SaveSwap.Full(session.Folder));
            if (Directory.Exists(work))
            {
                SaveLibrary.CheckTree(work);
                Directory.Delete(work, true);
            }
        }
        catch (Exception e) { Debug.LogWarning("[RechargeMaps] cleaning up save session: " + e.Message); }
    }

    private static string Key(string id, string key) => "RechargeSave." + id + "." + key;

    private static Dictionary<string, int> ReadFlags(Func<string, string> lookup)
    {
        var flags = new Dictionary<string, int>();
        foreach (string key in ProgressKeys)
        {
            var stored = lookup(key);
            if (PlayerPrefs.HasKey(stored)) flags[key] = PlayerPrefs.GetInt(stored);
        }
        return flags;
    }

    private static void MigrateLegacy()
    {
        var root = SaveSwap.Full(MapRules.SaveMapsRoot);
        if (!Directory.Exists(root) || !Directory.Exists(MapPaths.MapsDir)) return;
        var maps = Directory.GetDirectories(MapPaths.MapsDir)
            .Where(p => File.Exists(Path.Combine(p, "map.json")))
            .Select(Path.GetFileName).Where(id => id != "map-maker-test").ToArray();
        var saved = Library.Scan();
        foreach (var group in maps.GroupBy(MapRules.SafeName, StringComparer.OrdinalIgnoreCase))
        {
            // An installed map named Xbackup can also own that directory.
            // Leave ambiguous or uninstalled saves in place for manual import.
            if (group.Count() != 1 || maps.Any(id => string.Equals(MapRules.SafeName(id), group.Key + "backup", StringComparison.OrdinalIgnoreCase))
                || maps.Any(id => string.Equals(MapRules.SafeName(id) + "backup", group.Key, StringComparison.OrdinalIgnoreCase))) continue;
            var map = group.Single();
            var primary = Path.Combine(root, group.Key);
            var backup = primary + "backup";
            try
            {
                var legacy = "SavedataMaps/" + group.Key;
                var entry = saved.FirstOrDefault(e => e.Metadata?.LegacyFolder == legacy);
                if (!SaveLibrary.HasPlayer(primary, backup)
                    && (entry == null || (!Directory.Exists(primary) && !Directory.Exists(backup)))) continue;
                entry ??= Library.Create(SaveLibrary.Custom, MapId(map), MapDefinition.ReadName(map) ?? map, Revision(map),
                        primary, backup, legacy: legacy);
                if (!SaveLibrary.ContainsCopy(primary, Path.Combine(entry.Path, SaveLibrary.Primary))
                    || !SaveLibrary.ContainsCopy(backup, Path.Combine(entry.Path, SaveLibrary.Backup))) continue;
                // Archive on the source volume. A crash between the two
                // moves can finish the remaining half on the next launch.
                var archive = SaveSwap.Full("/RechargeLegacySaveRecovery/" + entry.Metadata.Id);
                Directory.CreateDirectory(archive);
                if (Directory.Exists(primary)) Directory.Move(primary, Path.Combine(archive, SaveLibrary.Primary));
                if (Directory.Exists(backup)) Directory.Move(backup, Path.Combine(archive, SaveLibrary.Backup));
            }
            catch (Exception e) { Debug.LogWarning("[RechargeMaps] migrating '" + map + "': " + e.Message); }
        }
    }

    // Unresolved directories stay at the old location. The player can
    // explicitly associate one with an installed map in Needs Import.
    public static IEnumerable<string> UnassignedLegacy(IEnumerable<SaveEntry> entries)
    {
        var root = SaveSwap.Full(MapRules.SaveMapsRoot);
        if (!Directory.Exists(root)) return Array.Empty<string>();
        var imported = new HashSet<string>(entries.Where(e => e.Metadata?.LegacyFolder != null)
            .Select(e => e.Metadata.LegacyFolder), StringComparer.OrdinalIgnoreCase);
        return Directory.GetDirectories(root).Where(dir => Path.GetFileName(dir) != "map-maker-test" &&
            !imported.Contains("SavedataMaps/" + Path.GetFileName(dir)) && SaveLibrary.HasPlayer(dir, null));
    }

    public static void ImportLegacy(string path, string mapId, string mapName, string revision)
    {
        if (!UnassignedLegacy(Library.Scan()).Contains(path, StringComparer.OrdinalIgnoreCase))
            throw new IOException("The legacy folder has changed. Reopen the save list.");
        var entry = Library.Create(SaveLibrary.Custom, mapId, mapName, revision,
            path, legacy: "SavedataMaps/" + Path.GetFileName(path));
        if (!SaveLibrary.ContainsCopy(path, Path.Combine(entry.Path, SaveLibrary.Primary)))
            throw new IOException("Couldn't verify the imported files. The legacy copy is still available.");
        var archive = SaveLibrary.NewRecoveryFolder(SaveSwap.Full("/RechargeLegacySaveRecovery"), entry.Label);
        Directory.Move(path, Path.Combine(archive, SaveLibrary.Primary));
    }

}

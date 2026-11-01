using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using Recharge.Loader.Core.Maps;
using Recharge.ModApi;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Recharge.Module.Maps;


// Each map keeps its own save (SavedataMaps/<map id>), so playing a map never
// changes Base Game progress and each map picks up where it was left.
//
// Loading: only ever the game's own way, as a scene starts (see SaveSwap) -
// playing a map always goes through a scene change with its save swapped in.
// Saving: while a map is active the game's Saveloader is switched off (it
// only writes /Savedata) and this saves the same objects to the map's folder,
// on the game's own rule of never mid-run, plus once as a scene change begins.
public static class MapSaves
{
    private const float AutosaveSeconds = 10f;
        private const string StartFile = "/navigator-start.json";

    // The map whose save is live in this scene (null: Base Game).
    public static string ActiveMapId { get; private set; }
    // This scene started the active map as a brand-new game.
    public static bool StartedFresh { get; private set; }

    public static string FolderFor(string mapId) => MapRules.SaveFolderFor(mapId);
    public static string ActiveFolder => ActiveMapId != null ? FolderFor(ActiveMapId) : SaveSwap.Game;

    private static string _pendingMapId;
    private static bool _pendingFresh;

    // The player this map is being played with, kept so it can still be saved once the game
    // has switched them off.
    //
    // SaveAll finds what to save with FindObjectsByType<SaveableObject>, which by default sees
    // only ACTIVE objects - but the game deactivates the player as the scene starts to change,
    // and that is exactly when the save happens. So the player was never in the list, playerdata.txt
    // was never written, HasSave() looked at that same missing file and said "never saved", and
    // the next play wiped the whole folder. Every save was therefore losing the player, which is
    // where the checkpoint they reached lives.
    private static Movement _player;

    public static void NotePlayer(Movement mv)
    {
        if (mv != null) _player = mv;
    }
    private static Movement Player => _player != null ? _player : MapUpgrades.GamePlayer();
    // The player chose "Base Game" / "B-side" from the map menu: the scene change
    // that follows carries no map, and that is the only thing that should end the
    // map. Entering a map reloads the gameplay scene twice, and that second load
    // carries no pending map either - so "no pending map" alone can't be read as
    // "left the map". Acting on it dropped the map mid-play, and the game carried
    // on with Base Game progress and no save of its own.
    public static void LeaveMap()
    {
        _leavingForBaseGame = true;
        StopGameSaving();
        ReleaseSave();
    }
    private static bool _savedForSceneChange;
    private static bool _leavingForBaseGame;

    // Mod start: whatever an earlier session left swapped goes back.
    public static void Recover() => SaveSwap.SwapOut();

    // Before a scene change into mapId: saves where we are now, then swaps the
    // map's save (or a new game) in for the next scene to load.
    public static void BeginMapScene(string mapId, JObject player, bool asNewGame = false)
    {
        SaveCurrent();
        StopGameSaving();
        var folder = FolderFor(mapId);
        if (asNewGame) Delete(mapId);
        var fresh = player != null && !MatchesStart(folder, player);
        if (fresh)
        {
            SaveSwap.DeleteFolder(folder);
            SaveSwap.DeleteFolder(folder + "backup");
        }
        else if (player == null && !SaveSwap.HasSave(folder))
        {
            // "Use the player's own save": starts from Base Game progress.
            SaveSwap.CopyFolder(SaveSwap.Game, folder);
            SaveSwap.CopyFolder(SaveSwap.GameBackup, folder + "backup");
        }
        try { SaveSwap.SwapIn(fresh ? null : folder); }
        catch (Exception e)
        {
            Debug.LogError("[RechargeMaps] couldn't swap in the map's save: " + e.Message);
            SaveSwap.SwapOut();
        }
        _pendingMapId = mapId;
        _pendingFresh = fresh;
        Debug.Log("[RechargeMaps] starting '" + mapId + "' " + (fresh ? "as a new game" : "from its save"));
    }

    public static void OnSceneLoaded(Scene scene, MonoBehaviour host)
    {
        host.CancelInvoke(nameof(MapManager.MapAutosave));
        _savedForSceneChange = false;
        _menus = null;
        // Which folder this load's Saveloader (it runs in Awake, before this event) read.
        Debug.Log("[RechargeMaps] scene '" + scene.name + "' loaded; the game read " + (SaveSwap.IsSwapped
            ? "the swapped-in copy of " + (ActiveMapId != null ? FolderFor(ActiveMapId) : _pendingMapId != null ? FolderFor(_pendingMapId) : "a map save")
            : "the REAL Base Game save") + " (" + SaveSwap.Describe(SaveSwap.Game) + ")");
        LogCourseLoadShape("scene '" + scene.name + "'", SaveSwap.Game);
        // The title scene reloads itself once at startup: the swap waits for the gameplay scene.
        if (_pendingMapId != null && scene.name == "MainMenu")
        {
            StopGameSaving();
            return;
        }
        // A scene load with nothing pending is the gameplay scene loading a second
        // time on the way into a map. Leave the map alone - it is still the one
        // being set up, and dropping it here is what left the game running on Base
        // Game progress with nowhere to save.
        if (_pendingMapId == null && !_leavingForBaseGame)
        {
            if (ActiveMapId != null)
            {
                StopGameSaving();
                // Still swapped in (the map isn't built yet): this load's Saveloader read the
                // map's own save, nothing to fix. Otherwise it read the real Base Game save.
                if (!SaveSwap.IsSwapped) ReloadActiveSave();
            }
            return;
        }
        ActiveMapId = _pendingMapId;
        StartedFresh = _pendingMapId != null && _pendingFresh;
        _pendingMapId = null;
        _leavingForBaseGame = false;
        // A new map starts with no known checkpoint, so the first one it reaches counts as a
        // change and gets saved.
        _lastRespawnPoint = null;
        _lastCheckpointSave = Time.unscaledTime;
        if (ActiveMapId != null)
        {
            // Entering a map: the map's save stays swapped in for every gameplay-scene load
            // until the map is built (ReleaseSave), so the game's own Saveloader reads the
            // map's save - or an empty one for a new game - on each of them.
            StopGameSaving();
            host.InvokeRepeating(nameof(MapManager.MapAutosave), AutosaveSeconds, AutosaveSeconds);
        }
        else
        {
            SaveSwap.SwapOut();
        }
    }

    // The map is built and running: the real Base Game save goes back. Until now the map's
    // save has been the one the game loads, whichever scene load that was.
    public static void ReleaseSave()
    {
        if (SaveSwap.IsSwapped) SaveSwap.SwapOut();
    }

    // Leaving a map by the door transition: the map is saved now, while its player is still
    // active (the scene-change check in Tick would find the player switched off).
    public static void SaveForSceneChange()
    {
        if (ActiveMapId == null || _savedForSceneChange) return;
        _savedForSceneChange = true;
        SaveAll(FolderFor(ActiveMapId));
    }

    public static void SaveCourseRun(courseScript course)
    {
        if (ActiveMapId == null || course == null || SaveSwap.IsSwapped) return;
        try { SaveObject(course, FolderFor(ActiveMapId)); }
        catch (Exception e) { Debug.LogWarning("[RechargeMaps] saving finished course " + course.courseNumber + " failed: " + e.Message); }
    }


    // The game saves a course's upgrade boxes by child position (courseScript.save lists every
    // child of its localUpgrades; courseScript.load reads them back with GetChild(i)). The map's
    // own boxes are linked in under a level course as extra children, so a save that listed them
    // asked the next load - which runs before the map is built - for children that don't exist yet
    // ("Course N Box Loading failed! Transform child out of bounds"). Those boxes keep their
    // amounts in navigator-boxes.json, so they are stepped out of the way for the game's save
    // and put back exactly as they were.
    private static void SaveObject(SaveableObject obj, string folder)
    {
        var course = obj as courseScript;
        var local = course != null ? course.localUpgradesScript : null;
        if (local == null) { obj.save(folder); return; }
        var held = new System.Collections.Generic.List<(Transform t, int index, Vector3 pos, Quaternion rot, Vector3 scale)>();
        foreach (Transform child in local.transform)
            if (child.GetComponent<MapUpgradeBox>() != null)
                held.Add((child, child.GetSiblingIndex(), child.localPosition, child.localRotation, child.localScale));
        if (held.Count == 0) { obj.save(folder); return; }
        foreach (var h in held) h.t.SetParent(null, false);
        try { obj.save(folder); }
        finally
        {
            foreach (var h in held.OrderBy(x => x.index))
            {
                if (h.t == null) continue;
                h.t.SetParent(local.transform, false);
                h.t.SetSiblingIndex(Math.Min(h.index, local.transform.childCount - 1));
                h.t.localPosition = h.pos;
                h.t.localRotation = h.rot;
                h.t.localScale = h.scale;
            }
        }
    }

    // What the game's own load is about to meet: per course, how many boxes the save lists against
    // how many children its localUpgrades has right now. A mismatch is exactly what makes the
    // game's load log "Box Loading failed" and leave the later boxes at their defaults.
    public static void LogCourseLoadShape(string where, string folder)
    {
        try
        {
            var dir = SaveSwap.Full(folder);
            foreach (var c in UnityEngine.Object.FindObjectsByType<courseScript>(FindObjectsInactive.Include, FindObjectsSortMode.None))
            {
                if (c == null || !c.gameObject.scene.IsValid() || c.localUpgradesScript == null) continue;
                var file = dir + "/course" + c.courseNumber + "data.txt";
                if (!File.Exists(file)) continue;
                int listed = -1;
                try { listed = (JObject.Parse(File.ReadAllText(file))["_boxCosts"] as JArray)?.Count ?? -1; } catch { }
                int have = c.localUpgradesScript.transform.childCount;
                if (listed != have)
                    Debug.LogWarning("[RechargeMaps] " + where + ": course " + c.courseNumber + " (" + RealAssetPalette.GetPath(c.transform) + ") - the save lists " + listed +
                                     " upgrade boxes, the scene has " + have + "; the game loads boxes by position, so the surplus ones fail to load");
            }
        }
        catch (Exception e) { Debug.LogWarning("[RechargeMaps] course load check failed: " + e.Message); }
    }

    // The scene is going: no game autosave of a player who has been switched off.
    public static void HoldGameSaving() => StopGameSaving();

    // Safety net: a gameplay scene loaded with the real save in place while a map is active
    // (a stray load after the map was released). Everything the game's Saveloader restores per
    // save and that is safe to load twice - the player and the level's courses - comes from the
    // map's folder again; a course the map has no file for starts fresh.
    private static void ReloadActiveSave()
    {
        var folder = FolderFor(ActiveMapId);
        Debug.LogWarning("[RechargeMaps] '" + ActiveMapId + "': a scene loaded with the real save in place; reloading the player and level courses from '" + folder + "'");
        var movement = MapUpgrades.GamePlayer();
        if (movement == null) return;
        if (SaveSwap.HasSave(folder))
        {
            try { movement.load(folder); }
            catch (Exception e) { Debug.LogWarning("[RechargeMaps] reloading '" + ActiveMapId + "' player: " + e.Message); }
        }
        else
        {
            try { MapUpgrades.ApplyStart(ActiveMapId, MapDefinition.Read(ActiveMapId)?.Player); }
            catch (Exception e) { Debug.LogWarning("[RechargeMaps] re-applying '" + ActiveMapId + "' start: " + e.Message); }
        }
        foreach (var course in LevelCourses())
        {
            var file = SaveSwap.Full(folder) + "/course" + course.courseNumber + "data.txt";
            try
            {
                if (!File.Exists(file)) throw new FileNotFoundException("no save for the course");
                course.load(folder);
            }
            catch { MapCourses.StartFresh(course); }
        }
        LogLevelCourses(folder);
    }

    // The level's own courses (not the map's): they are live in an overlay map.
    private static System.Collections.Generic.List<courseScript> LevelCourses()
    {
        var list = new System.Collections.Generic.List<courseScript>();
        foreach (var c in UnityEngine.Object.FindObjectsByType<courseScript>(FindObjectsInactive.Include, FindObjectsSortMode.None))
            if (c != null && c.gameObject.scene.IsValid() && c.gameObject.scene.name != "MainMenu" && !MapWorld.IsMapObject(c.transform))
                list.Add(c);
        return list;
    }

    // One line per level course: did it come from the map's save or start fresh, and its clone count.
    public static void LogLevelCourses(string folder)
    {
        foreach (var c in LevelCourses())
        {
            var has = File.Exists(SaveSwap.Full(folder) + "/course" + c.courseNumber + "data.txt");
            var clones = Reflect.TryGetField<clonesScript>(c, "clones") ?? c.GetComponentInChildren<clonesScript>(true);
            Debug.Log("[RechargeMaps] level course " + c.courseNumber + ": " + (has ? "from the map save" : "fresh (no file in the map save)") +
                      ", clones=" + (clones != null ? clones.cloneCount : -1) + ", reward=" + c.reward);
        }
    }

    // LoadMap: the map's own extras on top of the save the scene loaded.
    public static void Enter(string mapId)
    {
        if (ActiveMapId != mapId)
        {
            Debug.LogWarning("[RechargeMaps] '" + mapId + "' loaded without its save scene; progress won't be saved");
            return;
        }
        MapUpgrades.Load(FolderFor(mapId));
        LogLevelCourses(FolderFor(mapId));
    }

    // The map's start settings: a new game's marker, checked on the next play.
    public static void MarkStart(string mapId, JObject player)
    {
        var folder = SaveSwap.Full(FolderFor(mapId));
        try
        {
            Directory.CreateDirectory(folder);
            File.WriteAllText(folder + StartFile, MapUpgrades.StartMarker(player));
        }
        catch (Exception e) { Debug.LogWarning("[RechargeMaps] saving the map's start failed: " + e.Message); }
    }

    private static bool MatchesStart(string folder, JObject player)
    {
        if (!SaveSwap.HasSave(folder)) return false;
        try { return File.ReadAllText(SaveSwap.Full(folder) + StartFile) == MapUpgrades.StartMarker(player); }
        catch { return false; }
    }

    public static void Autosave()
    {
        if (ActiveMapId == null || SaveSwap.IsSwapped) return;
        var player = MapUpgrades.GamePlayer();
        if (player != null && player.courseResetPoint != Vector2.zero) return;
        StopGameSaving();
        SaveAll(FolderFor(ActiveMapId));
        _lastCheckpointSave = Time.unscaledTime;
    }

    // Touching a checkpoint is the one moment worth saving on: it is the position the player
    // expects to come back to, and the game's own autosave skips it as "mid-run", so nothing
    // else would have written it down before they closed the game.
    private static Vector2? _lastRespawnPoint;
    private static float _lastCheckpointSave = -999f;
    private const float CheckpointSaveCooldown = 3f;

    public static void CheckpointChanged(Movement mv)
    {
        if (mv == null || ActiveMapId == null || SaveSwap.IsSwapped) return;
        var at = mv.respawnPoint;
        // Null means "no checkpoint seen yet", so the map's first one counts as a change.
        if (_lastRespawnPoint != null && at == _lastRespawnPoint.Value) return;
        _lastRespawnPoint = at;
        // Debounced: a run of checkpoints in quick succession would otherwise rewrite the save
        // several times a second, and the player's own position may still be settling.
        if (Time.unscaledTime - _lastCheckpointSave < CheckpointSaveCooldown) return;
        _lastCheckpointSave = Time.unscaledTime;
        SavePlayer();
    }

    // Just the player, and written as "not in the middle of a course run".
    //
    // courseResetPoint is left alone in the live game: it is only cleared for the file. Saved
    // mid-run, it would come back on the next load and the game would send the player to the
    // start of the course on their next death, which is the opposite of resuming at the
    // checkpoint they last touched.
    private static void SavePlayer()
    {
        var player = Player;
        if (player == null) return;
        var reset = player.courseResetPoint;
        try
        {
            if (reset != Vector2.zero) player.courseResetPoint = Vector2.zero;
            SaveObject(player, FolderFor(ActiveMapId));
        }
        catch (Exception e) { Debug.LogWarning("[RechargeMaps] saving the player at the checkpoint failed: " + e.Message); }
        finally { player.courseResetPoint = reset; }
        Debug.Log("[RechargeMaps] checkpoint " + player.respawnPoint + " saved to '" + FolderFor(ActiveMapId) + "'");
    }

    // Every frame: a scene change has started (the pause menu's own save is
    // off while a map is active), so save the map before the scene goes.
    // The pause menus are found once a scene; the change-scene animation runs
    // for a good second, so checking a few times a second is plenty.
    private static pauseMenuScript[] _menus;
    private static float _nextCheck;

    public static void Tick()
    {
        if (ActiveMapId == null || _savedForSceneChange || Time.unscaledTime < _nextCheck) return;
        _nextCheck = Time.unscaledTime + 0.2f;
        if (_menus == null || Array.Exists(_menus, m => m == null)) _menus = UnityEngine.Object.FindObjectsByType<pauseMenuScript>(FindObjectsSortMode.None);
        foreach (var menu in _menus)
        {
            if (!Reflect.GetField<bool>(menu, "changingSceneNow")) continue;
            _savedForSceneChange = true;
            SaveAll(FolderFor(ActiveMapId));
            return;
        }
    }

    public static void Shutdown()
    {
        if (ActiveMapId != null) SaveAll(FolderFor(ActiveMapId));
        SaveSwap.SwapOut();
    }

    // Deletes a map's whole save; the next play starts it over.
    public static void Delete(string mapId)
    {
        SaveSwap.DeleteFolder(FolderFor(mapId));
        SaveSwap.DeleteFolder(FolderFor(mapId) + "backup");
        if (ActiveMapId == mapId) ActiveMapId = null;
    }

    // Where we are now, saved before leaving: the map, or Base Game (its own save).
    private static void SaveCurrent()
    {
        if (SaveSwap.IsSwapped) return;
        if (ActiveMapId != null) { SaveAll(FolderFor(ActiveMapId)); return; }
        if (SceneManager.GetActiveScene().name == "MainMenu") return;
        var loader = UnityEngine.Object.FindFirstObjectByType<Saveloader>();
        if (loader != null) loader.manualSave();
    }

    // Deleting the Base Game save (menu or pause menu) keeps every map's own progress in
    // SavedataMaps/<id>; a map's progress is deleted from its own row in the picker.

    private static void SaveAll(string folder)
    {
        // The map isn't built yet (its save is still swapped in): the scene holds the load, not the map.
        if (SaveSwap.IsSwapped) return;
        try
        {
            Directory.CreateDirectory(SaveSwap.Full(folder));
            Directory.CreateDirectory(SaveSwap.Full(folder) + "backup");
        }
        catch (Exception e) { Debug.LogWarning("[RechargeMaps] map save folder: " + e.Message); return; }
        MapUpgrades.Save(folder);
        var saved = new System.Collections.Generic.List<string>();
        var objects = new System.Collections.Generic.List<SaveableObject>(UnityEngine.Object.FindObjectsByType<SaveableObject>(FindObjectsSortMode.None));
        // The player is added by hand: the sweep above only sees active objects, and the game
        // switches the player off before a save on the way out, so they were never in it.
        var player = Player;
        if (player != null && !objects.Contains(player)) objects.Add(player);
        foreach (var obj in objects)
        {
            // The title scene can stay loaded beside the world with its own copies.
            if (obj == null || obj.gameObject.scene.name == "MainMenu") continue;
            try { SaveObject(obj, folder); saved.Add(obj.GetType().Name); }
            catch (Exception e) { Debug.LogWarning("[RechargeMaps] saving " + obj.GetType().Name + " failed: " + e.Message); }
        }
        // Movement writes playerdata.txt, and HasSave() looks for exactly that file: without it
        // the map reads as never saved, so every play starts over and the folder is deleted.
        // Nothing logged when it went missing, so say so loudly instead of losing a save quietly.
        bool wrotePlayer = File.Exists(SaveSwap.Full(folder) + "/playerdata.txt");
        if (!wrotePlayer)
            Debug.LogError("[RechargeMaps] NO playerdata.txt in '" + folder + "' after saving [" + string.Join(", ", saved) +
                           "] - this map's save will be treated as new next time");
    }

    // Saveloader's own saving: IsSaving gates manualSave, but its autosave() never checks
    // IsSaving - it only tests courseResetPoint - so the repeating invoke is the only thing
    // keeping it out of a map. Cancelling by name wasn't stopping it, and one stray
    // "Autosaving" writes the whole map's state over the Base Game save. Cancel everything
    // on the component instead, and keep IsSaving false so manualSave stays a no-op too.
    private static void StopGameSaving()
    {
        foreach (var loader in UnityEngine.Object.FindObjectsByType<Saveloader>(FindObjectsSortMode.None))
        {
            Reflect.TrySetField(loader, "IsSaving", false);
            loader.CancelInvoke();
        }
    }
}

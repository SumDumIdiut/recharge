using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.Tilemaps;

internal class MapManager : MonoBehaviour
{
    public static MapManager Instance { get; private set; }

    public static string CurrentMapId { get; private set; }

    public const string BaseGameEditsMapId = "_BaseGameEdits";
    public const string BSideEditsMapId = "_BSideEdits";

    private GameObject _currentCourseGo;
    private GameObject _currentOverlayGo;

    private static readonly Vector2 PocketOrigin = new Vector2(50000f, 50000f);
    private const float RealCameraOrthoSize = 550f;
    private static readonly BindingFlags NonPublicInstance = BindingFlags.NonPublic | BindingFlags.Instance;

    public static string SaveFolder => "/Savedata" + (globalStats.difficultyLevel == 1 ? "hard" : "");

    public static MapManager GetOrCreate()
    {
        if (Instance != null) return Instance;
        var go = new GameObject("MapManager");
        UnityEngine.Object.DontDestroyOnLoad(go);
        return go.AddComponent<MapManager>();
    }

    private void Awake()
    {
        if (Instance != null && Instance != this)
        {
            UnityEngine.Object.Destroy(gameObject);
            return;
        }
        Instance = this;
        UnityEngine.Object.DontDestroyOnLoad(gameObject);
        SceneManager.sceneLoaded += (scene, mode) =>
        {
            CurrentMapId = null;
            if (_currentCourseGo != null) { Destroy(_currentCourseGo); _currentCourseGo = null; }
            if (_currentOverlayGo != null) { Destroy(_currentOverlayGo); _currentOverlayGo = null; }
            RealAssetPalette.ScanCurrentScene();
            TryCaptureSpringAnimation();
            TryExportCourseSnapshot();
            if (_pendingMapId != null) StartCoroutine(LoadPendingMapWhenPlayerReady());
        };
        RealAssetPalette.ScanCurrentScene();
        TryCaptureSpringAnimation();
        TryExportCourseSnapshot();
        StartCoroutine(HeartbeatLog());
    }

    private IEnumerator HeartbeatLog()
    {
        var wait = new WaitForSeconds(10f);
        while (true)
        {
            yield return wait;
            try
            {
                RealAssetPalette.LogFullDiagnostics();
            }
            catch (Exception e)
            {
                Debug.LogWarning("[RechargeMaps] heartbeat log failed: " + e);
            }
        }
    }

    private string _pendingMapId;
    private bool _pendingMapIsOverlay;

    public void PlayMap(string mapId, pauseMenuScript menu)
    {
        if (IsOverlayMap(mapId))
        {
            _pendingMapId = mapId;
            _pendingMapIsOverlay = true;
            menu.changeSceneHard();
            return;
        }

        var playerGo = GameObject.FindGameObjectWithTag("Player");
        if (playerGo != null && playerGo.GetComponent<Movement>() != null)
        {
            LoadMap(mapId);
            return;
        }
        _pendingMapId = mapId;
        _pendingMapIsOverlay = false;
        menu.changeScene();
    }

    public static bool IsOverlayMap(string mapId)
    {
        try
        {
            var path = Path.Combine(MapPaths.MapsDir, mapId, "map.json");
            if (!File.Exists(path)) return false;
            return JsonConvert.DeserializeObject<MapDefinition>(File.ReadAllText(path))?.IsOverlay ?? false;
        }
        catch { return false; }
    }

    private IEnumerator LoadPendingMapWhenPlayerReady()
    {
        var mapId = _pendingMapId;
        var isOverlay = _pendingMapIsOverlay;
        _pendingMapId = null;
        float waited = 0f;
        while (waited < 10f)
        {
            var playerGo = GameObject.FindGameObjectWithTag("Player");
            if (playerGo != null && playerGo.GetComponent<Movement>() != null) break;
            yield return null;
            waited += Time.unscaledDeltaTime;
        }
        if (isOverlay) ApplyOverlay(mapId); else LoadMap(mapId);
    }

    public void SnapCameraToRealPlayerWhenReady(string autoApplyMapId = null)
    {
        StartCoroutine(SnapCameraToRealPlayerCoroutine(autoApplyMapId));
    }

    private IEnumerator SnapCameraToRealPlayerCoroutine(string autoApplyMapId = null)
    {
        float waited = 0f;
        GameObject playerGo = null;
        Movement movement = null;
        while (waited < 10f)
        {
            playerGo = GameObject.FindGameObjectWithTag("Player");
            movement = playerGo != null ? playerGo.GetComponent<Movement>() : null;
            if (movement != null && movement.cam != null) break;
            yield return null;
            waited += Time.unscaledDeltaTime;
        }
        if (movement == null || movement.cam == null) yield break;

        yield return null;

        var pos = (Vector2)playerGo.transform.position;
        if (Vector2.Distance(pos, PocketOrigin) < 20000f)
        {
            var start = RealAssetPalette.Get<startGate>();
            var rescuePos = start != null ? (Vector3)start.transform.position : Vector3.zero;
            playerGo.transform.position = rescuePos;
            var body = playerGo.GetComponent<Rigidbody2D>();
            if (body != null) { body.position = rescuePos; body.linearVelocity = Vector2.zero; }
            movement.respawnPoint = rescuePos;
            Debug.Log("[RechargeMaps] player was stuck in the pocket at " + pos + " - rescued to real start position " + rescuePos);
            pos = rescuePos;
        }

        movement.cam.setup(pos, RealCameraOrthoSize);
        movement.cam.newTarget(playerGo, movement.cam.defaultoffset, true, Vector2.zero);
        Debug.Log("[RechargeMaps] snapped camera back to real player at " + pos);

        if (autoApplyMapId != null && Directory.Exists(Path.Combine(MapPaths.MapsDir, autoApplyMapId)))
        {
            ApplyOverlay(autoApplyMapId);
        }
    }

    private void TryCaptureSpringAnimation()
    {
        if (RealAssetPalette.Get<SpringScript>() != null) StartCoroutine(RealAssetPalette.CaptureSpringAnimation());
    }

    private void TryExportCourseSnapshot()
    {
        var scene = SceneManager.GetActiveScene().name;
        if (scene != "Overworld" && scene != "OverworldHard") return;
        StartCoroutine(RealAssetPalette.ExportCourseSnapshot(scene));
    }

    public void LoadMap(string mapId)
    {
        try
        {
            var path = Path.Combine(MapPaths.MapsDir, mapId, "map.json");
            if (!File.Exists(path)) { Debug.LogError("[RechargeMaps] map not found: " + path); return; }

            var def = JsonConvert.DeserializeObject<MapDefinition>(File.ReadAllText(path));
            if (def?.Groups == null || def.Groups.Count == 0) { Debug.LogError("[RechargeMaps] map has no groups: " + mapId); return; }

            LoadCustomImages(mapId, def);
            SpawnGroup(mapId, def.Groups[0]);
            CurrentMapId = mapId;
        }
        catch (Exception e)
        {
            Debug.LogError("[RechargeMaps] LoadMap failed: " + e);
        }
    }

    public void ApplyOverlay(string mapId)
    {
        try
        {
            var path = Path.Combine(MapPaths.MapsDir, mapId, "map.json");
            if (!File.Exists(path)) { Debug.LogError("[RechargeMaps] overlay map not found: " + path); return; }

            var def = JsonConvert.DeserializeObject<MapDefinition>(File.ReadAllText(path));
            if (def?.Groups == null || def.Groups.Count == 0) { Debug.LogError("[RechargeMaps] overlay map has no groups: " + mapId); return; }

            if (_currentOverlayGo != null) { Destroy(_currentOverlayGo); _currentOverlayGo = null; }
            LoadCustomImages(mapId, def);

            var holder = new GameObject("RechargeMapOverlay_" + mapId);
            _currentOverlayGo = holder;

            _activeOrigin = Vector2.zero;
            try
            {
                foreach (var obj in def.Groups[0].Objects)
                {
                    var type = obj["type"]?.Value<string>();
                    switch (type)
                    {
                        case "block": SpawnBlock(obj, holder.transform); break;
                        case "blueBlock": SpawnColoredBlock(obj, holder.transform, isOrange: false); break;
                        case "orangeBlock": SpawnColoredBlock(obj, holder.transform, isOrange: true); break;
                        case "spike": SpawnSimple<spikeScript>(obj, holder.transform); break;
                        case "checkpoint": SpawnSimple<checkpointScript>(obj, holder.transform); break;
                        case "wattTile": SpawnWattTile(obj, holder.transform); break;
                        case "modifyObject": ApplyOverlayModify(obj); break;
                        default: Debug.LogWarning("[RechargeMaps] overlay: unsupported object type '" + type + "', skipped"); break;
                    }
                }
            }
            finally
            {
                _activeOrigin = null;
            }

            CurrentMapId = mapId;
            Debug.Log("[RechargeMaps] applied overlay map '" + mapId + "' onto the real scene (" + def.Groups[0].Objects.Count + " objects)");
        }
        catch (Exception e)
        {
            _activeOrigin = null;
            Debug.LogError("[RechargeMaps] ApplyOverlay failed: " + e);
        }
    }

    private void ApplyOverlayModify(JObject obj)
    {
        var objectName = obj["objectName"]?.Value<string>();
        if (string.IsNullOrEmpty(objectName) || objectName.ToLowerInvariant() == "player") return;

        GameObject found = null;
        foreach (var go in Resources.FindObjectsOfTypeAll<GameObject>())
        {
            if (go.scene.IsValid() && go.name == objectName) { found = go; break; }
        }
        if (found == null)
        {
            Debug.LogWarning("[RechargeMaps] overlay MODIFY '" + objectName + "' - no matching real object found in scene");
            return;
        }

        found.transform.position = WorldPos(obj);
        found.transform.rotation = Rot(obj);
    }

    public static void DeleteMapSave(string mapId)
    {
        var path = Application.persistentDataPath + SaveFolder + "/course" + StableCourseNumber(mapId) + "data.txt";
        try { if (File.Exists(path)) File.Delete(path); }
        catch (Exception e) { Debug.LogWarning("[RechargeMaps] delete map save failed: " + e.Message); }
    }

    private void SpawnGroup(string mapId, MapGroup group)
    {
        var courseTemplate = RealAssetPalette.Get<courseScript>();
        if (courseTemplate == null)
        {
            Debug.LogError("[RechargeMaps] no courseScript template cached yet - visit a course area first, then reopen the Maps menu");
            return;
        }

        if (_currentCourseGo != null) { Destroy(_currentCourseGo); _currentCourseGo = null; }

        var courseGo = Instantiate(courseTemplate.gameObject, PocketOrigin, Quaternion.identity);
        courseGo.name = "RechargeMap_" + mapId;
        courseGo.SetActive(true);
        _currentCourseGo = courseGo;
        var course = courseGo.GetComponent<courseScript>();

        var disableBits = courseGo.transform.Find("DisableBits");
        if (disableBits != null)
        {
            foreach (Transform child in disableBits) Destroy(child.gameObject);
        }

        course.courseNumber = StableCourseNumber(mapId);
        course.init = true;
        typeof(courseScript).GetField("isOnPauseMenu", NonPublicInstance)?.SetValue(course, false);
        try { course.load(SaveFolder); } catch (Exception e) { Debug.LogWarning("[RechargeMaps] course.load failed (expected on first play): " + e.Message); }

        foreach (var obj in group.Objects)
        {
            var type = obj["type"]?.Value<string>();
            switch (type)
            {
                case "ground": PaintTile("ground", obj, courseGo.transform); break;
                case "coloredGround": PaintColoredGround(obj, courseGo.transform); break;
                case "spike": SpawnSimple<spikeScript>(obj, courseGo.transform); break;
                case "checkpoint": SpawnSimple<checkpointScript>(obj, courseGo.transform); break;
                case "spring": SpawnSpring(obj, courseGo.transform); break;
                case "platform": SpawnPlatform(obj, courseGo.transform); break;
                case "deco": SpawnDeco(obj, courseGo.transform); break;
                case "customImage": SpawnCustomImage(obj, courseGo.transform); break;
                case "block": SpawnBlock(obj, courseGo.transform); break;
                case "blueBlock": SpawnColoredBlock(obj, courseGo.transform, isOrange: false); break;
                case "orangeBlock": SpawnColoredBlock(obj, courseGo.transform, isOrange: true); break;
                case "wattTile": SpawnWattTile(obj, courseGo.transform); break;
                case "modifyObject": SpawnModifyObject(obj, courseGo.transform); break;
                default: Debug.LogWarning("[RechargeMaps] unknown object type '" + type + "', skipped"); break;
            }
        }

        SpawnGates(group, courseGo.transform, course);
        MovePlayerIn(group);

        Debug.Log("[RechargeMaps] spawned map '" + mapId + "' (courseNumber=" + course.courseNumber + ") at pocket " + PocketOrigin);
    }

    private static int StableCourseNumber(string mapId)
    {
        uint hash = 2166136261;
        foreach (var c in mapId)
        {
            hash ^= c;
            hash *= 16777619;
        }
        return (int)(900000 + hash % 100000);
    }

    private static Vector2? _activeOrigin;

    private static Vector3 WorldPos(JObject obj)
    {
        var origin = _activeOrigin ?? PocketOrigin;
        var x = obj["x"]?.Value<float>() ?? 0f;
        var y = obj["y"]?.Value<float>() ?? 0f;
        return new Vector3(origin.x + x, origin.y + y, 0f);
    }

    public static bool IsInPocket()
    {
        return CurrentMapId != null && !IsOverlayMap(CurrentMapId);
    }

    public static Vector2 CurrentOrigin => _activeOrigin ?? (IsInPocket() ? PocketOrigin : Vector2.zero);

    private static Quaternion Rot(JObject obj)
    {
        var rotation = obj["rotation"]?.Value<float>() ?? 0f;
        return Quaternion.Euler(0f, 0f, rotation);
    }

    private void SpawnSimple<T>(JObject obj, Transform parent) where T : Component
    {
        var spawned = RealAssetPalette.Spawn<T>(WorldPos(obj), Rot(obj), parent);
        if (spawned == null) { Debug.LogWarning("[RechargeMaps] no template cached for " + typeof(T).Name + " yet - visit a course containing one first"); return; }
        ForceTriggerColliders(spawned.gameObject);
    }

    private void SpawnSpring(JObject obj, Transform parent)
    {
        var spring = RealAssetPalette.Spawn<SpringScript>(WorldPos(obj), Rot(obj), parent);
        if (spring == null) { Debug.LogWarning("[RechargeMaps] no SpringScript template cached yet"); return; }
        ForceTriggerColliders(spring.gameObject);

        if (obj["strength"] != null) SetPrivate(spring, "strength", obj["strength"].Value<float>());
        if (obj["upForce"] != null) SetPrivate(spring, "upForce", obj["upForce"].Value<float>());
    }

    private void SpawnPlatform(JObject obj, Transform parent)
    {
        var platform = RealAssetPalette.Spawn<PlatformMover>(WorldPos(obj), Rot(obj), parent);
        if (platform == null) { Debug.LogWarning("[RechargeMaps] no PlatformMover template cached yet"); return; }

        var positionsToken = obj["positions"] as JArray;
        if (positionsToken == null || positionsToken.Count == 0) return;

        var positionDataType = typeof(PlatformMover).GetNestedType("PositionData", NonPublicInstance);
        var tweenType = typeof(PlatformMover).GetNestedType("TweenType", NonPublicInstance);
        if (positionDataType == null) { Debug.LogWarning("[RechargeMaps] PlatformMover.PositionData not found via reflection"); return; }

        var positions = Array.CreateInstance(positionDataType, positionsToken.Count);
        for (int i = 0; i < positionsToken.Count; i++)
        {
            var p = (JObject)positionsToken[i];
            object boxed = Activator.CreateInstance(positionDataType);
            var x = p["x"]?.Value<float>() ?? 0f;
            var y = p["y"]?.Value<float>() ?? 0f;
            SetStructField(positionDataType, ref boxed, "position", new Vector2(x, y));
            SetStructField(positionDataType, ref boxed, "timeToReachFromPrevious", p["timeToReachFromPrevious"]?.Value<float>() ?? 0f);
            SetStructField(positionDataType, ref boxed, "autoStartNextPhase", p["autoStartNextPhase"]?.Value<bool>() ?? false);
            SetStructField(positionDataType, ref boxed, "nextPhaseOnEnter", p["nextPhaseOnEnter"]?.Value<bool>() ?? false);
            SetStructField(positionDataType, ref boxed, "nextPhaseOnExit", p["nextPhaseOnExit"]?.Value<bool>() ?? false);
            SetStructField(positionDataType, ref boxed, "waitOnPhaseEnd", p["waitOnPhaseEnd"]?.Value<float>() ?? 0f);
            if (tweenType != null)
            {
                var tweenName = p["tween"]?.Value<string>() ?? "linear";
                object tweenValue;
                try { tweenValue = Enum.Parse(tweenType, tweenName, ignoreCase: true); }
                catch { tweenValue = Enum.ToObject(tweenType, 0); }
                SetStructField(positionDataType, ref boxed, "wayToTweenTo", tweenValue);
            }
            positions.SetValue(boxed, i);
        }

        typeof(PlatformMover).GetField("Positions", NonPublicInstance)?.SetValue(platform, positions);
        var platformTypeField = typeof(PlatformMover).GetField("PlatformType", NonPublicInstance);
        if (platformTypeField != null) platformTypeField.SetValue(platform, Enum.ToObject(platformTypeField.FieldType, 0));
        platform.JumpToState(0);
    }

    private readonly Dictionary<string, Sprite> _customImageSprites = new Dictionary<string, Sprite>();

    private void LoadCustomImages(string mapId, MapDefinition def)
    {
        _customImageSprites.Clear();
        if (def.CustomImages == null) return;
        foreach (var ci in def.CustomImages)
        {
            if (string.IsNullOrEmpty(ci.AssetId) || string.IsNullOrEmpty(ci.Path)) continue;
            var path = Path.Combine(MapPaths.MapsDir, mapId, ci.Path);
            if (!File.Exists(path)) { Debug.LogWarning("[RechargeMaps] custom image file missing: " + path); continue; }
            try
            {
                var bytes = File.ReadAllBytes(path);
                var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false);
                if (!ImageConversion.LoadImage(tex, bytes)) { Debug.LogWarning("[RechargeMaps] custom image decode failed: " + path); continue; }
                var sprite = Sprite.Create(tex, new Rect(0, 0, tex.width, tex.height), new Vector2(0.5f, 0.5f), ci.PixelsPerUnit ?? 100f);
                _customImageSprites[ci.AssetId] = sprite;
            }
            catch (Exception e)
            {
                Debug.LogWarning("[RechargeMaps] custom image load failed for '" + ci.Path + "': " + e.Message);
            }
        }
    }

    private void SpawnDeco(JObject obj, Transform parent)
    {
        var name = obj["decoName"]?.Value<string>();
        var sprite = name != null ? RealAssetPalette.GetDecoSprite(name) : null;
        if (sprite == null) { Debug.LogWarning("[RechargeMaps] no deco sprite cached for '" + name + "' - visit a course with that prop first"); return; }
        SpawnSprite("Deco_" + name, sprite, obj, parent);
    }

    private void SpawnCustomImage(JObject obj, Transform parent)
    {
        var assetId = obj["assetId"]?.Value<string>();
        if (assetId == null || !_customImageSprites.TryGetValue(assetId, out var sprite))
        {
            Debug.LogWarning("[RechargeMaps] no custom image loaded for '" + assetId + "'");
            return;
        }
        SpawnSprite("CustomImage_" + assetId, sprite, obj, parent);
    }

    private void SpawnBlock(JObject obj, Transform parent)
    {
        var assetId = obj["assetId"]?.Value<string>();
        Sprite sprite = null;
        if (assetId != null) _customImageSprites.TryGetValue(assetId, out sprite);

        var go = new GameObject("MapBlock");
        go.transform.SetParent(parent, false);
        go.transform.position = WorldPos(obj);
        go.transform.rotation = Rot(obj);
        go.tag = "Ground";
        var groundLayer = LayerMask.NameToLayer("Ground");
        go.layer = groundLayer != -1 ? groundLayer : LayerMask.NameToLayer("Default");

        Vector2 size = RealAssetPalette.GroundCellSize;
        if (sprite != null)
        {
            var sr = go.AddComponent<SpriteRenderer>();
            sr.sprite = sprite;
            sr.sortingLayerID = RealAssetPalette.GroundSortingLayerID;
            sr.sortingOrder = RealAssetPalette.GroundSortingOrder;
            size = sprite.bounds.size;
        }
        var scaleX = obj["scaleX"]?.Value<float>() ?? 1f;
        var scaleY = obj["scaleY"]?.Value<float>() ?? 1f;
        go.transform.localScale = new Vector3(scaleX, scaleY, 1f);

        var box = go.AddComponent<BoxCollider2D>();
        box.size = size;
        var body = go.AddComponent<Rigidbody2D>();
        body.bodyType = RigidbodyType2D.Static;
        body.constraints = RigidbodyConstraints2D.FreezeAll;
    }

    private void SpawnColoredBlock(JObject obj, Transform parent, bool isOrange)
    {
        var go = new GameObject(isOrange ? "MapOrangeBlock" : "MapBlueBlock");
        go.transform.SetParent(parent, false);
        go.transform.position = WorldPos(obj);
        go.transform.rotation = Rot(obj);
        go.tag = "Ground";
        var groundLayer = LayerMask.NameToLayer("Ground");
        go.layer = groundLayer != -1 ? groundLayer : LayerMask.NameToLayer("Default");

        Vector2 size = RealAssetPalette.GroundCellSize;
        var tile = RealAssetPalette.GetTile(isOrange ? "orangeBlocks" : "blueBlocks", 0) as Tile;
        if (tile?.sprite != null)
        {
            var sr = go.AddComponent<SpriteRenderer>();
            sr.sprite = tile.sprite;
            sr.sortingLayerID = RealAssetPalette.GroundSortingLayerID;
            sr.sortingOrder = RealAssetPalette.GroundSortingOrder;
            size = tile.sprite.bounds.size;
        }

        var box = go.AddComponent<BoxCollider2D>();
        box.size = size;
        var body = go.AddComponent<Rigidbody2D>();
        body.bodyType = RigidbodyType2D.Static;
        body.constraints = RigidbodyConstraints2D.FreezeAll;
    }

    private void SpawnWattTile(JObject obj, Transform parent)
    {
        var assetId = obj["assetId"]?.Value<string>();
        Sprite sprite = null;
        if (assetId != null) _customImageSprites.TryGetValue(assetId, out sprite);

        var go = new GameObject("MapWattTile");
        go.transform.SetParent(parent, false);
        go.transform.position = WorldPos(obj);
        go.transform.rotation = Rot(obj);

        Vector2 size = RealAssetPalette.GroundCellSize;
        if (sprite != null)
        {
            var sr = go.AddComponent<SpriteRenderer>();
            sr.sprite = sprite;
            sr.sortingLayerID = RealAssetPalette.GroundSortingLayerID;
            sr.sortingOrder = RealAssetPalette.GroundSortingOrder;
            size = sprite.bounds.size;
        }

        var box = go.AddComponent<BoxCollider2D>();
        box.isTrigger = true;
        box.size = size;

        var trigger = go.AddComponent<MapRewardTrigger>();
        trigger.Currency = globalStats.Currencies.Cash;
        trigger.Amount = obj["amount"]?.Value<double>() ?? 1e25;
    }

    private static readonly string[] ModifyDenyKeywords =
    {
        "prestige", "globalcash", "cashperloop", "clonemult", "activeclonearea", "upgradebox",
    };

    private static readonly string[] ModifyAllowedUpgradeNames =
    {
        "dashunlock", "double jump", "wall jump", "air jump", "end demo",
    };

    private void SpawnModifyObject(JObject obj, Transform parent)
    {
        var objectName = obj["objectName"]?.Value<string>();
        if (string.IsNullOrEmpty(objectName)) return;
        var lower = objectName.ToLowerInvariant();

        if (lower.Contains("ground"))
        {
            var grid = parent.Find("Grid");
            if (grid == null)
            {
                var gridGo = new GameObject("Grid");
                gridGo.transform.SetParent(parent, false);
                var gridComp = gridGo.AddComponent<Grid>();
                gridComp.cellSize = RealAssetPalette.GroundCellSize;
                grid = gridGo.transform;
            }
            grid.position = WorldPos(obj);
            grid.rotation = Rot(obj);
            return;
        }

        if (lower == "player") return;

        foreach (var deny in ModifyDenyKeywords)
        {
            if (!lower.Contains(deny)) continue;
            bool allowed = false;
            foreach (var ok in ModifyAllowedUpgradeNames)
            {
                if (lower == ok) { allowed = true; break; }
            }
            if (!allowed)
            {
                Debug.LogWarning("[RechargeMaps] MODIFY '" + objectName + "' skipped - not safe to reposition automatically");
                return;
            }
        }

        GameObject found = null;
        foreach (var go in Resources.FindObjectsOfTypeAll<GameObject>())
        {
            if (go.scene.IsValid() && go.name == objectName) { found = go; break; }
        }
        if (found == null)
        {
            Debug.LogWarning("[RechargeMaps] MODIFY '" + objectName + "' - no matching real object found in scene");
            return;
        }

        if (found.GetComponentInChildren<Tilemap>() != null)
        {
            Debug.LogWarning("[RechargeMaps] MODIFY '" + objectName + "' - real object is a whole Tilemap, not a small fixture, skipped");
            return;
        }

        var cloneParent = found.GetComponent<upgradeBox>() != null
            ? (parent.Find("localUpgrades") ?? parent)
            : parent;

        var clone = Instantiate(found, cloneParent);
        clone.name = found.name;
        clone.transform.position = WorldPos(obj);
        clone.transform.rotation = Rot(obj);
        clone.transform.localScale = Vector3.one;
        const float maxReasonableSize = 200f;
        foreach (var renderer in clone.GetComponentsInChildren<Renderer>())
        {
            if (renderer.bounds.size.x <= maxReasonableSize && renderer.bounds.size.y <= maxReasonableSize) continue;
            Debug.LogWarning("[RechargeMaps] MODIFY '" + objectName + "' - cloned object is implausibly large (" +
                renderer.bounds.size + "), likely matched the wrong real object - discarding");
            Destroy(clone);
            return;
        }
    }

    private void SpawnSprite(string goName, Sprite sprite, JObject obj, Transform parent)
    {
        var go = new GameObject(goName);
        go.transform.SetParent(parent, false);
        go.transform.position = WorldPos(obj);
        go.transform.rotation = Rot(obj);
        var scale = obj["scale"]?.Value<float>() ?? 1f;
        go.transform.localScale = Vector3.one * scale;
        var sr = go.AddComponent<SpriteRenderer>();
        sr.sprite = sprite;
        sr.sortingLayerID = RealAssetPalette.GroundSortingLayerID;
        sr.sortingOrder = RealAssetPalette.GroundSortingOrder;
    }

    private void PaintTile(string tilemapName, JObject obj, Transform parent)
    {
        var template = RealAssetPalette.GetTilemapTemplate(tilemapName);
        if (template == null) { Debug.LogWarning("[RechargeMaps] no '" + tilemapName + "' tilemap template cached yet"); return; }

        EnsureTilemapChild(parent, tilemapName, template);
        var tilemap = parent.Find("Grid/" + tilemapName).GetComponent<Tilemap>();
        var cellX = obj["cellX"]?.Value<int>() ?? 0;
        var cellY = obj["cellY"]?.Value<int>() ?? 0;
        var tileName = obj["tileName"]?.Value<string>();
        var tile = tileName != null
            ? RealAssetPalette.GetTileByName(tilemapName, tileName)
            : RealAssetPalette.GetTile(tilemapName, obj["tileIndex"]?.Value<int>() ?? 0);
        if (tile == null) { Debug.LogWarning("[RechargeMaps] no real tile '" + (tileName ?? "#0") + "' cached for '" + tilemapName + "'"); return; }
        var cellPos = new Vector3Int(cellX, cellY, 0);
        tilemap.SetTile(cellPos, tile);
        Debug.Log("[RechargeMaps] painted " + tilemapName + " cell " + cellPos + " -> world bottomLeft=" + tilemap.CellToWorld(cellPos) + " worldCenter=" + tilemap.GetCellCenterWorld(cellPos));
    }

    private void PaintColoredGround(JObject obj, Transform parent)
    {
        var color = obj["color"]?.Value<string>() ?? "blue";
        var tilemapName = color == "orange" ? "orangeBlocks" : "blueBlocks";
        PaintTile(tilemapName, obj, parent);
        RegisterWithSwapper(parent, tilemapName, color == "orange");
    }

    private void EnsureTilemapChild(Transform parent, string name, Tilemap template)
    {
        if (parent.Find(name) != null) return;

        var gridGo = parent.Find("Grid");
        if (gridGo == null)
        {
            gridGo = new GameObject("Grid").transform;
            gridGo.SetParent(parent, false);
            var grid = gridGo.gameObject.AddComponent<Grid>();
            grid.cellSize = RealAssetPalette.GroundCellSize;
        }

        var clone = Instantiate(template.gameObject, gridGo);
        clone.name = name;
        clone.SetActive(true);
    }

    private void RegisterWithSwapper(Transform parent, string tilemapName, bool isOrange)
    {
        var swapper = Singleton<colouredBlockSwapper>.Instance;
        var tilemapGo = parent.Find("Grid/" + tilemapName)?.gameObject;
        if (swapper == null || tilemapGo == null) return;

        var fieldName = isOrange ? "orange" : "blue";
        var field = typeof(colouredBlockSwapper).GetField(fieldName, NonPublicInstance);
        if (field == null) return;

        var current = (GameObject[])field.GetValue(swapper) ?? Array.Empty<GameObject>();
        if (current.Contains(tilemapGo)) return;
        var updated = current.Concat(new[] { tilemapGo }).ToArray();
        field.SetValue(swapper, updated);
    }

    private void SpawnGates(MapGroup group, Transform courseTransform, courseScript course)
    {
        var startPos = new Vector3(PocketOrigin.x + group.StartX, PocketOrigin.y + group.StartY, 0f);
        var endPos = new Vector3(PocketOrigin.x + group.EndX, PocketOrigin.y + group.EndY, 0f);

        var start = RealAssetPalette.Spawn<startGate>(startPos, Quaternion.identity, courseTransform);
        var end = RealAssetPalette.Spawn<endGate>(endPos, Quaternion.identity, courseTransform);

        foreach (var gateGo in new[] { start != null ? start.gameObject : null, end != null ? end.gameObject : null })
        {
            if (gateGo == null) continue;
            var gateBody = gateGo.GetComponent<Rigidbody2D>();
            if (gateBody != null) gateBody.bodyType = RigidbodyType2D.Kinematic;
            foreach (var col in gateGo.GetComponents<Collider2D>()) col.isTrigger = true;
        }

        if (start != null)
        {
            var resetPointField = typeof(startGate).GetField("resetPoint", NonPublicInstance);
            if (resetPointField != null && resetPointField.GetValue(start) == null)
            {
                resetPointField.SetValue(start, start.gameObject);
            }
        }

        if (end != null)
        {
            typeof(endGate).GetField("isEndOfCourse", NonPublicInstance)?.SetValue(end, false);

            if (Vector2.Distance(startPos, endPos) < 5f)
            {
                foreach (var col in end.GetComponents<Collider2D>()) col.enabled = false;
                Debug.LogWarning("[RechargeMaps] end gate co-located with spawn (no real end position in source data) - disabled its trigger to avoid a real-game NullReferenceException");
            }
            else if (group.Reward != null && group.Reward.Amount > 0 && Enum.TryParse(group.Reward.Currency, out globalStats.Currencies currency))
            {
                var trigger = end.gameObject.AddComponent<MapRewardTrigger>();
                trigger.Currency = currency;
                trigger.Amount = group.Reward.Amount;
            }
        }

        if (start == null || end == null)
        {
            Debug.LogWarning("[RechargeMaps] no startGate/endGate template cached yet - visit a real course first");
        }
    }

    private void MovePlayerIn(MapGroup group)
    {
        var playerGo = GameObject.FindGameObjectWithTag("Player");
        var movement = playerGo != null ? playerGo.GetComponent<Movement>() : null;
        if (movement == null) { Debug.LogWarning("[RechargeMaps] no controllable Player (with Movement) in scene - start the demo first, then load a map from the pause menu"); return; }

        var spawnPos = new Vector3(PocketOrigin.x + group.StartX, PocketOrigin.y + group.StartY, 0f);
        playerGo.transform.position = spawnPos;
        var body = playerGo.GetComponent<Rigidbody2D>();
        if (body != null)
        {
            body.position = spawnPos;
            body.linearVelocity = Vector2.zero;
        }
        movement.respawnPoint = spawnPos;

        movement.lightActive = true;
        if (movement.personalLight != null) movement.personalLight.enabled = true;

        if (movement.cam != null)
        {
            movement.cam.setup(spawnPos, RealCameraOrthoSize);
            movement.cam.newTarget(playerGo, movement.cam.defaultoffset, true, Vector2.zero);
        }

        StartCoroutine(ReassertSpawnAfterDash(playerGo.transform, body, movement, spawnPos));
    }

    private IEnumerator ReassertSpawnAfterDash(Transform playerTransform, Rigidbody2D body, Movement movement, Vector3 spawnPos)
    {
        float waited = 0f;
        while (movement.dashActive && waited < 1f)
        {
            yield return null;
            waited += Time.unscaledDeltaTime;
        }
        if (playerTransform == null) yield break;

        playerTransform.position = spawnPos;
        if (body != null)
        {
            body.position = spawnPos;
            body.linearVelocity = Vector2.zero;
        }
        if (movement.cam != null)
        {
            movement.cam.setup(spawnPos, RealCameraOrthoSize);
            movement.cam.newTarget(playerTransform.gameObject, movement.cam.defaultoffset, true, Vector2.zero);
        }
    }

    private static void ForceTriggerColliders(GameObject go)
    {
        foreach (var col in go.GetComponents<Collider2D>()) col.isTrigger = true;
    }

    private static void SetPrivate(object target, string fieldName, object value)
    {
        target.GetType().GetField(fieldName, NonPublicInstance)?.SetValue(target, value);
    }

    private static void SetStructField(Type structType, ref object boxed, string fieldName, object value)
    {
        structType.GetField(fieldName, NonPublicInstance | BindingFlags.Public)?.SetValue(boxed, value);
    }
}

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEngine;
using UnityEngine.Tilemaps;

internal static class RealAssetPalette
{
    private static readonly Dictionary<Type, Component> Templates = new Dictionary<Type, Component>();
    private static readonly Dictionary<string, Tilemap> TilemapTemplates = new Dictionary<string, Tilemap>();
    private static readonly Dictionary<string, List<TileBase>> TilePalettes = new Dictionary<string, List<TileBase>>();
    private static readonly string[] TilemapNames = { "ground", "blueBlocks", "orangeBlocks" };
    private static GameObject _holder;

    public static Vector3 GroundCellSize { get; private set; } = new Vector3(32f, 32f, 1f);
    public static int GroundSortingLayerID { get; private set; }
    public static int GroundSortingOrder { get; private set; }
    private static bool _groundSortingCaptured;

    private static readonly Type[] ScanTypes =
    {
        typeof(spikeScript),
        typeof(checkpointScript),
        typeof(startGate),
        typeof(endGate),
        typeof(PlatformMover),
        typeof(SpringScript),
        typeof(courseScript),
    };

    private static GameObject Holder
    {
        get
        {
            if (_holder == null)
            {
                _holder = new GameObject("RechargeMaps_AssetTemplates");
                _holder.SetActive(false);
                UnityEngine.Object.DontDestroyOnLoad(_holder);
            }
            return _holder;
        }
    }

    public static void ScanCurrentScene()
    {
        foreach (var type in ScanTypes)
        {
            if (Templates.ContainsKey(type)) continue;
            var found = FindLiveInstance(type);
            if (found == null) continue;

            if (type == typeof(courseScript))
            {
                LogCourseScriptShape(found.transform);
            }

            var clone = UnityEngine.Object.Instantiate(found.gameObject, Holder.transform);
            clone.name = type.Name + "_Template";
            Templates[type] = clone.GetComponent(type);
            Debug.Log("[RechargeMaps] cached template for " + type.Name + " from " + GetPath(found.transform));
        }

        ScanTilemaps();
        ScanDecoProps();
        ExportComponentSprites();
        LogGroundDiagnostics();
        LogSwapperDiagnostics();
        LogPlatformMoverCount();
    }

    private static readonly (Type Type, string ExportName)[] SpriteExportTypes =
    {
        (typeof(spikeScript), "spike"),
        (typeof(startGate), "startGate"),
        (typeof(endGate), "endGate"),
        (typeof(upgradeBox), "upgradeBox"),
    };
    private static readonly HashSet<string> _spriteExported = new HashSet<string>();

    private static void ExportComponentSprites()
    {
        foreach (var (type, name) in SpriteExportTypes)
        {
            if (_spriteExported.Contains(name)) continue;
            Component comp = Templates.TryGetValue(type, out var cached) ? cached : FindLiveInstance(type);
            var sr = comp != null ? comp.GetComponentInChildren<SpriteRenderer>(true) : null;
            if (sr == null || sr.sprite == null) continue;

            var dir = Path.Combine(MapPaths.TexturesDir, name);
            Directory.CreateDirectory(dir);
            var pngPath = Path.Combine(dir, "0.png");
            if (!File.Exists(pngPath))
            {
                try
                {
                    var bytes = ExtractSpritePng(sr.sprite);
                    if (bytes != null) File.WriteAllBytes(pngPath, bytes);
                }
                catch (Exception e)
                {
                    Debug.LogWarning("[RechargeMaps] sprite export failed for '" + name + "': " + e.Message);
                    continue;
                }
            }
            File.WriteAllText(Path.Combine(dir, "manifest.json"), "[\"" + name + "\"]");
            _spriteExported.Add(name);
            Debug.Log("[RechargeMaps] exported sprite for '" + name + "'");
        }
    }

    private static readonly Dictionary<string, Sprite> DecoSprites = new Dictionary<string, Sprite>();
    private static bool _treeDecoExported;

    private static void ScanDecoProps()
    {
        if (_treeDecoExported) return;
        var tree = FindLiveInstance(typeof(TreeController)) as TreeController;
        if (tree == null) return;

        var dir = Path.Combine(MapPaths.TexturesDir, "tree");
        Directory.CreateDirectory(dir);
        var names = new List<string>();
        int i = 0;
        foreach (var sr in tree.GetComponentsInChildren<SpriteRenderer>(true))
        {
            if (sr.sprite == null || DecoSprites.ContainsKey(sr.gameObject.name)) continue;
            DecoSprites[sr.gameObject.name] = sr.sprite;
            names.Add(sr.gameObject.name);
            var pngPath = Path.Combine(dir, i + ".png");
            if (!File.Exists(pngPath))
            {
                try
                {
                    var bytes = ExtractSpritePng(sr.sprite);
                    if (bytes != null) File.WriteAllBytes(pngPath, bytes);
                }
                catch (Exception e)
                {
                    Debug.LogWarning("[RechargeMaps] tree deco export failed for '" + sr.gameObject.name + "': " + e.Message);
                }
            }
            i++;
            if (i >= 8) break;
        }
        File.WriteAllText(Path.Combine(dir, "manifest.json"), "[" + string.Join(",", names.Select(n => "\"" + n.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"")) + "]");
        _treeDecoExported = true;
        Debug.Log("[RechargeMaps] exported " + names.Count + " tree deco textures");
    }

    public static Sprite GetDecoSprite(string name)
    {
        return DecoSprites.TryGetValue(name, out var s) ? s : null;
    }

    private static void LogCourseScriptShape(Transform courseTransform)
    {
        Debug.Log("[RechargeMaps] courseScript found at " + GetPath(courseTransform) + " with " + courseTransform.childCount + " direct children:");
        foreach (Transform child in courseTransform)
        {
            var comps = child.GetComponents<Component>().Select(c => c.GetType().Name);
            Debug.Log("[RechargeMaps]   child: " + child.name + " components=[" + string.Join(",", comps) + "] grandchildren=" + child.childCount);

            if (child.name == "DisableBits")
            {
                foreach (Transform gc in child)
                {
                    var gcComps = gc.GetComponents<Component>().Select(c => c.GetType().Name);
                    Debug.Log("[RechargeMaps]     DisableBits child: " + gc.name + " components=[" + string.Join(",", gcComps) + "]");
                }
            }
        }

        var parent = courseTransform.parent;
        if (parent != null)
        {
            Debug.Log("[RechargeMaps] courseScript's parent '" + parent.name + "' has " + parent.childCount + " children (siblings of the course root):");
            foreach (Transform sib in parent)
            {
                Debug.Log("[RechargeMaps]   sibling: " + sib.name);
            }
        }
    }

    private static void ScanTilemaps()
    {
        foreach (var name in TilemapNames)
        {
            if (TilemapTemplates.ContainsKey(name)) continue;

            Tilemap found = null;
            foreach (var tm in Resources.FindObjectsOfTypeAll<Tilemap>())
            {
                if (tm.gameObject.scene.IsValid() && tm.gameObject.name == name) { found = tm; break; }
            }
            if (found == null) continue;

            if (found.layoutGrid != null) GroundCellSize = found.layoutGrid.cellSize;
            Debug.Log("[RechargeMaps] tilemap '" + name + "' cellSize=" + found.cellSize + " transform.localScale=" + found.transform.localScale + " layoutGrid.cellSize=" + (found.layoutGrid != null ? found.layoutGrid.cellSize.ToString() : "n/a"));

            if (name == "ground" && !_groundSortingCaptured)
            {
                var tmRenderer = found.GetComponent<TilemapRenderer>();
                if (tmRenderer != null)
                {
                    GroundSortingLayerID = tmRenderer.sortingLayerID;
                    GroundSortingOrder = tmRenderer.sortingOrder;
                    _groundSortingCaptured = true;
                    Debug.Log("[RechargeMaps] real ground sortingLayer=" + SortingLayer.IDToName(GroundSortingLayerID) + " sortingOrder=" + GroundSortingOrder);
                }
            }

            var tiles = new List<TileBase>();
            foreach (var t in found.GetTilesBlock(found.cellBounds))
            {
                if (t != null && !tiles.Contains(t)) tiles.Add(t);
            }
            TilePalettes[name] = tiles;
            Debug.Log("[RechargeMaps] tilemap '" + name + "' at " + GetPath(found.transform) + " has " + tiles.Count + " distinct real tiles: " + string.Join(",", tiles.Select(t => t.name)));

            var clone = UnityEngine.Object.Instantiate(found.gameObject, Holder.transform);
            clone.name = name + "_TilemapTemplate";
            var cloneTilemap = clone.GetComponent<Tilemap>();
            cloneTilemap.ClearAllTiles();
            TilemapTemplates[name] = cloneTilemap;

            ExportTileTextures(name, tiles);
            ExportTileRules(name, tiles);
        }
    }

    private static void ExportTileRules(string tilemapName, List<TileBase> tiles)
    {
        var dir = Path.Combine(MapPaths.TexturesDir, tilemapName);
        Directory.CreateDirectory(dir);
        var rulesPath = Path.Combine(dir, "rules.json");
        if (File.Exists(rulesPath)) return;

        var sb = new System.Text.StringBuilder();
        sb.Append("[");
        int ruleBearingCount = 0;
        for (int i = 0; i < tiles.Count; i++)
        {
            if (i > 0) sb.Append(",");
            var rt = tiles[i] as RuleTile;
            if (rt == null || rt.m_TilingRules == null || rt.m_TilingRules.Count == 0)
            {
                sb.Append("null");
                continue;
            }
            ruleBearingCount++;
            sb.Append("{\"rules\":[");
            for (int r = 0; r < rt.m_TilingRules.Count; r++)
            {
                if (r > 0) sb.Append(",");
                var rule = rt.m_TilingRules[r];
                sb.Append("{\"neighbors\":[");
                int count = Math.Min(rule.m_Neighbors.Count, rule.m_NeighborPositions.Count);
                for (int n = 0; n < count; n++)
                {
                    if (n > 0) sb.Append(",");
                    var pos = rule.m_NeighborPositions[n];
                    sb.Append("{\"dx\":").Append(pos.x).Append(",\"dy\":").Append(pos.y).Append(",\"cond\":").Append(rule.m_Neighbors[n]).Append("}");
                }
                sb.Append("],\"transform\":\"").Append(rule.m_RuleTransform).Append("\",\"output\":\"").Append(rule.m_Output)
                  .Append("\",\"spriteCount\":").Append(rule.m_Sprites != null ? rule.m_Sprites.Length : 0).Append("}");
            }
            sb.Append("]}");
        }
        sb.Append("]");
        File.WriteAllText(rulesPath, sb.ToString());
        Debug.Log("[RechargeMaps] exported tiling rules for '" + tilemapName + "': " + ruleBearingCount + " rule-bearing tiles of " + tiles.Count);
    }

    private static void ExportTileTextures(string tilemapName, List<TileBase> tiles)
    {
        var dir = Path.Combine(MapPaths.TexturesDir, tilemapName);
        Directory.CreateDirectory(dir);

        var names = new List<string>();
        for (int i = 0; i < tiles.Count; i++)
        {
            names.Add(tiles[i] != null ? tiles[i].name : ("tile_" + i));
            var pngPath = Path.Combine(dir, i + ".png");
            if (File.Exists(pngPath)) continue;

            var sprite = (tiles[i] as Tile)?.sprite;
            if (sprite == null) continue;

            try
            {
                var bytes = ExtractSpritePng(sprite);
                if (bytes != null) File.WriteAllBytes(pngPath, bytes);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[RechargeMaps] texture export failed for '" + names[i] + "': " + e.Message);
            }
        }

        var manifestPath = Path.Combine(dir, "manifest.json");
        var manifestJson = "[" + string.Join(",", names.Select(n => "\"" + n.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"")) + "]";
        File.WriteAllText(manifestPath, manifestJson);
    }

    private static byte[] ExtractSpritePng(Sprite sprite)
    {
        var srcTex = sprite.texture;
        var rect = sprite.textureRect;
        var rt = RenderTexture.GetTemporary(srcTex.width, srcTex.height, 0, RenderTextureFormat.ARGB32);
        var prevActive = RenderTexture.active;
        Graphics.Blit(srcTex, rt);
        RenderTexture.active = rt;
        var readable = new Texture2D((int)rect.width, (int)rect.height, TextureFormat.RGBA32, false);
        readable.ReadPixels(rect, 0, 0);
        readable.Apply();
        RenderTexture.active = prevActive;
        RenderTexture.ReleaseTemporary(rt);
        var png = readable.EncodeToPNG();
        UnityEngine.Object.Destroy(readable);
        return png;
    }

    private static bool _springFramesCaptured;

    public static IEnumerator CaptureSpringAnimation()
    {
        if (_springFramesCaptured) yield break;
        var dir = Path.Combine(MapPaths.TexturesDir, "spring");
        if (File.Exists(Path.Combine(dir, "manifest.json"))) { _springFramesCaptured = true; yield break; }

        var template = Get<SpringScript>();
        if (template == null) yield break;

        var spawnPos = new Vector3(60000f, 60000f, 0f);
        var clone = UnityEngine.Object.Instantiate(template.gameObject, spawnPos, Quaternion.identity);
        clone.SetActive(true);

        var sr = clone.GetComponentInChildren<SpriteRenderer>();
        var animField = typeof(SpringScript).GetField("anim", BindingFlags.NonPublic | BindingFlags.Instance);
        var animator = animField?.GetValue(clone.GetComponent<SpringScript>()) as Animator;

        if (sr == null || animator == null)
        {
            Debug.LogWarning("[RechargeMaps] spring animation capture: missing SpriteRenderer or Animator");
            UnityEngine.Object.Destroy(clone);
            yield break;
        }

        animator.cullingMode = AnimatorCullingMode.AlwaysAnimate;

        var frames = new List<Sprite>();
        yield return null;
        if (sr.sprite != null) frames.Add(sr.sprite);

        animator.SetTrigger("Trigger");

        float elapsed = 0f;
        while (elapsed < 2f)
        {
            yield return null;
            elapsed += Time.unscaledDeltaTime;
            if (sr.sprite != null && !frames.Contains(sr.sprite)) frames.Add(sr.sprite);
        }

        Directory.CreateDirectory(dir);
        var names = new List<string>();
        for (int i = 0; i < frames.Count; i++)
        {
            names.Add("frame_" + i);
            try
            {
                var bytes = ExtractSpritePng(frames[i]);
                if (bytes != null) File.WriteAllBytes(Path.Combine(dir, i + ".png"), bytes);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[RechargeMaps] spring frame export failed: " + e.Message);
            }
        }
        File.WriteAllText(Path.Combine(dir, "manifest.json"), "[" + string.Join(",", names.Select(n => "\"" + n + "\"")) + "]");
        Debug.Log("[RechargeMaps] captured " + frames.Count + " spring animation frames");

        UnityEngine.Object.Destroy(clone);
        _springFramesCaptured = true;
    }

    public static IEnumerator ExportCourseSnapshot(string sceneName)
    {
        var path = Path.Combine(MapPaths.SnapshotsDir, sceneName + ".json");
        if (File.Exists(path)) yield break;

        var ground = FindGroundTilemap(sceneName);
        var blue = FindSceneTilemap("blueBlocks", sceneName);
        var orange = FindSceneTilemap("orangeBlocks", sceneName);

        var sb = new System.Text.StringBuilder();
        sb.Append("{");
        sb.Append("\"groundCells\":[");
        int groundCount = 0;
        foreach (var e in AppendCells(sb, ground)) { groundCount = e; yield return null; }
        sb.Append("],\"blueCells\":[");
        int blueCount = 0;
        foreach (var e in AppendCells(sb, blue)) { blueCount = e; yield return null; }
        sb.Append("],\"orangeCells\":[");
        int orangeCount = 0;
        foreach (var e in AppendCells(sb, orange)) { orangeCount = e; yield return null; }
        sb.Append("],\"spikes\":[");
        int spikeCount = 0;
        foreach (var e in AppendPositions<spikeScript>(sb, sceneName, excludeTilemapBacked: true)) { spikeCount = e; yield return null; }
        sb.Append("],\"startGates\":[");
        int startGateCount = 0;
        foreach (var e in AppendPositions<startGate>(sb, sceneName, excludeTilemapBacked: false)) { startGateCount = e; yield return null; }
        sb.Append("],\"endGates\":[");
        int endGateCount = 0;
        foreach (var e in AppendPositions<endGate>(sb, sceneName, excludeTilemapBacked: false)) { endGateCount = e; yield return null; }
        sb.Append("],\"upgradeBoxes\":[");
        int upgradeBoxCount = 0;
        foreach (var e in AppendUpgradeBoxes(sb, sceneName)) { upgradeBoxCount = e; yield return null; }
        sb.Append("]}");

        Directory.CreateDirectory(MapPaths.SnapshotsDir);
        File.WriteAllText(path, sb.ToString());
        Debug.Log("[RechargeMaps] exported course snapshot '" + sceneName + "': ground=" + groundCount + " blue=" + blueCount + " orange=" + orangeCount +
            " spikes=" + spikeCount + " startGates=" + startGateCount + " endGates=" + endGateCount + " upgradeBoxes=" + upgradeBoxCount);
    }

    private static IEnumerable<int> AppendPositions<T>(System.Text.StringBuilder sb, string sceneName, bool excludeTilemapBacked) where T : Component
    {
        var items = Resources.FindObjectsOfTypeAll<T>()
            .Where(c => c.gameObject.scene.IsValid() && c.gameObject.scene.name == sceneName && (!excludeTilemapBacked || c.gameObject.GetComponent<Tilemap>() == null))
            .ToArray();
        for (int i = 0; i < items.Length; i++)
        {
            if (i > 0) sb.Append(",");
            var t = items[i].transform;
            sb.Append("{\"x\":").Append(t.position.x.ToString(CultureInfo.InvariantCulture))
              .Append(",\"y\":").Append(t.position.y.ToString(CultureInfo.InvariantCulture))
              .Append(",\"rotation\":").Append(t.eulerAngles.z.ToString(CultureInfo.InvariantCulture)).Append("}");
            if (i % 200 == 199) yield return i + 1;
        }
        yield return items.Length;
    }

    private static IEnumerable<int> AppendUpgradeBoxes(System.Text.StringBuilder sb, string sceneName)
    {
        var items = Resources.FindObjectsOfTypeAll<upgradeBox>()
            .Where(c => c.gameObject.scene.IsValid() && c.gameObject.scene.name == sceneName)
            .ToArray();
        for (int i = 0; i < items.Length; i++)
        {
            if (i > 0) sb.Append(",");
            var t = items[i].transform;
            sb.Append("{\"x\":").Append(t.position.x.ToString(CultureInfo.InvariantCulture))
              .Append(",\"y\":").Append(t.position.y.ToString(CultureInfo.InvariantCulture))
              .Append(",\"rotation\":").Append(t.eulerAngles.z.ToString(CultureInfo.InvariantCulture))
              .Append(",\"name\":\"").Append(EscapeJson(items[i].gameObject.name)).Append("\"}");
            if (i % 200 == 199) yield return i + 1;
        }
        yield return items.Length;
    }

    private static string EscapeJson(string s)
    {
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    private static IEnumerable<int> AppendCells(System.Text.StringBuilder sb, Tilemap tilemap)
    {
        if (tilemap == null) yield break;
        int n = 0;
        foreach (var pos in tilemap.cellBounds.allPositionsWithin)
        {
            if (!tilemap.HasTile(pos)) continue;
            var world = tilemap.GetCellCenterWorld(pos);
            if (n > 0) sb.Append(",");
            sb.Append("[").Append(world.x.ToString(CultureInfo.InvariantCulture)).Append(",").Append(world.y.ToString(CultureInfo.InvariantCulture)).Append("]");
            n++;
            if (n % 500 == 0) yield return n;
        }
        yield return n;
    }

    private static Tilemap FindSceneTilemap(string name, string sceneName)
    {
        foreach (var tm in Resources.FindObjectsOfTypeAll<Tilemap>())
        {
            if (tm.gameObject.scene.IsValid() && tm.gameObject.scene.name == sceneName && tm.gameObject.name == name) return tm;
        }
        return null;
    }

    private static readonly string[] GroundAliases = { "ground", "new awesome nikki ground" };
    private static readonly HashSet<string> GroundExcludeNames = new HashSet<string> { "blueBlocks", "orangeBlocks", "InvisibleWall", "OOB areas", "Oldground" };

    private static Tilemap FindGroundTilemap(string sceneName)
    {
        foreach (var alias in GroundAliases)
        {
            var found = FindSceneTilemap(alias, sceneName);
            if (found != null) return found;
        }

        Tilemap best = null;
        int bestCount = -1;
        foreach (var tm in Resources.FindObjectsOfTypeAll<Tilemap>())
        {
            if (!tm.gameObject.scene.IsValid() || tm.gameObject.scene.name != sceneName) continue;
            if (!tm.gameObject.activeInHierarchy) continue;
            if (tm.gameObject.tag != "Ground") continue;
            if (GroundExcludeNames.Contains(tm.gameObject.name)) continue;
            if (tm.GetComponent<TilemapCollider2D>() == null) continue;

            int count = 0;
            foreach (var pos in tm.cellBounds.allPositionsWithin)
            {
                if (tm.HasTile(pos)) count++;
            }
            if (count > bestCount) { bestCount = count; best = tm; }
        }
        if (best != null) Debug.Log("[RechargeMaps] ground tilemap fallback picked '" + GetPath(best.transform) + "' (" + bestCount + "+ cells) for scene " + sceneName);
        return best;
    }

    private static void LogPlatformMoverCount()
    {
        var all = Resources.FindObjectsOfTypeAll<PlatformMover>();
        var sceneValid = all.Count(p => p.gameObject.scene.IsValid());
        Debug.Log("[RechargeMaps] PlatformMover instances in memory: " + all.Length + " (scene-valid: " + sceneValid + ")");
    }

    private static Component FindLiveInstance(Type type)
    {
        var all = Resources.FindObjectsOfTypeAll(type);
        Component fallback = null;
        foreach (var obj in all)
        {
            var comp = obj as Component;
            if (comp == null || !comp.gameObject.scene.IsValid()) continue;
            if (comp.gameObject.GetComponent<Tilemap>() != null) continue;

            if (fallback == null) fallback = comp;

            var sr = comp.GetComponentInChildren<SpriteRenderer>();
            if (sr != null && sr.sprite != null)
            {
                var size = sr.sprite.bounds.size;
                if (size.x > GroundCellSize.x * 1.5f || size.y > GroundCellSize.y * 1.5f) continue;
            }
            return comp;
        }
        return fallback;
    }

    private static void LogGroundDiagnostics()
    {
        var grounds = GameObject.FindGameObjectsWithTag("Ground");
        Debug.Log("[RechargeMaps] found " + grounds.Length + " active Ground-tagged objects in scene " + UnityEngine.SceneManagement.SceneManager.GetActiveScene().name);
        foreach (var go in grounds.Take(5))
        {
            var col = go.GetComponent<Collider2D>();
            Debug.Log("[RechargeMaps]   ground: " + GetPath(go.transform) + " layer=" + LayerMask.LayerToName(go.layer) + " collider=" + (col != null ? col.GetType().Name : "none"));
        }
    }

    public static void LogFullDiagnostics()
    {
        var sceneName = UnityEngine.SceneManagement.SceneManager.GetActiveScene().name;
        Debug.Log("[RechargeMaps] === heartbeat: scene=" + sceneName + " time=" + Time.time.ToString("F1") + " ===");

        foreach (var tm in Resources.FindObjectsOfTypeAll<Tilemap>())
        {
            if (!tm.gameObject.scene.IsValid()) continue;
            var renderer = tm.GetComponent<TilemapRenderer>();
            Debug.Log("[RechargeMaps]   Tilemap '" + GetPath(tm.transform) + "': activeInHierarchy=" + tm.gameObject.activeInHierarchy +
                " rendererEnabled=" + (renderer != null ? renderer.enabled.ToString() : "no-renderer") +
                " sortingLayer=" + (renderer != null ? SortingLayer.IDToName(renderer.sortingLayerID) : "n/a") +
                " sortingOrder=" + (renderer != null ? renderer.sortingOrder.ToString() : "n/a") +
                " cellBounds=" + tm.cellBounds + " localPos=" + tm.transform.position);
        }

        foreach (var cam in Resources.FindObjectsOfTypeAll<Camera>())
        {
            if (!cam.gameObject.scene.IsValid()) continue;
            Debug.Log("[RechargeMaps]   Camera '" + GetPath(cam.transform) + "': enabled=" + cam.enabled +
                " activeInHierarchy=" + cam.gameObject.activeInHierarchy + " pos=" + cam.transform.position +
                " orthoSize=" + cam.orthographicSize + " depth=" + cam.depth +
                " cullingMask=" + DecodeLayerMask(cam.cullingMask) +
                " includesGround=" + ((cam.cullingMask & (1 << LayerMask.NameToLayer("Ground"))) != 0));
        }

        var grounds = GameObject.FindGameObjectsWithTag("Ground");
        Debug.Log("[RechargeMaps]   " + grounds.Length + " active Ground-tagged objects total");
        foreach (var go in grounds)
        {
            var renderer = go.GetComponent<Renderer>();
            var col = go.GetComponent<Collider2D>();
            Debug.Log("[RechargeMaps]     " + GetPath(go.transform) + " activeInHierarchy=" + go.activeInHierarchy +
                " layer=" + LayerMask.LayerToName(go.layer) +
                " renderer=" + (renderer != null ? renderer.GetType().Name + ":" + renderer.enabled : "none") +
                " collider=" + (col != null ? col.GetType().Name + ":" + col.enabled : "none"));
        }
    }

    private static string DecodeLayerMask(int mask)
    {
        var names = new List<string>();
        for (int i = 0; i < 32; i++)
        {
            if ((mask & (1 << i)) == 0) continue;
            var name = LayerMask.LayerToName(i);
            names.Add(string.IsNullOrEmpty(name) ? i.ToString() : name);
        }
        return "[" + string.Join(",", names) + "]";
    }

    private static void LogSwapperDiagnostics()
    {
        var swapper = Singleton<colouredBlockSwapper>.Instance;
        Debug.Log("[RechargeMaps] colouredBlockSwapper.Instance = " + (swapper != null ? GetPath(swapper.transform) : "null"));
    }

    public static T Get<T>() where T : Component
    {
        return Templates.TryGetValue(typeof(T), out var comp) ? (T)comp : null;
    }

    public static Tilemap GetTilemapTemplate(string name)
    {
        return TilemapTemplates.TryGetValue(name, out var tm) ? tm : null;
    }

    public static TileBase GetTile(string tilemapName, int index)
    {
        if (!TilePalettes.TryGetValue(tilemapName, out var tiles) || index < 0 || index >= tiles.Count) return null;
        return tiles[index];
    }

    public static TileBase GetTileByName(string tilemapName, string tileName)
    {
        if (!TilePalettes.TryGetValue(tilemapName, out var tiles)) return null;
        return tiles.FirstOrDefault(t => t.name == tileName);
    }

    public static T Spawn<T>(Vector3 worldPos, Quaternion rotation, Transform parent) where T : Component
    {
        var template = Get<T>();
        if (template == null) return null;
        var clone = UnityEngine.Object.Instantiate(template.gameObject, worldPos, rotation, parent);
        clone.SetActive(true);
        clone.transform.localScale = Vector3.one;
        return clone.GetComponent<T>();
    }

    public static string GetPath(Transform t)
    {
        var parts = new List<string>();
        while (t != null)
        {
            parts.Add(t.name);
            t = t.parent;
        }
        parts.Reverse();
        return string.Join("/", parts);
    }
}

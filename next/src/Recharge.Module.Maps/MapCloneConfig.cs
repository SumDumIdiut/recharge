using System;
using System.Collections.Generic;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Recharge.Module.Maps;


// The map editor's settings on a copied level object.
internal static class MapCloneConfig
{
    // The map editor's settings for a cloned object: rotation (degrees), scale
    // [x, y] (negative flips), script fields {"Type.field": value}, and a zip
    // mover's track {end: [x, y], time, backTime, width}.
    // The editor's opacity, over whatever the object's own colours are.
    public static void Fade(GameObject go, float alpha)
    {
        alpha = Mathf.Clamp01(alpha);
        foreach (var sr in go.GetComponentsInChildren<SpriteRenderer>(true)) { var c = sr.color; c.a *= alpha; sr.color = c; }
        foreach (var tm in go.GetComponentsInChildren<UnityEngine.Tilemaps.Tilemap>(true)) { var c = tm.color; c.a *= alpha; tm.color = c; }
        foreach (var tx in go.GetComponentsInChildren<TMPro.TMP_Text>(true)) tx.alpha *= alpha;
    }

    // Trigger areas are invisible in the base game; the sprite some of them carry (a checkpoint's
    // yellow vertical bars) must never be drawn in a map. Their behaviour and colliders stay.
    private static readonly string[] ZoneScripts =
    {
        "checkpointScript", "longFallColliderController", "TutorialTextTrigger", "EndCreditsTrigger",
        "FakeCreditsControlScript", "tripBreakerScript", "SceneTransitionObject",
    };

    public static void HideZoneArt(GameObject root)
    {
        if (root == null) return;
        foreach (var mb in root.GetComponentsInChildren<MonoBehaviour>(true))
        {
            if (mb == null || Array.IndexOf(ZoneScripts, mb.GetType().Name) < 0) continue;
            foreach (var sr in mb.GetComponents<SpriteRenderer>())
            {
                sr.enabled = false;
                if (sr.GetComponent<MapZoneArtKeeper>() == null) sr.gameObject.AddComponent<MapZoneArtKeeper>();
            }
        }
    }

    // A checkpoint's trigger box as the editor sized it, in world units around the object.
    private static void SizeCheckpoint(GameObject clone, JObject trig)
    {
        // A checkpoint's box, or a long-fall zone's.
        Component owner = clone.GetComponentInChildren<checkpointScript>(true);
        if (owner == null) owner = clone.GetComponentInChildren<longFallColliderController>(true);
        var box = owner != null ? owner.GetComponent<BoxCollider2D>() : null;
        if (box == null) { Debug.LogWarning("[RechargeMaps] no box trigger to size on " + clone.name); return; }
        var s = box.transform.lossyScale;
        if (Mathf.Abs(s.x) < 1e-4f || Mathf.Abs(s.y) < 1e-4f) return;
        var at = (Vector2)(clone.transform.position - box.transform.position);
        box.size = new Vector2((trig["w"]?.Value<float>() ?? 100f) / Mathf.Abs(s.x), (trig["h"]?.Value<float>() ?? 100f) / Mathf.Abs(s.y));
        box.offset = new Vector2((at.x + (trig["dx"]?.Value<float>() ?? 0f)) / s.x, (at.y + (trig["dy"]?.Value<float>() ?? 0f)) / s.y);
        // The flag (and a checkpoint's respawn point) stands at the clone's own position; the box centre is where the map says.
        var flag = MapWorld.LevelOf(clone.transform.position);
        var centre = MapWorld.LevelOf(box.bounds.center);
        Debug.Log("[Navigator] checkpoint " + clone.name + " flag at (" + flag.x.ToString("0.#") + "," + flag.y.ToString("0.#") + "), trigger " + (trig["w"]?.Value<float>() ?? 100f) + "x" + (trig["h"]?.Value<float>() ?? 100f) + " centred (" + centre.x.ToString("0.#") + "," + centre.y.ToString("0.#") + ") from offset (" + (trig["dx"]?.Value<float>() ?? 0f) + "," + (trig["dy"]?.Value<float>() ?? 0f) + ")");
    }

    public static void Apply(GameObject clone, JObject obj)
    {
        var t = clone.transform;
        if (obj["absolute"]?.Value<bool>() == true)
        {
            // Decorations: an exact world rotation and scale, whatever the copied object had.
            t.rotation = Quaternion.Euler(0f, 0f, obj["rotation"]?.Value<float>() ?? 0f);
            if (obj["scale"] is JArray abs && abs.Count == 2)
            {
                var parentScale = t.parent != null ? t.parent.lossyScale : Vector3.one;
                t.localScale = new Vector3(abs[0].Value<float>() / parentScale.x, abs[1].Value<float>() / parentScale.y, t.localScale.z);
            }
        }
        else
        {
            if (obj["rotation"] != null) t.rotation = Quaternion.Euler(0f, 0f, obj["rotation"].Value<float>()) * t.rotation;
            if (obj["scale"] is JArray sc && sc.Count == 2)
                t.localScale = new Vector3(t.localScale.x * sc[0].Value<float>(), t.localScale.y * sc[1].Value<float>(), t.localScale.z);
        }
        if (obj["tint"] is JArray tint && tint.Count >= 3)
        {
            var sr = clone.GetComponent<SpriteRenderer>();
            if (sr != null) sr.color = new Color(tint[0].Value<float>(), tint[1].Value<float>(), tint[2].Value<float>(), sr.color.a);
        }
        if (obj["alpha"] != null) Fade(clone, obj["alpha"].Value<float>());
        if (obj["trigger"] is JObject trig) SizeCheckpoint(clone, trig);
        if (obj["width"] != null)
        {
            // Stretch a tiled sprite (a wide spring) - sprite and collider together.
            var width = obj["width"].Value<float>();
            var sr = clone.GetComponent<SpriteRenderer>();
            var box = clone.GetComponent<BoxCollider2D>();
            if (sr != null)
            {
                var simple = sr.drawMode == SpriteDrawMode.Simple && sr.sprite != null;
                var old = simple ? sr.sprite.rect.width / sr.sprite.pixelsPerUnit : sr.size.x;
                var height = simple ? sr.sprite.rect.height / sr.sprite.pixelsPerUnit : sr.size.y;
                sr.drawMode = SpriteDrawMode.Tiled;
                sr.size = new Vector2(width, height);
                if (box != null && old > 0f) box.size = new Vector2(box.size.x * width / old, box.size.y);
            }
        }
        if (obj["fields"] is JObject fields)
        {
            foreach (var prop in fields.Properties())
            {
                var dot = prop.Name.LastIndexOf('.');
                if (dot <= 0) continue;
                var typeName = prop.Name.Substring(0, dot);
                var fieldName = prop.Name.Substring(dot + 1);
                foreach (var comp in clone.GetComponentsInChildren<Component>(true))
                {
                    if (comp == null || comp.GetType().Name != typeName) continue;
                    var f = comp.GetType().GetField(fieldName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                    if (f != null) f.SetValue(comp, Convert.ChangeType(prop.Value.Value<double>(), f.FieldType));
                }
            }
        }
        if (obj["zip"] is JObject zip) ApplyZip(clone, zip);
        if (obj["upgrade"] is JObject upgrade) MapUpgrades.ApplyBox(clone, upgrade);
        MapUpgrades.PrepareRefresher(clone);
    }

    /// <summary>
    /// A drawn route: dense samples of the curve as platform phases. The mover rides out along the samples and, when it moves on
    /// its own, back through the same curve reversed (it never teleports). The editor's whole-ride time is spread over the curve
    /// by leg length, so one speed carries the platform around the shape; pauses live at the route's start and end.
    /// </summary>
    private static Array ZipPathPositions(Array template, Type elemType, FieldInfo position, FieldInfo time, List<Vector2> samples, JObject zip, bool auto)
    {
        int n = samples.Count - 1;                                  // legs of the ride out (sample 0 is the platform's own start)
        var count = auto ? 2 * n : n + 1;
        var total = 0f;
        for (int i = 1; i < samples.Count; i++) total += Vector2.Distance(samples[i - 1], samples[i]);
        var ride = zip["time"]?.Value<float>() ?? 3f;
        var backTime = zip["backTime"]?.Value<float>() ?? ride;
        var speedOut = total > 0.001f ? total / ride : 0f;
        var speedBack = total > 0.001f ? total / backTime : 0f;
        var pauseStart = zip["pauseMove"]?.Value<float>() ?? 1f;
        var pauseEnd = zip["pauseReturn"]?.Value<float>() ?? 0.5f;
        var wait = elemType.GetField("waitOnPhaseEnd");
        var autoStart = elemType.GetField("autoStartNextPhase");
        var onEnter = elemType.GetField("nextPhaseOnEnter");
        var onExit = elemType.GetField("nextPhaseOnExit");
        var phases = Array.CreateInstance(elemType, count);
        for (int i = 0; i < count; i++)
        {
            Vector2 at;
            float leg;
            if (i == 0) { at = samples[0]; leg = n >= 1 && speedBack > 0f ? Vector2.Distance(samples[1], samples[0]) / speedBack : 0f; }
            else if (i <= n) { at = samples[i]; leg = speedOut > 0f ? Vector2.Distance(samples[i - 1], samples[i]) / speedOut : 0f; }
            else { at = samples[n - (i - n)]; leg = speedBack > 0f ? Vector2.Distance(samples[n - (i - n - 1)], samples[n - (i - n)]) / speedBack : 0f; }
            var box = CopyPhase(i == 0 ? template.GetValue(0) : template.GetValue(template.Length - 1), elemType);
            position.SetValue(box, at);
            time.SetValue(box, leg);
            if (auto)
            {
                if (autoStart != null) autoStart.SetValue(box, true);
                if (onEnter != null) onEnter.SetValue(box, false);
                if (onExit != null) onExit.SetValue(box, false);
                if (wait != null) wait.SetValue(box, i == 0 ? pauseStart : (i == n ? pauseEnd : 0f));
            }
            else
            {
                // On touch: every leg starts while the player stands on the platform, so the touch carries it around the whole shape.
                if (autoStart != null) autoStart.SetValue(box, false);
                if (onEnter != null) onEnter.SetValue(box, true);
                if (onExit != null) onExit.SetValue(box, false);
            }
            phases.SetValue(box, i);
        }
        return phases;
    }

    /// <summary>Every field of the position struct, as one fresh copy: the mover's own phases carry tween and other fields worth keeping.</summary>
    private static object CopyPhase(object src, Type elemType)
    {
        var box = Activator.CreateInstance(elemType);
        if (src != null)
            foreach (var f in elemType.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
                f.SetValue(box, f.GetValue(src));
        return box;
    }

    /// <summary>The drawn route's waypoints (level-unit offsets from the platform's start) as a polyline: a Catmull-Rom curve through
    /// them (sampled every half cell) when smooth, the raw drawn corners otherwise. Minus the repeated or lone points.</summary>
    private static List<Vector2> SampleZipPath(JArray path, bool smooth)
    {
        var pts = new List<Vector2>();
        foreach (var token in path)
            if (token is JArray p && p.Count == 2) pts.Add(new Vector2(p[0].Value<float>(), p[1].Value<float>()));
        var clean = new List<Vector2>();
        foreach (var pt in pts)
            if (clean.Count == 0 || Vector2.Distance(clean[clean.Count - 1], pt) > 0.5f) clean.Add(pt);
        if (clean.Count < 2) return null;
        if (!smooth || clean.Count == 2) return clean;
        Vector2 At(int i) => clean[Mathf.Clamp(i, 0, clean.Count - 1)];
        var samples = new List<Vector2>();
        for (int s = 0; s < clean.Count - 1; s++)
        {
            var p0 = At(s - 1); var p1 = At(s); var p2 = At(s + 1); var p3 = At(s + 2);
            var steps = Mathf.Max(1, Mathf.CeilToInt(Vector2.Distance(p1, p2) / 16f));
            for (int j = (s == 0 ? 0 : 1); j <= steps; j++)
            {
                var t = (float)j / steps;
                var t2 = t * t; var t3 = t2 * t;
                samples.Add(new Vector2(
                    0.5f * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
                    0.5f * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)));
            }
        }
        return samples;
    }

    /// <summary>The drawn route's track: the level's own track sprite as a copy per stretch of the route, turned and sized along the curve.</summary>
    // Drops points on a straight run (direction barely changes), keeping corners, curve bends and both ends, so a drawn route
    // becomes a few long legs instead of dozens of tiny ones.
    private static List<Vector2> SimplifyPath(List<Vector2> pts)
    {
        if (pts == null || pts.Count <= 2) return pts;
        var outp = new List<Vector2> { pts[0] };
        for (int i = 1; i < pts.Count - 1; i++)
        {
            var a = pts[i] - outp[outp.Count - 1];
            var b = pts[i + 1] - pts[i];
            float al = a.magnitude, bl = b.magnitude;
            if (al < 0.001f) continue;
            if (bl < 0.001f || Vector2.Dot(a / al, b / bl) < 0.9995f) outp.Add(pts[i]);
        }
        outp.Add(pts[pts.Count - 1]);
        return outp;
    }

    private static void BuildZipTrack(GameObject clone, List<Vector2> samples)
    {
        Transform track = null;
        SpriteRenderer trackSr = null;
        foreach (var tr in clone.GetComponentsInChildren<Transform>(true))
        {
            if (tr.name == "ZipTrack") { track = tr; trackSr = tr.GetComponent<SpriteRenderer>(); }
            else if (tr.name == "ZipNode (1)")
            {
                var last = samples[samples.Count - 1];
                var prev = samples[samples.Count - 2];
                var leg = last - prev;
                var dir = leg.magnitude > 0.001f ? leg / leg.magnitude : Vector2.up;
                tr.localPosition = last - dir * 5f;
            }
        }
        if (track == null || trackSr == null) return;
        trackSr.enabled = false;    // the straight stretch is replaced by the curve's segments
        for (int s = 1; s < samples.Count; s++)
        {
            var from = samples[s - 1];
            var to = samples[s];
            var seg = to - from;
            var len = seg.magnitude;
            if (len < 4f) continue;
            var dir = seg / len;
            var piece = UnityEngine.Object.Instantiate(track.gameObject, track.parent);
            piece.name = "ZipTrackSeg_" + s;
            var sr = piece.GetComponent<SpriteRenderer>();
            if (sr != null)
            {
                sr.enabled = true;
                sr.size = new Vector2(len + 12f, sr.size.y);
            }
            piece.transform.localPosition = from + dir * (len / 2f + 2f);
            piece.transform.localRotation = Quaternion.Euler(0f, 0f, Mathf.Atan2(dir.y, dir.x) * Mathf.Rad2Deg);
        }
    }

    private static void BuildPlatform(PlatformMover mover, JArray rects)
    {
        var sr = mover.GetComponent<SpriteRenderer>();
        var box = mover.GetComponent<BoxCollider2D>();
        if (sr == null) return;
        var scale = mover.transform.lossyScale;
        // The game's collider sits a little inside the sprite; keep that margin.
        var fit = box != null && sr.size.x > 0f && sr.size.y > 0f ? new Vector2(box.size.x / sr.size.x, box.size.y / sr.size.y) : Vector2.one;
        var tiles = new List<JArray>();
        foreach (var token in rects)
            if (token is JArray r && r.Count == 4) tiles.Add(r);
        if (tiles.Count == 0) return;
        // Tiles -> maximal rectangles, one Tiled 9-slice body each (native art renders; sliced-per-tile did not); one collider per tile.
        var cellSet = new HashSet<Vector2Int>();
        foreach (var r in tiles) cellSet.Add(new Vector2Int(Mathf.RoundToInt(r[0].Value<float>() / TileCells), Mathf.RoundToInt(r[1].Value<float>() / TileCells)));
        var used = new HashSet<Vector2Int>();
        var ordered = new List<Vector2Int>(cellSet);
        ordered.Sort((a, b) => a.y != b.y ? a.y.CompareTo(b.y) : a.x.CompareTo(b.x));
        var bodies = new List<SpriteRenderer>();
        int bodyN = 0;
        foreach (var start in ordered)
        {
            if (used.Contains(start)) continue;
            int w = 1;
            while (cellSet.Contains(new Vector2Int(start.x + w, start.y)) && !used.Contains(new Vector2Int(start.x + w, start.y))) w++;
            int h = 1;
            while (true)
            {
                bool ok = true;
                for (int i = 0; i < w; i++) { var c = new Vector2Int(start.x + i, start.y + h); if (!cellSet.Contains(c) || used.Contains(c)) { ok = false; break; } }
                if (!ok) break;
                h++;
            }
            for (int dy = 0; dy < h; dy++) for (int dx = 0; dx < w; dx++) used.Add(new Vector2Int(start.x + dx, start.y + dy));
            float rw = w * TileCells, rh = h * TileCells;
            var body = new GameObject("PlatformBody_" + bodyN++);
            body.layer = mover.gameObject.layer;
            body.tag = mover.gameObject.tag;
            body.transform.SetParent(mover.transform, false);
            body.transform.localPosition = new Vector3((start.x * TileCells + rw / 2f) / scale.x, (start.y * TileCells + rh / 2f) / scale.y, 0f);
            var art = body.AddComponent<SpriteRenderer>();
            art.sprite = sr.sprite;
            art.drawMode = sr.drawMode == SpriteDrawMode.Simple ? SpriteDrawMode.Simple : SpriteDrawMode.Tiled;
            art.size = new Vector2(rw / scale.x, rh / scale.y);
            art.sharedMaterial = sr.sharedMaterial;
            art.color = new Color(sr.color.r, sr.color.g, sr.color.b, 1f);
            art.sortingLayerID = sr.sortingLayerID;
            art.sortingOrder = sr.sortingOrder;
            bodies.Add(art);
        }
        // The game sets/fades the native sprite's colour after clone time; mirror its live RGB onto the bodies (kept opaque so the platform stays visible).
        var sync = mover.gameObject.AddComponent<MapPlatformTint>();
        sync.Source = sr;
        sync.Bodies = bodies.ToArray();
        int n = 0;
        foreach (var r in tiles)
        {
            var size = new Vector2(r[2].Value<float>() / scale.x, r[3].Value<float>() / scale.y);
            var piece = new GameObject("PlatformTile_" + n++);
            piece.layer = mover.gameObject.layer;
            piece.tag = mover.gameObject.tag;
            piece.transform.SetParent(mover.transform, false);
            piece.transform.localPosition = new Vector3((r[0].Value<float>() + r[2].Value<float>() / 2f) / scale.x, (r[1].Value<float>() + r[3].Value<float>() / 2f) / scale.y, 0f);
            var col = piece.AddComponent<BoxCollider2D>();
            col.size = Vector2.Scale(size, fit);
        }
        sr.enabled = false;
        if (box != null) box.enabled = false;
    }

    /** True when the per-tile rects fill a full solid rectangle; then the native ZipMover sprite is resized, not rebuilt. */
    private static bool RectsAreSolidRectangle(JArray rects)
    {
        var cells = new HashSet<long>();
        int minX = int.MaxValue, minY = int.MaxValue, maxX = int.MinValue, maxY = int.MinValue;
        foreach (var token in rects)
        {
            if (token is not JArray r || r.Count != 4) return false;
            if (Mathf.RoundToInt(r[2].Value<float>()) != TileCells || Mathf.RoundToInt(r[3].Value<float>()) != TileCells) return false;
            int cx = Mathf.RoundToInt(r[0].Value<float>() / TileCells), cy = Mathf.RoundToInt(r[1].Value<float>() / TileCells);
            cells.Add(((long)cx << 32) ^ (uint)cy);
            if (cx < minX) minX = cx;
            if (cx > maxX) maxX = cx;
            if (cy < minY) minY = cy;
            if (cy > maxY) maxY = cy;
        }
        long w = maxX - minX + 1, h = maxY - minY + 1;
        return cells.Count == w * h;
    }

    /** A mover tile spans this many level units (the editor emits one rect per tile). */
    private const int TileCells = 32;

    /** Third sprites cut from the zip art, cached: Sprite.Create on a texture rect, keyed so repeated platforms share one per third. */
    private static readonly Dictionary<string, Sprite> ZipThirds = new Dictionary<string, Sprite>();

    private static Sprite ZipThird(Sprite whole, int cx, int cy)
    {
        var key = whole.texture.GetInstanceID() + ":" + cx + ":" + cy;
        if (ZipThirds.TryGetValue(key, out var cached) && cached != null) return cached;
        var w = whole.rect.width / 3f;
        var h = whole.rect.height / 3f;
        var sprite = Sprite.Create(whole.texture, new Rect(whole.rect.x + cx * w, whole.rect.y + (2 - cy) * h, w, h), new Vector2(0.5f, 0.5f), whole.pixelsPerUnit);
        ZipThirds[key] = sprite;
        return sprite;
    }

    private static void ApplyZip(GameObject clone, JObject zip)
    {
        var mover = clone.GetComponentInChildren<PlatformMover>(true);
        if (mover == null) return;
        var endArr = zip["end"] as JArray;
        var end = endArr != null && endArr.Count == 2 ? new Vector2(endArr[0].Value<float>(), endArr[1].Value<float>()) : Vector2.zero;
        // Positions is an array of a private struct: edit boxed copies, write them back.
        var posField = typeof(PlatformMover).GetField("Positions", BindingFlags.Instance | BindingFlags.NonPublic);
        List<Vector2> drawnSamples = null;
        if (posField?.GetValue(mover) is Array positions && positions.Length >= 2)
        {
            var elemType = positions.GetType().GetElementType();
            var position = elemType.GetField("position");
            var time = elemType.GetField("timeToReachFromPrevious");
            var auto = zip["auto"]?.Value<bool>() == true;
            if (zip["path"] is JArray pathArr && pathArr.Count >= 2 && pathArr[0] is JArray)
            {
                // A drawn route: dense curve samples, simplified so straight runs are one long phase/segment (dense phases make the
                // native mover ease in/out dozens of times = jitter, and sub-24-unit track pieces get skipped = no visible track).
                drawnSamples = SimplifyPath(SampleZipPath(pathArr, zip["smooth"]?.Value<bool>() ?? true));
                if (drawnSamples == null) drawnSamples = new List<Vector2>();
                if (drawnSamples.Count >= 2) posField.SetValue(mover, ZipPathPositions(positions, elemType, position, time, drawnSamples, zip, auto));
            }
            else
            {
                var last = positions.GetValue(positions.Length - 1);
                position.SetValue(last, end);
                if (zip["time"] != null) time.SetValue(last, zip["time"].Value<float>());
                positions.SetValue(last, positions.Length - 1);
                var first = positions.GetValue(0);
                if (zip["backTime"] != null) time.SetValue(first, zip["backTime"].Value<float>());
                positions.SetValue(first, 0);
                if (auto)
                {
                    // Moving on its own: every phase starts the next once its pause is
                    // over, and touching it no longer matters.
                    var wait = elemType.GetField("waitOnPhaseEnd");
                    for (int i = 0; i < positions.Length; i++)
                    {
                        var phase = positions.GetValue(i);
                        elemType.GetField("autoStartNextPhase").SetValue(phase, true);
                        elemType.GetField("nextPhaseOnEnter").SetValue(phase, false);
                        elemType.GetField("nextPhaseOnExit").SetValue(phase, false);
                        if (i == positions.Length - 1) wait.SetValue(phase, zip["pauseReturn"]?.Value<float>() ?? 0.5f);
                        if (i == 0) wait.SetValue(phase, zip["pauseMove"]?.Value<float>() ?? 1f);
                        positions.SetValue(phase, i);
                    }
                }
            }
            if (auto) mover.gameObject.AddComponent<MapZipAutoStart>().FirstPause = zip["pauseMove"]?.Value<float>() ?? 1f;
        }
        if (drawnSamples != null)
        {
            // The track is a child copy per stretch of the drawn route, so it follows the curves; the node sits at the route's end.
            BuildZipTrack(clone, drawnSamples);
        }
        else
        {
            // The straight track and its end node follow the new path.
            var len = end.magnitude;
            var dir = len > 0.001f ? end / len : Vector2.up;
            foreach (var tr in clone.GetComponentsInChildren<Transform>(true))
            {
                if (tr.name == "ZipTrack")
                {
                    tr.localPosition = end / 2f + dir * 5f;
                    tr.localRotation = Quaternion.Euler(0f, 0f, Mathf.Atan2(dir.y, dir.x) * Mathf.Rad2Deg);
                    var sr = tr.GetComponent<SpriteRenderer>();
                    if (sr != null) sr.size = new Vector2(len + 30f, sr.size.y);
                }
                else if (tr.name == "ZipNode (1)") tr.localPosition = end - dir * 5f;
            }
        }
        // An irregular (non-rectangular) platform: rebuild it from per-tile slices. A plain rectangle keeps the native
        // ZipMover sprite (its cogs and movement) and is just resized below, which is smooth and correctly sized.
        if (zip["rects"] is JArray rects && rects.Count > 0 && !RectsAreSolidRectangle(rects))
        {
            BuildPlatform(mover, rects);
            return;
        }
        // The platform's size: the game shapes it to its track (tall across a
        // level one, flat across an upright or diagonal one) rather than turning it.
        if (zip["size"] is JArray sizeArr && sizeArr.Count == 2)
        {
            var size = new Vector2(sizeArr[0].Value<float>(), sizeArr[1].Value<float>());
            var sr = mover.GetComponent<SpriteRenderer>();
            var box = mover.GetComponent<BoxCollider2D>();
            if (sr != null)
            {
                var old = sr.size;
                sr.size = size;
                if (box != null && old.x > 0f && old.y > 0f) box.size = new Vector2(box.size.x * size.x / old.x, box.size.y * size.y / old.y);
            }
        }
        else if (zip["width"] != null)
        {
            var width = zip["width"].Value<float>();
            var sr = mover.GetComponent<SpriteRenderer>();
            var box = mover.GetComponent<BoxCollider2D>();
            if (sr != null)
            {
                var old = sr.size.x;
                sr.size = new Vector2(width, sr.size.y);
                if (box != null && old > 0f) box.size = new Vector2(box.size.x * width / old, box.size.y);
            }
        }
    }
}

// Starts a self-moving zip mover's loop. The game only ever starts a zip
// mover's first move from a touch, and resets it whenever its zone is
// switched off and on again, so this starts it on every enable.
internal class MapZipAutoStart : MonoBehaviour
{
    public float FirstPause = 1f;
    private static readonly MethodInfo Advance = typeof(PlatformMover).GetMethod("IE_AdvanceToNextState", BindingFlags.Instance | BindingFlags.NonPublic);
    private bool _started;

    private void OnEnable() => StartCoroutine(Kick());
    private void OnDisable() => _started = false;

    private System.Collections.IEnumerator Kick()
    {
        while (!_started && (!globalStats.globalUpgradeDict.TryGetValue(globalStats.globalUpgradeSet.zipMoversUnlocked, out var unlocked) || unlocked == 0))
            yield return null;
        if (_started) yield break;
        _started = true;
        // PlatformMover.OnEnable jumps back to its start over a couple of physics steps.
        for (int i = 0; i < 3; i++) yield return new WaitForFixedUpdate();
        if (FirstPause > 0f) yield return new WaitForSeconds(FirstPause);
        var mover = GetComponent<PlatformMover>();
        if (mover == null || Advance == null || Recharge.ModApi.Reflect.GetField<bool>(mover, "isPhaseChangeInProgess")) yield break;
        mover.StartCoroutine((System.Collections.IEnumerator)Advance.Invoke(mover, null));
    }
}

// Keeps a trigger area's sprite off even if the game's own scripts or animations switch it on.
internal class MapZoneArtKeeper : MonoBehaviour
{
    private SpriteRenderer _sr;
    private void Awake() => _sr = GetComponent<SpriteRenderer>();
    private void LateUpdate() { if (_sr != null && _sr.enabled) _sr.enabled = false; }
}

// Mirrors the native platform sprite's live RGB onto the custom-shape bodies, forced opaque so a custom zip
// stays visible even when the game sets or fades the original's colour (and alpha) after clone time.
internal class MapPlatformTint : MonoBehaviour
{
    public SpriteRenderer Source;
    public SpriteRenderer[] Bodies;
    private void LateUpdate()
    {
        if (Source == null || Bodies == null) return;
        var c = Source.color;
        for (int i = 0; i < Bodies.Length; i++)
            if (Bodies[i] != null) Bodies[i].color = new Color(c.r, c.g, c.b, 1f);
    }
}

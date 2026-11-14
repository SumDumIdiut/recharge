using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Recharge.Module.Maps;

internal enum NodePType { Num, Bool, Str }
internal enum NodeBMode { OneShot, ApplyUndo, PerFrame }

internal sealed class NodePSpec
{
    public readonly string Key; public readonly NodePType Type; public readonly float Min, Max; public readonly object Def;
    public NodePSpec(string key, NodePType type, object def, float min = float.NaN, float max = float.NaN) { Key = key; Type = type; Def = def; Min = min; Max = max; }
}

internal sealed class NodeBDef
{
    public readonly string Id; public readonly NodeBMode Mode; public readonly NodePSpec[] Params;
    public NodeBDef(string id, NodeBMode mode, NodePSpec[] p) { Id = id; Mode = mode; Params = p; }
}

// The behaviour registry (mirrors ui-src/amp/nodes/behaviors.ts) + the implementations, ported from MapGroupTrigger.
// A node file may only compose these named effects; params are clamped; an unknown id is skipped at parse time.
internal static class NodeBehaviors
{
    private static NodePSpec N(string k, float def, float min = float.NaN, float max = float.NaN) => new NodePSpec(k, NodePType.Num, def, min, max);
    private static NodePSpec B(string k) => new NodePSpec(k, NodePType.Bool, false);
    private static NodePSpec S(string k, string def = "") => new NodePSpec(k, NodePType.Str, def);

    public static readonly Dictionary<string, NodeBDef> Registry = new NodeBDef[]
    {
        new NodeBDef("setVelocity", NodeBMode.OneShot, new[] { N("vx", 0, -5000, 5000), N("vy", 0, -5000, 5000) }),
        new NodeBDef("wind", NodeBMode.PerFrame, new[] { N("vx", 0, -5000, 5000), N("vy", 0, -5000, 5000) }),
        new NodeBDef("scaleStats", NodeBMode.ApplyUndo, new[] { N("speed", 1, 0, 10), N("jump", 1, 0, 10), N("gravity", 1, 0, 10), N("dash", 1, 0, 10) }),
        new NodeBDef("setAbilities", NodeBMode.OneShot, new[] { B("setJumps"), N("airJumps", 1, 0, 20), B("setDashes"), N("airDashes", 1, 0, 20), B("giveDash"), B("giveDoubleJump"), B("giveWallJump") }),
        new NodeBDef("refill", NodeBMode.OneShot, System.Array.Empty<NodePSpec>()),
        new NodeBDef("moveGroup", NodeBMode.OneShot, new[] { S("group"), N("dx", 0, -99999, 99999), N("dy", 0, -99999, 99999), N("time", 1, 0, 600), B("back") }),
        new NodeBDef("showGroup", NodeBMode.OneShot, new[] { S("group") }),
        new NodeBDef("hideGroup", NodeBMode.OneShot, new[] { S("group") }),
        new NodeBDef("toggleGroup", NodeBMode.OneShot, new[] { S("group") }),
        new NodeBDef("swapBlocks", NodeBMode.OneShot, System.Array.Empty<NodePSpec>()),
        new NodeBDef("teleport", NodeBMode.OneShot, new[] { N("tx", 0, -99999, 99999), N("ty", 0, -99999, 99999) }),
        new NodeBDef("setRespawn", NodeBMode.OneShot, new[] { N("tx", 0, -99999, 99999), N("ty", 0, -99999, 99999) }),
        new NodeBDef("kill", NodeBMode.OneShot, System.Array.Empty<NodePSpec>()),
        new NodeBDef("zoom", NodeBMode.ApplyUndo, new[] { N("size", 1.5f, 0.1f, 10) }),
        new NodeBDef("slowmo", NodeBMode.ApplyUndo, new[] { N("timeScale", 0.5f, 0.05f, 10) }),
        new NodeBDef("message", NodeBMode.OneShot, new[] { S("text", "Hello!"), N("seconds", 3, 0.5f, 600) }),
        new NodeBDef("playMusic", NodeBMode.OneShot, new[] { S("music") }),
        new NodeBDef("playSfx", NodeBMode.OneShot, new[] { S("sound"), N("volume", 1, 0, 1) }),
    }.ToDictionary(d => d.Id);

    public static bool Known(string id) => id != null && Registry.ContainsKey(id);

    public static float Clamp(NodePSpec s, float v)
    {
        if (!float.IsNaN(s.Min) && v < s.Min) v = s.Min;
        if (!float.IsNaN(s.Max) && v > s.Max) v = s.Max;
        return v;
    }

    private static float F(IDictionary<string, object> p, string k) => p.TryGetValue(k, out var v) && v is float f ? f : 0f;
    private static bool Bv(IDictionary<string, object> p, string k) => p.TryGetValue(k, out var v) && v is bool b && b;
    private static string Sv(IDictionary<string, object> p, string k) => p.TryGetValue(k, out var v) && v is string s ? s : "";
    private static int Iv(IDictionary<string, object> p, string k) => Mathf.RoundToInt(F(p, k));

    // ---- one-shot behaviours ----
    public static void Run(string id, NodeRuntime rt, Movement mv, MapWorld world, IDictionary<string, object> p)
    {
        switch (id)
        {
            case "setVelocity": { var body = mv != null ? mv.GetComponent<Rigidbody2D>() : null; if (body != null) body.linearVelocity = new Vector2(F(p, "vx"), F(p, "vy")); break; }
            case "setAbilities": SetAbilities(mv, p); break;
            case "refill": if (mv != null) { MoveStat.SetInt(mv, "airJumpsLeft", MoveStat.GetInt(mv, "maxAirJumps", 0)); MoveStat.SetInt(mv, "airDashesLeft", MoveStat.GetInt(mv, "maxAirDashes", 0)); } break;
            case "moveGroup": if (rt != null) rt.StartCoroutine(Slide(MapGroups.Members(world, Sv(p, "group")), new Vector2(F(p, "dx"), F(p, "dy")), F(p, "time"))); break;
            case "showGroup": SetGroup(world, Sv(p, "group"), _ => true); break;
            case "hideGroup": SetGroup(world, Sv(p, "group"), _ => false); break;
            case "toggleGroup": SetGroup(world, Sv(p, "group"), go => !go.activeSelf); break;
            case "swapBlocks": if (mv != null) mv.swapBlocks(); break;
            case "teleport": Teleport(mv, world, F(p, "tx"), F(p, "ty")); break;
            case "setRespawn": if (mv != null) mv.respawnPoint = world.LevelPoint(F(p, "tx"), F(p, "ty")) + new Vector2(0f, 12f); break;
            case "message": MapMessage.Show(Sv(p, "text"), F(p, "seconds")); break;
            case "playMusic": { var m = Sv(p, "music"); if (!string.IsNullOrEmpty(m)) MapMedia.PlayMusic(new JValue(m)); break; }
            case "playSfx": PlaySfx(Sv(p, "sound"), F(p, "volume")); break;
        }
    }

    // ---- while-inside: apply on enter, undo on exit ----
    public static void Apply(string id, Movement mv, MapWorld world, IDictionary<string, object> p, Dictionary<string, float> state)
    {
        switch (id)
        {
            case "scaleStats":
                foreach (var (field, pk) in new[] { ("runSpeed", "speed"), ("jumpForce", "jump"), ("gravity", "gravity"), ("dashSpeed", "dash") })
                {
                    var o = MoveStat.Get(mv, field); state[field] = o;
                    if (!float.IsNaN(o)) MoveStat.Set(mv, field, o * F(p, pk));
                }
                break;
            case "zoom": SetZoom(mv, world, F(p, "size")); break;
            case "slowmo": Time.timeScale = Mathf.Clamp(F(p, "timeScale"), 0.05f, 10f); break;
        }
    }

    public static void Undo(string id, Movement mv, MapWorld world, IDictionary<string, object> p, Dictionary<string, float> state)
    {
        switch (id)
        {
            case "scaleStats": foreach (var kv in state) if (!float.IsNaN(kv.Value)) MoveStat.Set(mv, kv.Key, kv.Value); break;
            case "zoom": SetZoom(mv, world, 1f); break;
            case "slowmo": if (!Mathf.Approximately(Time.timeScale, 0f)) Time.timeScale = 1f; break;
        }
    }

    // ---- per-frame while inside ----
    public static void Stay(string id, Movement mv, IDictionary<string, object> p)
    {
        if (id == "wind") { var body = mv != null ? mv.GetComponent<Rigidbody2D>() : null; if (body != null) body.linearVelocity += new Vector2(F(p, "vx"), F(p, "vy")) * Time.deltaTime; }
    }

    private static void SetAbilities(Movement mv, IDictionary<string, object> p)
    {
        if (mv == null) return;
        if (Bv(p, "setJumps")) { int n = Iv(p, "airJumps"); MoveStat.SetInt(mv, "maxAirJumps", n); if (n > 0 || Bv(p, "giveDoubleJump")) MoveStat.SetBool(mv, "doubleJumpUnlocked", true); MoveStat.SetInt(mv, "airJumpsLeft", n); }
        if (Bv(p, "setDashes")) { int n = Iv(p, "airDashes"); MoveStat.SetInt(mv, "maxAirDashes", n); if (n > 0 || Bv(p, "giveDash")) MoveStat.SetBool(mv, "dashUnlocked", true); MoveStat.SetInt(mv, "airDashesLeft", n); }
        if (Bv(p, "giveDash")) MoveStat.SetBool(mv, "dashUnlocked", true);
        if (Bv(p, "giveDoubleJump")) MoveStat.SetBool(mv, "doubleJumpUnlocked", true);
        if (Bv(p, "giveWallJump")) { MoveStat.SetBool(mv, "wallJumpUnlocked", true); MoveStat.SetBool(mv, "canWallJump", true); }
    }

    private static void SetGroup(MapWorld world, string group, System.Func<GameObject, bool> active)
    {
        foreach (var go in MapGroups.Members(world, group).ToList()) go.SetActive(active(go));
    }

    private static IEnumerator Slide(IEnumerable<GameObject> members, Vector2 by, float seconds)
    {
        var ts = members.Where(g => g != null).Select(g => g.transform).ToList();
        float done = 0f;
        for (float t = 0f; done < 1f;)
        {
            t += Time.deltaTime;
            var next = seconds <= 0f ? 1f : Mathf.SmoothStep(0f, 1f, Mathf.Clamp01(t / seconds));
            var step = (Vector3)(by * (next - done));
            foreach (var m in ts) if (m != null) m.position += step;
            done = next;
            if (done < 1f) yield return null;
        }
    }

    private static void Teleport(Movement mv, MapWorld world, float tx, float ty)
    {
        if (mv == null) return;
        var pos = MapWorld.Live(world.LevelPoint(tx, ty));
        mv.transform.position = pos;
        var body = mv.GetComponent<Rigidbody2D>();
        if (body != null) { body.position = pos; body.linearVelocity = Vector2.zero; }
        if (mv.cam != null) mv.cam.setup(pos, mv.cam.camSize);
    }

    private static void SetZoom(Movement mv, MapWorld world, float zoom)
    {
        if (mv == null || mv.cam == null) return;
        var normal = world.Def.CameraSize > 0 ? world.Def.CameraSize.Value : MapSpawn.DefaultCamSize;
        mv.cam.newCamSize(normal * zoom);
    }

    private static void PlaySfx(string sound, float volume)
    {
        if (string.IsNullOrEmpty(sound)) return;
        AudioClip clip = null;
        foreach (var c in Resources.FindObjectsOfTypeAll<AudioClip>())
            if (c != null && c.name == sound) { clip = c; break; }
        if (clip == null) return;
        var go = new GameObject("MapSfx");
        var src = go.AddComponent<AudioSource>();
        src.clip = clip; src.volume = Mathf.Clamp01(volume); src.spatialBlend = 0f; src.Play();
        Object.Destroy(go, clip.length + 0.2f);
    }
}

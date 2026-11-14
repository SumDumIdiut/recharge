using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.UI;

namespace Recharge.Module.Maps;


// Group ids from the editor: every object with the same "group" is shown,
// hidden, toggled or moved together by group triggers. Grouped tiles are
// painted on their own tilemap per group, so the group can switch them off.
internal static class MapGroups
{
    public static string Of(JObject obj)
    {
        var g = obj["group"]?.Value<string>();
        return string.IsNullOrEmpty(g) ? null : g;
    }

    public static void Add(MapWorld w, JObject obj, GameObject go)
    {
        var g = Of(obj);
        if (g == null || go == null) return;
        if (!w.Groups.TryGetValue(g, out var list)) w.Groups[g] = list = new List<GameObject>();
        if (!list.Contains(go)) list.Add(go);
    }

    // The groups the editor marked "starts hidden", once each thing is built.
    public static void HideStarting(MapWorld w)
    {
        foreach (var g in w.Def.HiddenGroups ?? new List<string>())
        {
            if (!w.Groups.TryGetValue(g, out var list)) continue;
            foreach (var go in list)
                if (go != null && w.StartedHidden.Add(go)) go.SetActive(false);
        }
    }

    public static IEnumerable<GameObject> Members(MapWorld w, string g) =>
        g != null && w.Groups.TryGetValue(g, out var list) ? list.Where(go => go != null) : Enumerable.Empty<GameObject>();
}

// A trigger zone acting when the player walks in: on a group (show, hide,
// toggle, move) or on the player (teleport, respawn point, camera zoom, a message).
internal class MapGroupTrigger : MonoBehaviour
{
    public MapWorld World;
    public string Kind;
    public string Group;
    public Vector2 Offset;
    public float Seconds = 1f;
    public bool Back;
    public bool Once;
    public Vector2 Target;
    public float Zoom = 1f;
    public string Text;
    public Vector2 Velocity;                 // launch: velocity given on enter
    public float SpeedMul = 1f, JumpMul = 1f, GravityMul = 1f, DashMul = 1f; // boost: stat scales while inside
    public int AirJumps = 1, AirDashes = 1;  // abilities: counts to set
    public bool SetJumps, SetDashes, GiveDash, GiveDoubleJump, GiveWallJump; // abilities: which to apply
    public float TimeScale = 0.5f;           // slowmo: time scale while inside
    public string Music;                     // music: "game:<id>", "none", "level"
    public string Sound;                     // sfx: a game AudioClip name
    public float Volume = 1f;                // sfx volume
    public Vector2 Wind;                     // wind: push per second while inside

    private bool _used;
    private bool _moved;
    private Coroutine _moving;
    private bool _boosted;

    private void OnTriggerEnter2D(Collider2D collision)
    {
        if (!collision.CompareTag("Player") || World == null) return;
        var mv = collision.GetComponent<Movement>();
        if (Kind == "zoom") { SetZoom(mv, Zoom); return; }
        if (Kind == "boost") { ApplyBoost(mv); return; }
        if (Kind == "slowmo") { Time.timeScale = Mathf.Clamp(TimeScale, 0.05f, 10f); return; }
        if (Once && _used) return;
        _used = true;
        switch (Kind)
        {
            case "show": SetGroup(_ => true); break;
            case "hide": SetGroup(_ => false); break;
            case "toggle": SetGroup(go => !go.activeSelf); break;
            case "move": if (!_moved) MoveGroup(Offset); break;
            case "swapBlocks": if (mv != null) mv.swapBlocks(); break;
            case "teleport": Teleport(mv); break;
            case "respawn": if (mv != null) mv.respawnPoint = Target + new Vector2(0f, 12f); break;
            case "message": MapMessage.Show(Text, Seconds); break;
            case "launch": Launch(mv); break;
            case "abilities": SetAbilities(mv); break;
            case "refill": Refill(mv); break;
            case "music": if (!string.IsNullOrEmpty(Music)) MapMedia.PlayMusic(new JValue(Music)); break;
            case "sfx": PlaySfx(); break;
        }
    }

    private void OnTriggerStay2D(Collider2D collision)
    {
        if (Kind != "wind" || !collision.CompareTag("Player")) return;
        var body = collision.attachedRigidbody;
        if (body != null) body.linearVelocity += Wind * Time.deltaTime;
    }

    private void OnTriggerExit2D(Collider2D collision)
    {
        if (!collision.CompareTag("Player") || World == null) return;
        if (Kind == "zoom") SetZoom(collision.GetComponent<Movement>(), 1f);
        if (Kind == "boost") RestoreBoost(collision.GetComponent<Movement>());
        if (Kind == "slowmo" && !Mathf.Approximately(Time.timeScale, 0f)) Time.timeScale = 1f;
        if (Kind == "move" && Back && _moved) MoveGroup(-Offset);
    }

    // Play a game sound effect by its clip name through a throwaway AudioSource (safe no-op if the name isn't loaded).
    private void PlaySfx()
    {
        if (string.IsNullOrEmpty(Sound)) return;
        AudioClip clip = null;
        foreach (var c in Resources.FindObjectsOfTypeAll<AudioClip>())
            if (c != null && c.name == Sound) { clip = c; break; }
        if (clip == null) return;
        var go = new GameObject("MapSfx");
        var src = go.AddComponent<AudioSource>();
        src.clip = clip;
        src.volume = Mathf.Clamp01(Volume);
        src.spatialBlend = 0f;
        src.Play();
        Object.Destroy(go, clip.length + 0.2f);
    }

    // Set the player's air-jump / air-dash allowance (and unlock the abilities so the counts take effect), refilling now.
    private void SetAbilities(Movement mv)
    {
        if (mv == null) return;
        if (SetJumps)
        {
            MoveStat.SetInt(mv, "maxAirJumps", AirJumps);
            if (AirJumps > 0 || GiveDoubleJump) MoveStat.SetBool(mv, "doubleJumpUnlocked", AirJumps > 0 || GiveDoubleJump);
            MoveStat.SetInt(mv, "airJumpsLeft", AirJumps);
        }
        if (SetDashes)
        {
            MoveStat.SetInt(mv, "maxAirDashes", AirDashes);
            if (AirDashes > 0 || GiveDash) MoveStat.SetBool(mv, "dashUnlocked", AirDashes > 0 || GiveDash);
            MoveStat.SetInt(mv, "airDashesLeft", AirDashes);
        }
        if (GiveDash) MoveStat.SetBool(mv, "dashUnlocked", true);
        if (GiveDoubleJump) MoveStat.SetBool(mv, "doubleJumpUnlocked", true);
        if (GiveWallJump) { MoveStat.SetBool(mv, "wallJumpUnlocked", true); MoveStat.SetBool(mv, "canWallJump", true); }
    }

    // A recharge pad: top the player's air jumps and dashes back up to their max.
    private void Refill(Movement mv)
    {
        if (mv == null) return;
        MoveStat.SetInt(mv, "airJumpsLeft", MoveStat.GetInt(mv, "maxAirJumps", 0));
        MoveStat.SetInt(mv, "airDashesLeft", MoveStat.GetInt(mv, "maxAirDashes", 0));
    }

    private void Launch(Movement mv)
    {
        var body = mv != null ? mv.GetComponent<Rigidbody2D>() : null;
        if (body != null) body.linearVelocity = Velocity;
    }

    // Scale the player's own serialized stats while inside; the originals are restored on exit. Reflection keeps it
    // safe if a field is renamed in a game update (a missing field is just left alone).
    private float _oSpeed, _oJump, _oGrav, _oDash;
    private void ApplyBoost(Movement mv)
    {
        if (mv == null || _boosted) return;
        _boosted = true;
        _oSpeed = MoveStat.Get(mv, "runSpeed"); if (!float.IsNaN(_oSpeed)) MoveStat.Set(mv, "runSpeed", _oSpeed * SpeedMul);
        _oJump = MoveStat.Get(mv, "jumpForce"); if (!float.IsNaN(_oJump)) MoveStat.Set(mv, "jumpForce", _oJump * JumpMul);
        _oGrav = MoveStat.Get(mv, "gravity"); if (!float.IsNaN(_oGrav)) MoveStat.Set(mv, "gravity", _oGrav * GravityMul);
        _oDash = MoveStat.Get(mv, "dashSpeed"); if (!float.IsNaN(_oDash)) MoveStat.Set(mv, "dashSpeed", _oDash * DashMul);
    }
    private void RestoreBoost(Movement mv)
    {
        if (mv == null || !_boosted) return;
        _boosted = false;
        if (!float.IsNaN(_oSpeed)) MoveStat.Set(mv, "runSpeed", _oSpeed);
        if (!float.IsNaN(_oJump)) MoveStat.Set(mv, "jumpForce", _oJump);
        if (!float.IsNaN(_oGrav)) MoveStat.Set(mv, "gravity", _oGrav);
        if (!float.IsNaN(_oDash)) MoveStat.Set(mv, "dashSpeed", _oDash);
    }

    private void SetGroup(System.Func<GameObject, bool> active)
    {
        foreach (var go in MapGroups.Members(World, Group).ToList()) go.SetActive(active(go));
    }

    private void MoveGroup(Vector2 by)
    {
        _moved = by == Offset;
        if (_moving != null) StopCoroutine(_moving);
        _moving = StartCoroutine(Slide(MapGroups.Members(World, Group).Select(go => go.transform).ToList(), by, Seconds));
    }

    // Moved by the step each frame rather than to fixed points, so a floating-origin shift mid-move is fine.
    private static IEnumerator Slide(List<Transform> members, Vector2 by, float seconds)
    {
        float done = 0f;
        for (float t = 0f; done < 1f;)
        {
            t += Time.deltaTime;
            var next = seconds <= 0f ? 1f : Mathf.SmoothStep(0f, 1f, Mathf.Clamp01(t / seconds));
            var step = (Vector3)(by * (next - done));
            foreach (var m in members) if (m != null) m.position += step;
            done = next;
            if (done < 1f) yield return null;
        }
    }

    private void Teleport(Movement mv)
    {
        if (mv == null) return;
        var pos = MapWorld.Live(Target);
        mv.transform.position = pos;
        var body = mv.GetComponent<Rigidbody2D>();
        if (body != null) { body.position = pos; body.linearVelocity = Vector2.zero; }
        if (mv.cam != null) mv.cam.setup(pos, mv.cam.camSize);
    }

    private void SetZoom(Movement mv, float zoom)
    {
        if (mv == null || mv.cam == null) return;
        var normal = World.Def.CameraSize > 0 ? World.Def.CameraSize.Value : MapSpawn.DefaultCamSize;
        mv.cam.newCamSize(normal * zoom);
    }
}

// Reads/writes a float stat field on the player's Movement by name (cached), tolerant of a missing or non-float field.
internal static class MoveStat
{
    private static readonly Dictionary<string, FieldInfo> _cache = new Dictionary<string, FieldInfo>();
    private static FieldInfo Field(Movement mv, string name)
    {
        if (_cache.TryGetValue(name, out var f)) return f;
        f = mv.GetType().GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        _cache[name] = f;
        return f;
    }
    public static float Get(Movement mv, string name)
    {
        var f = Field(mv, name);
        if (f == null || (f.FieldType != typeof(float) && f.FieldType != typeof(double))) return float.NaN;
        try { return System.Convert.ToSingle(f.GetValue(mv)); } catch { return float.NaN; }
    }
    public static void Set(Movement mv, string name, float v)
    {
        var f = Field(mv, name);
        if (f == null) return;
        try { if (f.FieldType == typeof(float)) f.SetValue(mv, v); else if (f.FieldType == typeof(double)) f.SetValue(mv, (double)v); } catch { }
    }
    public static int GetInt(Movement mv, string name, int def)
    {
        var f = Field(mv, name);
        if (f == null || f.FieldType != typeof(int)) return def;
        try { return (int)f.GetValue(mv); } catch { return def; }
    }
    public static void SetInt(Movement mv, string name, int v)
    {
        var f = Field(mv, name);
        if (f == null) return;
        try { if (f.FieldType == typeof(int)) f.SetValue(mv, v); else if (f.FieldType == typeof(float)) f.SetValue(mv, (float)v); } catch { }
    }
    public static void SetBool(Movement mv, string name, bool v)
    {
        var f = Field(mv, name);
        if (f != null && f.FieldType == typeof(bool)) { try { f.SetValue(mv, v); } catch { } }
    }
}

// A line of text on screen for a few seconds, in the game's own font.
internal static class MapMessage
{
    private static GameObject _shown;

    public static void Show(string text, float seconds)
    {
        if (_shown != null) Object.Destroy(_shown);
        var go = new GameObject("MapMessage");
        var canvas = go.AddComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        canvas.sortingOrder = 500;
        var scaler = go.AddComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(1920f, 1080f);

        var label = new GameObject("Text");
        label.transform.SetParent(go.transform, false);
        var tmp = label.AddComponent<TMPro.TextMeshProUGUI>();
        var font = Object.FindObjectsByType<TMPro.TMP_Text>(FindObjectsSortMode.None).Select(t => t.font).FirstOrDefault(f => f != null);
        if (font != null) tmp.font = font;
        tmp.text = text ?? "";
        tmp.fontSize = 56f;
        tmp.alignment = TMPro.TextAlignmentOptions.Center;
        tmp.color = Color.white;
        tmp.outlineWidth = 0.2f;
        tmp.outlineColor = new Color32(0, 0, 0, 255);
        var rect = (RectTransform)label.transform;
        rect.anchorMin = new Vector2(0.1f, 0.12f);
        rect.anchorMax = new Vector2(0.9f, 0.3f);
        rect.offsetMin = rect.offsetMax = Vector2.zero;
        _shown = go;
        Object.Destroy(go, Mathf.Max(0.5f, seconds));
    }
}

// When an end-credits trigger fires: the area layer its credits play on comes on,
// even outside the area it belongs to (MapWorld.ZoneOnly would keep it off there).
internal class MapCreditsShow : MonoBehaviour
{
    public MapWorld World;

    private void OnTriggerEnter2D(Collider2D collision)
    {
        if (World == null || collision.GetComponent<Movement>() == null) return;
        var credits = GetComponentInChildren<EndCreditsTrigger>(true)?.credits;
        for (var t = credits != null ? credits.transform : null; t != null; t = t.parent)
            foreach (var (go, _) in World.ZoneOnly)
                if (go != null && go.transform == t) go.SetActive(true);
    }
}

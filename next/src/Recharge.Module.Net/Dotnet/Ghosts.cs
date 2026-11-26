using System;
using System.Collections;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using Recharge.Net;
using UnityEngine;
using UnityEngine.Networking;
using Object = UnityEngine.Object;

public class MpPlayerState
{
	public int id;
	public double x;
	public double y;
	public bool facingRight;
	public int animState;
	public float animSpeed;
	public bool isPaused;
	public string name;
	public string nameColor;
	public string dotColor;
	public string nameGradient; // packed "#rrggbb,#rrggbb,..." or null/empty for solid
	public string skin; // the player's skin folder, shown on their ghost; null/empty = vanilla
	public string avatar; // hub avatar path (/api/avatars/..) for the ghost's nameplate; null/empty = none
	public string banner; // hub banner path (/api/banners/..) behind the nameplate; null/empty = none
	public string bannerColor; // "#rrggbb" tint behind the nameplate; null/empty = none
}

// Re-skins a ghost's body each frame to show the peer's skin. The ghost's
// Animator sets vanilla sprites in Update; this maps each one into the peer's
// skin in LateUpdate. When the skin isn't available locally the vanilla frame
// is kept, so that peer simply shows the default look.
internal sealed class MpGhostSkinner : MonoBehaviour
{
	public SpriteRenderer[] Body;
	public string Folder;

	private void LateUpdate()
	{
		var bridge = Recharge.ModApi.SkinGhostBridge.Current;
		if (bridge == null || Body == null || string.IsNullOrEmpty(Folder) || !bridge.HasSkin(Folder)) return;
		for (int i = 0; i < Body.Length; i++)
		{
			var sr = Body[i];
			if (sr == null) continue;
			var skinned = bridge.ResolveSprite(Folder, sr.sprite);
			if (skinned != null) sr.sprite = skinned;
		}
	}
}

public class MpLobbyInfo
{
	public int id;
	public string name;
	public string hostName;
	public string hostColor;
	public int count;
	public string mapHubId;
	public string mapName;
	public bool hard;
}

// The full game rebases the world whenever the player gets 5000 units from
// the origin (FloatingOrigin): every scene root shifts and the running total
// lands in currentOrigin, so the game's own save/respawn code stores
// position - currentOrigin. Each client's origin differs, so positions go
// over the wire in that world space. FloatingOrigin doesn't exist in the
// demo, hence reflection; there the origin is always zero.
internal static class MpOrigin
{
	private static readonly Type OriginType = Type.GetType("FloatingOrigin, Assembly-CSharp");
	private static readonly System.Reflection.FieldInfo CurrentOriginField = OriginType?.GetField("currentOrigin");
	private static Object _instance;
	private static float _nextSearchTime;

	public static Vector3 Current
	{
		get
		{
			if (CurrentOriginField == null) return Vector3.zero;
			if (_instance == null && Time.unscaledTime >= _nextSearchTime)
			{
				_nextSearchTime = Time.unscaledTime + 0.5f;
				_instance = Object.FindFirstObjectByType(OriginType);
			}
			return _instance != null ? (Vector3)CurrentOriginField.GetValue(_instance) : Vector3.zero;
		}
	}

	public static void ToWorld(Vector3 local, out double x, out double y)
	{
		var origin = Current;
		x = (double)local.x - origin.x;
		y = (double)local.y - origin.y;
	}

	public static Vector3 ToLocal(double x, double y)
	{
		var origin = Current;
		return new Vector3((float)(x + origin.x), (float)(y + origin.y), 0f);
	}
}

// The map's coordinate space for ghosts (see GhostSpace): set from the Maps module's events, None when no map is active.
internal static class MpGhostSpace
{
	public static GhostSpace Current = GhostSpace.None;

	public static void Install(Recharge.ModApi.IEventBus bus)
	{
		bus.On(GhostSpace.SpaceEvent, payload => Current = GhostSpace.FromSpacePayload(payload));
		bus.On(GhostSpace.ZonesEvent, payload => Current = Current.WithZones(GhostSpace.ParseZones(payload)));
	}
}

// Local opacity prefs the app writes: <gameDir>/Recharge/Mods/recharge.multiplayer/display.json { "nameOpacity", "playerOpacity" } (0..1).
internal static class MpDisplay
{
	private static readonly string Path = System.IO.Path.Combine(
		System.IO.Path.GetDirectoryName(Application.dataPath) ?? ".", "Recharge", "Mods", "recharge.multiplayer", "display.json");
	public static float NameAlpha = 0.9f;
	public static float PlayerAlpha = 0.9f;
	public static float PfpAlpha = 0.9f;
	public static float BannerAlpha = 0.7f;
	private static long _stamp = long.MinValue;
	private static float _nextCheck;

	// Re-reads at most every 2s (ApplySnapshot calls this each snapshot).
	public static void Tick()
	{
		if (Time.unscaledTime < _nextCheck) return;
		_nextCheck = Time.unscaledTime + 2f;
		try
		{
			if (!System.IO.File.Exists(Path)) { _stamp = 0; return; }
			long stamp = System.IO.File.GetLastWriteTimeUtc(Path).Ticks;
			if (stamp == _stamp) return;
			_stamp = stamp;
			var jo = JObject.Parse(System.IO.File.ReadAllText(Path));
			NameAlpha = Clamp01(jo["nameOpacity"], NameAlpha);
			PlayerAlpha = Clamp01(jo["playerOpacity"], PlayerAlpha);
			PfpAlpha = Clamp01(jo["pfpOpacity"], PfpAlpha);
			BannerAlpha = Clamp01(jo["bannerOpacity"], BannerAlpha);
		}
		catch { }
	}

	private static float Clamp01(JToken tok, float fallback)
	{
		if (tok == null) return fallback;
		try { return Mathf.Clamp01((float)tok); } catch { return fallback; }
	}
}

internal sealed class MpCoroutineRunner : MonoBehaviour { }

// Fetches and caches hub avatar/banner images for ghost nameplates. Only the
// hub's own /api/avatars and /api/banners paths are ever requested (validated
// before they reach the wire), and a failed fetch is cached as null so a ghost
// doesn't hammer the server.
internal static class MpImageCache
{
	private const string HubBase = "https://codecade.co.za/recharge";
	private static readonly Dictionary<string, Sprite> _cache = new Dictionary<string, Sprite>();
	private static readonly HashSet<string> _loading = new HashSet<string>();
	private static MpCoroutineRunner _runner;

	public static Sprite Get(string path) => !string.IsNullOrEmpty(path) && _cache.TryGetValue(path, out var s) ? s : null;

	// Starts a fetch for a path if it isn't cached or in flight. Cheap to call every frame.
	public static void Request(string path)
	{
		if (string.IsNullOrEmpty(path) || _cache.ContainsKey(path) || _loading.Contains(path)) return;
		if (!(path.StartsWith("/api/avatars/") || path.StartsWith("/api/banners/"))) { _cache[path] = null; return; }
		_loading.Add(path);
		EnsureRunner().StartCoroutine(Load(path));
	}

	private static MpCoroutineRunner EnsureRunner()
	{
		if (_runner == null)
		{
			var go = new GameObject("MpImageCache");
			Object.DontDestroyOnLoad(go);
			_runner = go.AddComponent<MpCoroutineRunner>();
		}
		return _runner;
	}

	private static IEnumerator Load(string path)
	{
		using var req = UnityWebRequestTexture.GetTexture(HubBase + path);
		yield return req.SendWebRequest();
		try
		{
			if (req.result == UnityWebRequest.Result.Success && DownloadHandlerTexture.GetContent(req) is Texture2D tex && tex != null)
				_cache[path] = Sprite.Create(tex, new Rect(0, 0, tex.width, tex.height), new Vector2(0.5f, 0.5f), 100f);
			else
				_cache[path] = null;
		}
		catch { _cache[path] = null; }
		finally { _loading.Remove(path); }
	}
}

internal static class MpGhostManager
{
	private class GhostEntry
	{
		public GameObject Root;
		public Transform SpriteTransform;
		public double TargetWorldX, TargetWorldY; // world coordinates, as on the v1 wire
		public bool Shown = true;
		public bool TargetFacingRight;
		public float LastSeenTime;
		public Animator Anim;
		public TextMesh Label;
		public string LabelText = "?";
		public string[] NameStops; // gradient stops, null = solid
		public GameObject PausedIndicator;
		public readonly List<SpriteRenderer> Body = new List<SpriteRenderer>(); // the player body renderers
		public Transform[] Dash = new Transform[0];
		public Transform[] Jump = new Transform[0];
		public string SkinFolder; // the peer's skin folder, shown on this ghost
		public MpGhostSkinner Skinner;
		public SpriteRenderer PfpSr; // profile picture above the name
		public SpriteRenderer BannerSr; // banner behind the name
		public string AvatarPath; // hub path, requested from MpImageCache
		public string BannerPath;
		public Color BannerTint = Color.white; // bannerColor; white when none
	}

	// Copied from the local player: Sprite (which carries the dash indicators
	// under Indicators/DashIndicators) and PlayerObject/JumpIndicators, which
	// the game keeps outside the sprite and steers toward
	// Sprite/Indicators/JumpIndicatorTarget.
	private static readonly Dictionary<int, GhostEntry> _ghosts = new Dictionary<int, GhostEntry>();
	private static readonly Dictionary<int, (int Dashes, int Jumps)> _indicatorCounts = new Dictionary<int, (int, int)>();
	private static Transform _spriteTemplate;
	private static Transform _jumpTemplate;
	private static Sprite _pauseSprite;
	private static float _lastSnapshotLogTime = -999f;
	private static Vector3 _lastOrigin;

	public static void SetTemplate(Transform playerSprite, Transform jumpIndicators)
	{
		_spriteTemplate = playerSprite;
		_jumpTemplate = jumpIndicators;
	}

	// A peer's air dashes/jumps left, as its own indicators would show them.
	public static void SetIndicators(int id, int dashes, int jumps)
	{
		_indicatorCounts[id] = (dashes, jumps);
		if (_ghosts.TryGetValue(id, out var g)) ApplyIndicators(g, dashes, jumps);
	}

	private static void ApplyIndicators(GhostEntry g, int dashes, int jumps)
	{
		for (int i = 0; i < g.Dash.Length; i++)
			if (g.Dash[i] != null) g.Dash[i].gameObject.SetActive(i < dashes);
		for (int i = 0; i < g.Jump.Length; i++)
			if (g.Jump[i] != null) g.Jump[i].gameObject.SetActive(i < jumps);
	}

	public static GameObject GetGhostRoot(int id) => _ghosts.TryGetValue(id, out var g) ? g.Root : null;

	public static void ApplySnapshot(List<MpPlayerState> players)
	{
		bool doLog = Time.unscaledTime - _lastSnapshotLogTime > 2f;
		if (doLog) _lastSnapshotLogTime = Time.unscaledTime;

		MpDisplay.Tick();
		var seen = new HashSet<int>();
		foreach (var p in players)
		{
			if (doLog) Debug.Log($"[MpGhost] snapshot id={p.id} name={p.name} pos=({p.x:F1},{p.y:F1}) paused={p.isPaused}");
			seen.Add(p.id);
			var pos = MpOrigin.ToLocal(p.x, p.y);
			var nameColor = ParseColorOr(p.nameColor, new Color(1f, 1f, 1f, MpDisplay.NameAlpha));
			var stops = ParseStops(p.nameGradient);
			if (!_ghosts.TryGetValue(p.id, out var g))
			{
				g = Spawn(p.name, pos, nameColor, stops, p.skin);
				_ghosts[p.id] = g;
				var counts = _indicatorCounts.TryGetValue(p.id, out var c) ? c : (0, 0);
				ApplyIndicators(g, counts.Item1, counts.Item2);
			}
			else
			{
				g.LabelText = string.IsNullOrEmpty(p.name) ? "?" : p.name;
				g.NameStops = stops;
				ApplyColors(g, nameColor);
				if (g.SkinFolder != p.skin)
				{
					g.SkinFolder = p.skin;
					if (g.Skinner != null) g.Skinner.Folder = p.skin;
				}
			}
			g.AvatarPath = string.IsNullOrEmpty(p.avatar) ? null : p.avatar;
			g.BannerPath = string.IsNullOrEmpty(p.banner) ? null : p.banner;
			g.BannerTint = ParseColorOr(p.bannerColor, Color.white);
			g.TargetWorldX = p.x;
			g.TargetWorldY = p.y;
			g.TargetFacingRight = p.facingRight;
			g.LastSeenTime = Time.unscaledTime;
			if (g.Anim != null)
			{
				g.Anim.SetInteger("Animation", p.animState);
				g.Anim.speed = p.animSpeed;
			}
			if (g.PausedIndicator != null) g.PausedIndicator.SetActive(p.isPaused);
		}

		var stale = new List<int>();
		foreach (var kv in _ghosts)
			if (!seen.Contains(kv.Key)) stale.Add(kv.Key);
		foreach (var id in stale) Remove(id);
	}

	public static void Tick(float dt)
	{
		const float staleTimeout = 6f;

		// Ghosts live in DontDestroyOnLoad, which a FloatingOrigin rebase
		// doesn't move - shift them with the world so they don't lerp
		// thousands of units across the screen to catch up.
		var origin = MpOrigin.Current;
		if (origin != _lastOrigin)
		{
			var shift = origin - _lastOrigin;
			_lastOrigin = origin;
			foreach (var g in _ghosts.Values)
				if (g.Root != null) g.Root.transform.position += shift;
		}

		var stale = new List<int>();
		foreach (var kv in _ghosts)
		{
			var g = kv.Value;
			if (g.Root == null) { stale.Add(kv.Key); continue; }
			if (Time.unscaledTime - g.LastSeenTime > staleTimeout) { stale.Add(kv.Key); continue; }

			var t = g.Root.transform;
			t.position = Vector3.Lerp(t.position, MpOrigin.ToLocal(g.TargetWorldX, g.TargetWorldY), 1f - Mathf.Exp(-14f * dt));

			// A ghost standing in a zone this client has not loaded would hover over geometry that is not there.
			bool shown = MpGhostSpace.Current.IsLoaded(g.TargetWorldX, g.TargetWorldY);
			if (shown != g.Shown)
			{
				g.Shown = shown;
				g.Root.SetActive(shown);
			}

			if (g.SpriteTransform != null)
			{
				var scale = g.SpriteTransform.localScale;
				var sign = g.TargetFacingRight ? 1f : -1f;
				scale.x = Mathf.Abs(scale.x) * sign;
				g.SpriteTransform.localScale = scale;
			}
			UpdateNameplate(g);
		}
		foreach (var id in stale) Remove(id);
	}

	private static Color ParseColorOr(string hex, Color fallback)
	{
		if (!string.IsNullOrEmpty(hex) && ColorUtility.TryParseHtmlString(hex, out var c))
		{
			c.a = fallback.a;
			return c;
		}
		return fallback;
	}

	private static SpriteRenderer CreateNameplatePart(Transform parent, string name, Vector3 localPos, Shader unlitShader, SpriteRenderer reference, int sortOffset)
	{
		var go = new GameObject(name);
		go.transform.SetParent(parent, false);
		go.transform.localPosition = localPos;
		var s = go.AddComponent<SpriteRenderer>();
		if (unlitShader != null) s.material = new Material(unlitShader);
		if (reference != null) { s.sortingLayerID = reference.sortingLayerID; s.sortingOrder = reference.sortingOrder + sortOffset; }
		go.SetActive(false);
		return s;
	}

	// Each frame: request the peer's avatar/banner, show them once fetched, and apply the opacity prefs.
	private static void UpdateNameplate(GhostEntry g)
	{
		ApplyNameplatePart(g.PfpSr, g.AvatarPath, 46f, Color.white, MpDisplay.PfpAlpha);
		ApplyNameplatePart(g.BannerSr, g.BannerPath, 54f, g.BannerTint, MpDisplay.BannerAlpha);
	}

	private static void ApplyNameplatePart(SpriteRenderer sr, string path, float desiredHeight, Color tint, float alpha)
	{
		if (sr == null) return;
		if (string.IsNullOrEmpty(path) || alpha <= 0.01f) { if (sr.gameObject.activeSelf) sr.gameObject.SetActive(false); return; }
		MpImageCache.Request(path);
		var sprite = MpImageCache.Get(path);
		if (sprite == null) { if (sr.gameObject.activeSelf) sr.gameObject.SetActive(false); return; }
		if (sr.sprite != sprite) FitSprite(sr, sprite, desiredHeight);
		tint.a = alpha;
		sr.color = tint;
		if (!sr.gameObject.activeSelf) sr.gameObject.SetActive(true);
	}

	private static void FitSprite(SpriteRenderer sr, Sprite sprite, float desiredHeight)
	{
		sr.sprite = sprite;
		var h = sprite.bounds.size.y;
		float scale = h > 0.0001f ? desiredHeight / h : 1f;
		sr.transform.localScale = new Vector3(scale, scale, 1f);
	}

	// Bodies are drawn untinted (white) now that a player's skin identifies them
	// rather than a colour; the alpha keeps the ghost translucent.
	private static void ApplyColors(GhostEntry g, Color nameColor)
	{
		foreach (var partSr in g.Body)
			if (partSr != null) partSr.color = new Color(1f, 1f, 1f, MpDisplay.PlayerAlpha);
		UpdateLabel(g, nameColor);
	}

	// A packed "#rrggbb,#rrggbb,..." into stops, or null when solid. The relay already validates; this is a light re-check.
	private static string[] ParseStops(string packed)
	{
		if (string.IsNullOrEmpty(packed)) return null;
		var parts = packed.Split(',');
		if (parts.Length < 2) return null;
		foreach (var p in parts) if (p.Length != 7 || p[0] != '#') return null;
		return parts;
	}

	// Renders the ghost's name: a per-character gradient (rich text, alpha from the opacity pref) when it has stops, else solid.
	private static void UpdateLabel(GhostEntry g, Color nameColor)
	{
		var tm = g.Label;
		if (tm == null) return;
		if (g.NameStops != null && g.NameStops.Length >= 2)
		{
			byte a = (byte)Mathf.RoundToInt(Mathf.Clamp01(MpDisplay.NameAlpha) * 255f);
			tm.richText = true;
			tm.text = MpNetworkManager.GradientSpansRGBA(MpNetworkManager.SanitizeForRichText(g.LabelText), g.NameStops, a);
		}
		else
		{
			tm.richText = false;
			tm.text = g.LabelText;
			tm.color = nameColor;
		}
	}

	private static GhostEntry Spawn(string name, Vector3 spawnPos, Color nameColor, string[] stops, string skinFolder)
	{
		var root = new GameObject("MPGhost_" + (string.IsNullOrEmpty(name) ? "?" : name));
		Object.DontDestroyOnLoad(root);
		root.transform.position = spawnPos;

		var entry = new GhostEntry { Root = root, LastSeenTime = Time.unscaledTime, LabelText = string.IsNullOrEmpty(name) ? "?" : name, NameStops = stops, SkinFolder = skinFolder };
		SpriteRenderer sr = null;
		Animator anim = null;
		Transform spriteTransform = null;
		Transform indicators = null;

		if (_spriteTemplate != null)
		{
			var spriteGo = Object.Instantiate(_spriteTemplate.gameObject, root.transform);
			spriteGo.name = "Sprite";
			spriteGo.transform.localPosition = Vector3.zero;
			StripToVisuals(spriteGo);
			sr = spriteGo.GetComponent<SpriteRenderer>();
			anim = spriteGo.GetComponent<Animator>();
			if (anim != null) anim.updateMode = AnimatorUpdateMode.UnscaledTime;
			spriteTransform = spriteGo.transform;
			indicators = spriteTransform.Find("Indicators");
		}
		else
		{
			sr = root.AddComponent<SpriteRenderer>();
			spriteTransform = root.transform;
		}

		// Everything but the indicators is the player body, drawn unlit in
		// their colour; the indicators keep the game's own look.
		var unlitShader = Shader.Find("Universal Render Pipeline/2D/Sprite-Unlit-Default")
			?? Shader.Find("Sprites/Default");
		foreach (var partSr in root.GetComponentsInChildren<SpriteRenderer>(true))
		{
			if (indicators != null && partSr.transform.IsChildOf(indicators)) continue;
			if (unlitShader != null) partSr.material = new Material(unlitShader);
			partSr.color = new Color(1f, 1f, 1f, MpDisplay.PlayerAlpha);
			entry.Body.Add(partSr);
		}

		// Drive the ghost's skin each frame from the peer's skin folder.
		var skinner = root.AddComponent<MpGhostSkinner>();
		skinner.Body = entry.Body.ToArray();
		skinner.Folder = skinFolder;
		entry.Skinner = skinner;

		// The clone carries whatever the local player's indicators showed at
		// copy time - reset them so only the peer's counts drive them.
		var dashParent = indicators != null ? indicators.Find("DashIndicators") : null;
		if (dashParent != null)
		{
			entry.Dash = new Transform[dashParent.childCount];
			for (int i = 0; i < dashParent.childCount; i++)
			{
				var d = dashParent.GetChild(i);
				d.localPosition = Vector3.zero;
				d.localScale = Vector3.one;
				entry.Dash[i] = d;
			}
		}
		var jumpTarget = indicators != null ? indicators.Find("JumpIndicatorTarget") : null;
		if (_jumpTemplate != null && jumpTarget != null)
		{
			var jumpGo = Object.Instantiate(_jumpTemplate.gameObject, jumpTarget);
			jumpGo.name = "JumpIndicators";
			StripToVisuals(jumpGo);
			jumpGo.transform.localPosition = Vector3.zero;
			jumpGo.transform.localRotation = Quaternion.identity;
			jumpGo.transform.localScale = Vector3.one;
			entry.Jump = new Transform[jumpGo.transform.childCount];
			for (int i = 0; i < entry.Jump.Length; i++)
			{
				var j = jumpGo.transform.GetChild(i);
				j.localPosition = new Vector3(0f, -15f * i, 0f); // same stacking as PlayerAbilityIndicatorController
				j.localScale = Vector3.one;
				entry.Jump[i] = j;
			}
		}

		var labelGo = new GameObject("Label");
		labelGo.transform.SetParent(root.transform, false);
		labelGo.transform.localPosition = new Vector3(0f, 75f, 0f);
		var tm = labelGo.AddComponent<TextMesh>();
		tm.fontSize = 48;
		tm.characterSize = 8f;
		tm.anchor = TextAnchor.MiddleCenter;
		tm.alignment = TextAlignment.Center;
		entry.Label = tm;
		UpdateLabel(entry, nameColor);
		var labelRenderer = labelGo.GetComponent<MeshRenderer>();
		if (labelRenderer != null && sr != null)
		{
			labelRenderer.sortingLayerID = sr.sortingLayerID;
			labelRenderer.sortingOrder = sr.sortingOrder + 10;
		}

		// Nameplate: a banner behind the name and the profile picture above it.
		entry.BannerSr = CreateNameplatePart(root.transform, "Banner", new Vector3(0f, 75f, 0f), unlitShader, sr, 9);
		entry.PfpSr = CreateNameplatePart(root.transform, "Pfp", new Vector3(0f, 128f, 0f), unlitShader, sr, 11);

		var pausedGo = new GameObject("PausedIndicator");
		pausedGo.transform.SetParent(root.transform, false);
		pausedGo.transform.localPosition = new Vector3(0f, 110f, 0f);
		var pausedSr = pausedGo.AddComponent<SpriteRenderer>();
		pausedSr.sprite = PauseSprite();
		pausedSr.color = new Color(1f, 0.85f, 0.2f);
		if (unlitShader != null) pausedSr.material = new Material(unlitShader);
		if (sr != null)
		{
			pausedSr.sortingLayerID = sr.sortingLayerID;
			pausedSr.sortingOrder = sr.sortingOrder + 10;
		}
		pausedGo.SetActive(false);

		entry.SpriteTransform = spriteTransform;
		entry.Anim = anim;
		entry.PausedIndicator = pausedGo;
		return entry;
	}

	private static void StripToVisuals(GameObject go)
	{
		foreach (var comp in go.GetComponentsInChildren<Component>(true))
		{
			if (comp is Transform || comp is SpriteRenderer || comp is Animator) continue;
			Object.Destroy(comp);
		}
	}

	// A pause glyph (two bars with a dark outline), 32x32 at 1 pixel per
	// unit - the game has no pause sprite of its own to borrow. White, so
	// the SpriteRenderer's colour tints it.
	private static Sprite PauseSprite()
	{
		if (_pauseSprite != null) return _pauseSprite;
		const int size = 32;
		bool Bar(int x, int y) => y >= 4 && y < 28 && ((x >= 7 && x < 13) || (x >= 19 && x < 25));
		var px = new Color32[size * size];
		for (int y = 0; y < size; y++)
		for (int x = 0; x < size; x++)
		{
			if (Bar(x, y)) { px[y * size + x] = new Color32(255, 255, 255, 255); continue; }
			bool edge = false;
			for (int dy = -1; dy <= 1 && !edge; dy++)
			for (int dx = -1; dx <= 1 && !edge; dx++)
				edge = Bar(x + dx, y + dy);
			px[y * size + x] = edge ? new Color32(0, 0, 0, 200) : new Color32(0, 0, 0, 0);
		}
		var tex = new Texture2D(size, size, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
		tex.SetPixels32(px);
		tex.Apply();
		_pauseSprite = Sprite.Create(tex, new Rect(0, 0, size, size), new Vector2(0.5f, 0.5f), 1f);
		return _pauseSprite;
	}

	private static void Remove(int id)
	{
		if (_ghosts.TryGetValue(id, out var g))
		{
			if (g.Root != null) Object.Destroy(g.Root);
			_ghosts.Remove(id);
		}
	}

	public static void Clear()
	{
		foreach (var g in _ghosts.Values)
			if (g.Root != null) Object.Destroy(g.Root);
		_ghosts.Clear();
		_indicatorCounts.Clear();
		_lastOrigin = MpOrigin.Current;
	}
}

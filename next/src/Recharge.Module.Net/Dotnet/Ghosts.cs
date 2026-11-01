using System;
using System.Collections.Generic;
using Recharge.Net;
using UnityEngine;
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
		public GameObject PausedIndicator;
		public readonly List<SpriteRenderer> Body = new List<SpriteRenderer>(); // tinted with the player's colour
		public Transform[] Dash = new Transform[0];
		public Transform[] Jump = new Transform[0];
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

		var seen = new HashSet<int>();
		foreach (var p in players)
		{
			if (doLog) Debug.Log($"[MpGhost] snapshot id={p.id} name={p.name} pos=({p.x:F1},{p.y:F1}) paused={p.isPaused}");
			seen.Add(p.id);
			var pos = MpOrigin.ToLocal(p.x, p.y);
			var dotColor = ParseColorOr(p.dotColor, new Color(0.4f, 0.6f, 1f, 0.9f));
			var nameColor = ParseColorOr(p.nameColor, new Color(1f, 1f, 1f, 0.9f));
			if (!_ghosts.TryGetValue(p.id, out var g))
			{
				g = Spawn(p.name, pos, dotColor, nameColor);
				_ghosts[p.id] = g;
				var counts = _indicatorCounts.TryGetValue(p.id, out var c) ? c : (0, 0);
				ApplyIndicators(g, counts.Item1, counts.Item2);
			}
			else
			{
				ApplyColors(g, dotColor, nameColor);
			}
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

	private static void ApplyColors(GhostEntry g, Color dotColor, Color nameColor)
	{
		foreach (var partSr in g.Body)
			if (partSr != null) partSr.color = dotColor;
		if (g.Label != null) g.Label.color = nameColor;
	}

	private static GhostEntry Spawn(string name, Vector3 spawnPos, Color dotColor, Color nameColor)
	{
		var root = new GameObject("MPGhost_" + (string.IsNullOrEmpty(name) ? "?" : name));
		Object.DontDestroyOnLoad(root);
		root.transform.position = spawnPos;

		var entry = new GhostEntry { Root = root, LastSeenTime = Time.unscaledTime };
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
			partSr.color = dotColor;
			entry.Body.Add(partSr);
		}

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
		tm.text = string.IsNullOrEmpty(name) ? "?" : name;
		tm.fontSize = 48;
		tm.characterSize = 8f;
		tm.anchor = TextAnchor.MiddleCenter;
		tm.alignment = TextAlignment.Center;
		tm.color = nameColor;

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
		entry.Label = tm;
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

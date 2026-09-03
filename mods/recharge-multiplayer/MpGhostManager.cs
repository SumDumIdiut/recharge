using System.Collections.Generic;
using UnityEngine;

internal static class MpGhostManager
{
	private class GhostEntry
	{
		public GameObject Root;
		public Transform SpriteTransform;
		public Vector3 TargetPos;
		public bool TargetFacingRight;
		public float LastSeenTime;
		public Animator Anim;
		public TextMesh Label;
		public GameObject PausedIndicator;
	}

	private static readonly Dictionary<int, GhostEntry> _ghosts = new Dictionary<int, GhostEntry>();
	private static Transform _spriteTemplate;

	public static void SetTemplate(Transform playerSprite)
	{
		_spriteTemplate = playerSprite;
	}

	public static void ApplySnapshot(List<MpPlayerState> players)
	{
		var seen = new HashSet<int>();
		foreach (var p in players)
		{
			seen.Add(p.id);
			var pos = new Vector3(p.x, p.y, 0f);
			var dotColor = ParseColorOr(p.dotColor, new Color(0.4f, 0.6f, 1f, 0.9f));
			var nameColor = ParseColorOr(p.nameColor, new Color(1f, 1f, 1f, 0.9f));
			if (!_ghosts.TryGetValue(p.id, out var g))
			{
				g = Spawn(p.name, pos, dotColor, nameColor);
				_ghosts[p.id] = g;
			}
			else
			{
				ApplyColors(g, dotColor, nameColor);
			}
			g.TargetPos = pos;
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
		const float staleTimeout = 6f; // a couple of missed snapshots at the ~2-frame poll rate, comfortably
		var stale = new List<int>();
		foreach (var kv in _ghosts)
		{
			var g = kv.Value;
			if (g.Root == null) { stale.Add(kv.Key); continue; }
			if (Time.unscaledTime - g.LastSeenTime > staleTimeout) { stale.Add(kv.Key); continue; }

			var t = g.Root.transform;
			t.position = Vector3.Lerp(t.position, g.TargetPos, 1f - Mathf.Exp(-14f * dt));

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
			c.a = fallback.a; // callers always want the same fixed ghost/label alpha, not whatever the stored hex implied
			return c;
		}
		return fallback;
	}

	private static void ApplyColors(GhostEntry g, Color dotColor, Color nameColor)
	{
		if (g.Root != null)
			foreach (var partSr in g.Root.GetComponentsInChildren<SpriteRenderer>(true))
				partSr.color = dotColor;
		if (g.Label != null) g.Label.color = nameColor;
	}

	private static GhostEntry Spawn(string name, Vector3 spawnPos, Color dotColor, Color nameColor)
	{
		var root = new GameObject("MPGhost_" + (string.IsNullOrEmpty(name) ? "?" : name));
		Object.DontDestroyOnLoad(root);
		root.transform.position = spawnPos;

		SpriteRenderer sr = null;
		Animator anim = null;
		Transform spriteTransform = null;

		if (_spriteTemplate != null)
		{
			var spriteGo = Object.Instantiate(_spriteTemplate.gameObject, root.transform);
			spriteGo.name = "Sprite";
			spriteGo.transform.localPosition = Vector3.zero;
			foreach (var comp in spriteGo.GetComponentsInChildren<Component>())
			{
				if (comp is Transform || comp is SpriteRenderer || comp is Animator) continue;
				Object.Destroy(comp);
			}
			sr = spriteGo.GetComponent<SpriteRenderer>();
			anim = spriteGo.GetComponent<Animator>();
			// ghost position already interpolates on unscaled time (Tick() below), so its
			// animator needs to match or it visibly freezes while the local player's own
			// pause menu sets Time.timeScale to 0
			if (anim != null) anim.updateMode = AnimatorUpdateMode.UnscaledTime;
			spriteTransform = spriteGo.transform;
		}
		else
		{
			sr = root.AddComponent<SpriteRenderer>();
			spriteTransform = root.transform;
		}

		var unlitShader = Shader.Find("Universal Render Pipeline/2D/Sprite-Unlit-Default")
			?? Shader.Find("Sprites/Default");
		foreach (var partSr in root.GetComponentsInChildren<SpriteRenderer>(true))
		{
			if (unlitShader != null) partSr.material = new Material(unlitShader);
			partSr.color = dotColor;
		}

		var labelGo = new GameObject("Label");
		labelGo.transform.SetParent(root.transform);
		// this game's world units run large (camera offsets elsewhere in Movement.cs
		// are in the hundreds) - the original characterSize/offset (1.2, 40) were sized
		// for a typical "1 unit ~= 1 metre" convention and rendered as a barely-visible
		// speck. First attempt at scaling that up (40, 110) overshot hugely (confirmed
		// live - the name rendered taller than the character itself); this is that
		// same jump scaled back down to roughly a quarter of the character's height
		labelGo.transform.localPosition = new Vector3(0f, 75f, 0f);
		var tm = labelGo.AddComponent<TextMesh>();
		tm.text = string.IsNullOrEmpty(name) ? "?" : name;
		tm.fontSize = 48;
		tm.characterSize = 8f;
		// MiddleCenter instead of LowerCenter: anchoring off the bottom placed each name
		// at a slightly different height depending on whether it had descenders (g/y/j/
		// p/q) or not, since the baseline is fixed but the text's own bounds aren't -
		// centering vertically keeps every name sitting at the same spot regardless
		tm.anchor = TextAnchor.MiddleCenter;
		tm.alignment = TextAlignment.Center;
		tm.color = nameColor;

		var pausedGo = new GameObject("PausedIndicator");
		pausedGo.transform.SetParent(root.transform);
		pausedGo.transform.localPosition = new Vector3(0f, 105f, 0f); // above the name label
		var pausedTm = pausedGo.AddComponent<TextMesh>();
		pausedTm.text = "PAUSED";
		pausedTm.fontSize = 48;
		pausedTm.characterSize = 6f;
		pausedTm.anchor = TextAnchor.MiddleCenter;
		pausedTm.alignment = TextAlignment.Center;
		pausedTm.color = new Color(1f, 0.85f, 0.2f);
		pausedGo.SetActive(false); // only shown while a snapshot reports this player as paused

		return new GhostEntry
		{
			Root = root,
			SpriteTransform = spriteTransform,
			Label = tm,
			Anim = anim,
			PausedIndicator = pausedGo,
			TargetPos = spawnPos,
			LastSeenTime = Time.unscaledTime,
		};
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
	}
}

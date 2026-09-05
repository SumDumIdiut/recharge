using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Newtonsoft.Json.Linq;
using Recharge.ModApi;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

internal class PartyGamesController : MonoBehaviour
{
	private IRechargeHost _host;
	private pauseMenuScript _menu;
	private GameObject _partyGamesPanel;

	private Button _modeButton;
	private Button _mapButton;
	private Button _readyButton;
	private GameObject _rosterGo;
	private Button _startButton;
	private GameObject _statusGo;

	private readonly (string Key, string Label)[] _abilityDefs =
	{
		("dash", "Dash"), ("wallJump", "Wall Jump"), ("doubleJump", "Double Jump"),
		("blockSwap", "Block Swap"), ("omniDash", "Omni Dash"),
	};
	private readonly Dictionary<string, bool> _abilityEnabled = new Dictionary<string, bool>
	{
		["dash"] = true, ["wallJump"] = true, ["doubleJump"] = true, ["blockSwap"] = true, ["omniDash"] = true,
	};
	private readonly List<(string Key, Button Btn)> _abilityButtons = new List<(string, Button)>();
	private readonly Dictionary<string, bool> _abilityRestore = new Dictionary<string, bool>();

	private List<MpMapLibrary.HostableMap> _hostableMaps = new List<MpMapLibrary.HostableMap>();
	private int _selectedMapIndex = -1; // -1 = current map, don't touch it
	private volatile bool _mapListLoading;

	private readonly Dictionary<int, bool> _readyStates = new Dictionary<int, bool>();

	public void Init(IRechargeHost host)
	{
		_host = host;
	}

	public void InstallMenuRow(pauseMenuScript menu)
	{
		_menu = menu;
		if (MpNetworkManager.LatestInLobbyRow == null) return; // DOTnet's own panel hasn't built its in-lobby row yet this scene

		if (MpNetworkManager.LatestInLobbyRow.transform.Find("PartyGamesToggle") == null)
		{
			var toggleTemplate = menu.mainBitPublic.transform.Find("Settings")?.gameObject;
			if (toggleTemplate != null)
			{
				var toggleGo = Object.Instantiate(toggleTemplate, MpNetworkManager.LatestInLobbyRow.transform);
				toggleGo.name = "PartyGamesToggle";
				toggleGo.SetActive(true);
				var toggleRt = (RectTransform)toggleGo.transform;
				toggleRt.anchoredPosition = new Vector2(150, -160);
				toggleRt.sizeDelta = new Vector2(270, 60);
				PauseMenuHelper.SetButtonLabel(toggleGo, "Party Games");
				var toggleBtn = toggleGo.GetComponent<Button>();
				toggleBtn.onClick = new Button.ButtonClickedEvent();
				toggleBtn.onClick.AddListener(OnTogglePartyGamesClicked);
			}
		}

		if (menu.settingsBitPublic.transform.parent.Find("PartyGamesBit") != null) return;

		var panel = BuildStandalonePanel(menu);
		if (panel == null) return;

		var template = menu.mainBitPublic.transform.Find("Settings")?.gameObject;
		if (template == null) return;

		_modeButton = BuildActionButton(panel.transform, template, "Mode: Hide & Seek", new Vector2(0, 160), OnCycleModeClicked, width: 380, height: 48, fontSize: 20f);
		_mapButton = BuildActionButton(panel.transform, template, "Map: Current Map", new Vector2(0, 100), OnCycleMapClicked, width: 380, height: 48, fontSize: 20f);

		float[] xs = { -232, -116, 0, 116, 232 };
		for (int i = 0; i < _abilityDefs.Length; i++)
		{
			var key = _abilityDefs[i].Key;
			var go = Object.Instantiate(template, panel.transform);
			go.name = "PartyGames_Ability_" + key;
			go.SetActive(true);
			var rt = (RectTransform)go.transform;
			rt.anchoredPosition = new Vector2(xs[i], 50);
			rt.sizeDelta = new Vector2(110, 44);
			var abilityText = go.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
			if (abilityText != null)
			{
				var textRt = (RectTransform)abilityText.transform;
				textRt.anchorMin = Vector2.zero;
				textRt.anchorMax = Vector2.one;
				textRt.offsetMin = new Vector2(4, textRt.offsetMin.y);
				textRt.offsetMax = new Vector2(-4, textRt.offsetMax.y);
				abilityText.alignment = TextAlignmentOptions.Center;
				abilityText.enableAutoSizing = true;
				abilityText.fontSizeMin = 9f;
				abilityText.fontSizeMax = 16f;
				abilityText.textWrappingMode = TextWrappingModes.NoWrap;
				abilityText.overflowMode = TextOverflowModes.Overflow;
			}
			var btn = go.GetComponent<Button>();
			btn.onClick = new Button.ButtonClickedEvent();
			btn.onClick.AddListener(() => _abilityEnabled[key] = !_abilityEnabled[key]);
			_abilityButtons.Add((key, btn));
		}

		var readyGo = Object.Instantiate(template, panel.transform);
		readyGo.name = "PartyGames_Ready";
		readyGo.SetActive(true); // template may be inactive if mainBitPublic is hidden when this panel gets (re)built
		var readyRt = (RectTransform)readyGo.transform;
		readyRt.anchoredPosition = new Vector2(0, 0);
		readyRt.sizeDelta = new Vector2(220, 44);
		_readyButton = readyGo.GetComponent<Button>();
		_readyButton.onClick = new Button.ButtonClickedEvent();
		_readyButton.onClick.AddListener(OnReadyClicked);

		_rosterGo = Object.Instantiate(template, panel.transform);
		_rosterGo.name = "PartyGamesRoster";
		_rosterGo.SetActive(true);
		var rosterBtn = _rosterGo.GetComponent<Button>();
		if (rosterBtn != null) rosterBtn.enabled = false;
		var rosterRt = (RectTransform)_rosterGo.transform;
		rosterRt.anchoredPosition = new Vector2(0, -55);
		rosterRt.sizeDelta = new Vector2(560, 70);
		var rosterText = _rosterGo.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (rosterText != null) { rosterText.enableAutoSizing = false; rosterText.fontSize = 14; rosterText.textWrappingMode = TextWrappingModes.Normal; }

		_startButton = BuildActionButton(panel.transform, template, "Start Game", new Vector2(0, -125), OnStartClicked);

		_statusGo = Object.Instantiate(template, panel.transform);
		_statusGo.name = "PartyGamesStatus";
		_statusGo.SetActive(true);
		var statusBtn = _statusGo.GetComponent<Button>();
		if (statusBtn != null) statusBtn.enabled = false;
		var statusRt = (RectTransform)_statusGo.transform;
		statusRt.anchoredPosition = new Vector2(0, -180);
		statusRt.sizeDelta = new Vector2(560, 40);
		var statusText = _statusGo.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (statusText != null) { statusText.enableAutoSizing = false; statusText.fontSize = 16; statusText.textWrappingMode = TextWrappingModes.Normal; }

		RefreshMapList();
	}

	private void OnTogglePartyGamesClicked()
	{
		if (_partyGamesPanel == null) return;
		if (MpNetworkManager.LatestMpPanel != null) MpNetworkManager.LatestMpPanel.SetActive(false);
		_partyGamesPanel.SetActive(true);
	}

	// Hand-rolled clone-and-strip - mirrors MpMenuBuilder.BuildPanel's own
	// technique in recharge-multiplayer (deliberately not shared ModApi code,
	// same as that mod doesn't use PauseMenuHelper.AddPanelRow for its own
	// panel either) since Back here needs to return to DOTnet's panel, not
	// the main pause menu.
	private GameObject BuildStandalonePanel(pauseMenuScript menu)
	{
		var existing = menu.settingsBitPublic.transform.parent.Find("PartyGamesBit");
		if (existing != null) { _partyGamesPanel = existing.gameObject; return _partyGamesPanel; }

		var clone = Object.Instantiate(menu.settingsBitPublic, menu.settingsBitPublic.transform.parent);
		clone.name = "PartyGamesBit";
		clone.SetActive(false);

		var settingsScript = clone.GetComponent<SettingsScript>();
		if (settingsScript != null) Object.Destroy(settingsScript);

		Transform title = null;
		foreach (Transform child in clone.transform)
		{
			if (child.name != "Settings") continue;
			title = child;
			break;
		}
		if (title == null && clone.transform.childCount > 0) title = clone.transform.GetChild(0);

		var toDestroy = new List<GameObject>();
		foreach (Transform child in clone.transform)
			if (child != title) toDestroy.Add(child.gameObject);
		foreach (var go in toDestroy) Object.Destroy(go);

		if (title != null)
		{
			var titleTmp = title.GetComponent<TMP_Text>();
			if (titleTmp != null) titleTmp.text = "Party Games";
			var loc = title.GetComponent<UnityEngine.Localization.Components.LocalizeStringEvent>();
			if (loc != null) Object.Destroy(loc);

			var closeBtn = title.Find("Close");
			if (closeBtn != null)
			{
				PauseMenuHelper.SetButtonLabel(closeBtn.gameObject, "Back");
				var btn = closeBtn.GetComponent<Button>();
				btn.onClick = new Button.ButtonClickedEvent();
				btn.onClick.AddListener(() =>
				{
					clone.SetActive(false);
					if (MpNetworkManager.LatestMpPanel != null) MpNetworkManager.LatestMpPanel.SetActive(true);
				});
			}
		}

		_partyGamesPanel = clone;
		return clone;
	}

	private void OnCycleModeClicked()
	{
		_mode = _mode == Mode.HideAndSeek ? Mode.Infection : Mode.HideAndSeek;
	}

	private void OnCycleMapClicked()
	{
		_selectedMapIndex++;
		if (_selectedMapIndex >= _hostableMaps.Count) _selectedMapIndex = -1;
	}

	private static Button BuildActionButton(Transform parent, GameObject template, string label, Vector2 pos, System.Action onClick, float width = 260, float height = 60, float fontSize = 24f)
	{
		var go = Object.Instantiate(template, parent);
		go.name = "PartyGames_" + label;
		go.SetActive(true);
		var rt = (RectTransform)go.transform;
		rt.anchoredPosition = pos;
		rt.sizeDelta = new Vector2(width, height);
		PauseMenuHelper.SetButtonLabel(go, label);
		var text = go.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (text != null) { text.enableAutoSizing = false; text.fontSize = fontSize; text.textWrappingMode = TextWrappingModes.NoWrap; text.overflowMode = TextOverflowModes.Overflow; }
		var btn = go.GetComponent<Button>();
		btn.onClick = new Button.ButtonClickedEvent();
		btn.onClick.AddListener(() => onClick());
		return btn;
	}

	private void RefreshMapList()
	{
		if (_mapListLoading) return;
		_mapListLoading = true;
		new Thread(() =>
		{
			try { _hostableMaps = MpMapLibrary.GetHostableMaps(); }
			finally { _mapListLoading = false; _selectedMapIndex = -1; }
		})
		{ IsBackground = true }.Start();
	}

	private bool AllReady(MpNetworkManager mgr)
	{
		if (!_readyStates.TryGetValue(mgr.LocalPlayerId, out var self) || !self) return false;
		foreach (var p in mgr.LastSnapshotPlayers)
			if (!_readyStates.TryGetValue(p.id, out var r) || !r) return false;
		return true;
	}

	private void RefreshMenu()
	{
		var mgr = MpNetworkManager.Instance;

		bool inLobby = mgr != null && mgr.InLobby;
		bool isHost = mgr != null && mgr.IsHost;
		bool canConfigure = isHost && inLobby && !_roundActive;

		if (_modeButton != null)
		{
			_modeButton.interactable = canConfigure;
			PauseMenuHelper.SetButtonLabel(_modeButton.gameObject, "Mode: " + (_mode == Mode.Infection ? "Infection" : "Hide & Seek"));
		}
		if (_mapButton != null)
		{
			_mapButton.interactable = canConfigure;
			var mapLabel = _selectedMapIndex >= 0 && _selectedMapIndex < _hostableMaps.Count ? _hostableMaps[_selectedMapIndex].Name : "Current Map";
			PauseMenuHelper.SetButtonLabel(_mapButton.gameObject, "Map: " + mapLabel);
		}

		foreach (var (key, btn) in _abilityButtons)
		{
			if (btn == null) continue;
			bool enabled = _abilityEnabled[key];
			btn.interactable = canConfigure;
			var label = _abilityDefs.First(d => d.Key == key).Label;
			PauseMenuHelper.SetButtonLabel(btn.gameObject, label);
			var img = btn.GetComponent<Image>();
			if (img != null) img.color = enabled ? new Color(0.25f, 0.5f, 0.25f) : new Color(0.5f, 0.2f, 0.2f);
		}

		if (_readyButton != null)
		{
			_readyButton.interactable = inLobby && !_roundActive;
			bool ready = mgr != null && _readyStates.TryGetValue(mgr.LocalPlayerId, out var r) && r;
			PauseMenuHelper.SetButtonLabel(_readyButton.gameObject, ready ? "Ready!" : "Ready Up");
		}

		if (_rosterGo != null)
		{
			if (mgr == null || !inLobby) PauseMenuHelper.SetButtonLabel(_rosterGo, "");
			else
			{
				var sb = new System.Text.StringBuilder();
				bool selfReady = _readyStates.TryGetValue(mgr.LocalPlayerId, out var sr) && sr;
				sb.Append("You: ").Append(selfReady ? "Ready" : "Waiting");
				foreach (var p in mgr.LastSnapshotPlayers)
				{
					bool ready = _readyStates.TryGetValue(p.id, out var rr) && rr;
					sb.Append('\n').Append(p.name ?? ("Player " + p.id)).Append(": ").Append(ready ? "Ready" : "Waiting");
				}
				PauseMenuHelper.SetButtonLabel(_rosterGo, sb.ToString());
			}
		}

		if (_startButton != null) _startButton.interactable = mgr != null && inLobby && isHost && !_roundActive && AllReady(mgr);

		if (_statusGo == null) return;
		string statusText;
		if (mgr == null || !inLobby) statusText = "Host or join a lobby to play.";
		else if (_roundActive) statusText = "Round in progress.";
		else if (!isHost) statusText = "Waiting for the host to start.";
		else statusText = _statusMessage;
		PauseMenuHelper.SetButtonLabel(_statusGo, statusText);
	}

	private enum Mode { HideAndSeek, Infection }
	private Mode _mode = Mode.HideAndSeek;
	private bool _roundActive;
	private float _hideEndTime;
	private float _roundEndTime;
	private int _seekerId = -1;
	private readonly HashSet<int> _infected = new HashSet<int>();
	private readonly HashSet<int> _found = new HashSet<int>();
	private bool _movementFrozen;
	private bool _seekerReleased;
	private string _roundMapHubId;
	private volatile bool _mapDownloading;
	private string _prevDotColor;
	private string _prevNameColor;
	private string _statusMessage = "";

	private const float HideSeconds = 15f;
	private const float RoundSeconds = 180f;
	private const float TagRadius = 60f;

	private Movement _localMovement;

	private void Update()
	{
		RefreshMenu();

		var mgr = MpNetworkManager.Instance;
		if (mgr == null) return;

		mgr.OnGameMessage -= OnGameMessage; // idempotent re-subscribe - MpNetworkManager can be recreated across scenes
		mgr.OnGameMessage += OnGameMessage;

		if (_localMovement == null)
		{
			var playerGo = GameObject.FindGameObjectWithTag("Player");
			if (playerGo != null) _localMovement = playerGo.GetComponent<Movement>();
		}

		if (!mgr.InLobby) { EndRoundLocally("left the lobby"); return; }
		if (!_roundActive) return;

		bool hiding = Time.time < _hideEndTime;
		if (_localMovement != null)
		{
			bool shouldFreeze = hiding && IsLocalSeeking();
			if (shouldFreeze != _movementFrozen)
			{
				_localMovement.enabled = !shouldFreeze;
				_movementFrozen = shouldFreeze;
			}
		}

		if (!hiding && IsLocalSeeking() && !_seekerReleased)
		{
			_seekerReleased = true;
			EnsureMapLoaded(_roundMapHubId);
		}

		if (!hiding && IsLocalSeeking() && _localMovement != null)
		{
			foreach (var p in mgr.LastSnapshotPlayers)
			{
				if (IsOut(p.id)) continue;
				var dist = Vector2.Distance(_localMovement.transform.position, new Vector2(p.x, p.y));
				if (dist <= TagRadius) mgr.SendGameMessage(new JObject { ["k"] = "tag", ["target"] = p.id });
			}
		}

		if (Time.time >= _roundEndTime) EndRoundLocally("time's up");
	}

	private bool IsLocalSeeking()
	{
		var mgr = MpNetworkManager.Instance;
		if (_mode == Mode.HideAndSeek) return mgr.LocalPlayerId == _seekerId;
		return _infected.Contains(mgr.LocalPlayerId);
	}

	private bool IsOut(int playerId)
	{
		return _mode == Mode.HideAndSeek ? _found.Contains(playerId) || playerId == _seekerId : _infected.Contains(playerId);
	}

	private void OnGameMessage(int from, JObject payload)
	{
		var kind = (string)payload["k"];
		if (kind == "ready")
		{
			_readyStates[from] = (bool)payload["ready"];
		}
		else if (kind == "start")
		{
			_mode = (string)payload["mode"] == "infection" ? Mode.Infection : Mode.HideAndSeek;
			_seekerId = (int)payload["seeker"];
			_infected.Clear();
			_found.Clear();
			_readyStates.Clear();
			if (_mode == Mode.Infection) _infected.Add(_seekerId);
			_hideEndTime = Time.time + (float)payload["hideSeconds"];
			_roundEndTime = Time.time + (float)payload["roundSeconds"];
			_roundActive = true;
			_seekerReleased = false;
			_roundMapHubId = (string)payload["mapHubId"];
			ApplyLocalAppearance();
			ApplyAbilityRestrictions(payload["abilities"] as JObject);
			_statusMessage = "Round started!";
			if (!IsLocalSeeking()) EnsureMapLoaded(_roundMapHubId);
		}
		else if (kind == "tag" && _roundActive)
		{
			var target = (int)payload["target"];
			if (_mode == Mode.HideAndSeek)
			{
				if (target != _seekerId && _found.Add(target))
				{
					if (target == MpNetworkManager.Instance.LocalPlayerId) _statusMessage = "You were found!";
					var totalOthers = MpNetworkManager.Instance.LastSnapshotPlayers.Count;
					if (_found.Count >= totalOthers) EndRoundLocally("everyone was found");
				}
			}
			else
			{
				if (_infected.Add(target))
				{
					if (target == MpNetworkManager.Instance.LocalPlayerId) ApplyLocalAppearance();
					var totalPlayers = MpNetworkManager.Instance.LastSnapshotPlayers.Count + 1;
					if (_infected.Count >= totalPlayers) EndRoundLocally("everyone was infected");
				}
			}
		}
	}

	private void EnsureMapLoaded(string mapHubId)
	{
		if (string.IsNullOrEmpty(mapHubId) || _host == null) return;
		if (MpMapLibrary.IsDownloaded(mapHubId)) { _host.Events.Emit("recharge.maps.load_requested", mapHubId); return; }
		if (_mapDownloading) return;
		_mapDownloading = true;
		_statusMessage = "Downloading map...";
		new Thread(() =>
		{
			try
			{
				MpMapLibrary.DownloadAndExtract(mapHubId);
				_host.Events.Emit("recharge.maps.load_requested", mapHubId);
			}
			catch (System.Exception e) { _statusMessage = "Map download failed: " + e.Message; }
			finally { _mapDownloading = false; }
		})
		{ IsBackground = true }.Start();
	}

	private void ApplyAbilityRestrictions(JObject abilities)
	{
		_abilityRestore.Clear();
		if (abilities == null || _localMovement == null) return;
		ApplyAbility(abilities, "dash", () => _localMovement.dashUnlocked, v => _localMovement.dashUnlocked = v);
		ApplyAbility(abilities, "wallJump", () => _localMovement.wallJumpUnlocked, v => _localMovement.wallJumpUnlocked = v);
		ApplyAbility(abilities, "doubleJump", () => _localMovement.doubleJumpUnlocked, v => _localMovement.doubleJumpUnlocked = v);
		ApplyAbility(abilities, "blockSwap", () => _localMovement.blockSwapUnlocked, v => _localMovement.blockSwapUnlocked = v);
		ApplyAbility(abilities, "omniDash", () => _localMovement.omniDashUnlocked, v => _localMovement.omniDashUnlocked = v);
	}

	private void ApplyAbility(JObject abilities, string key, System.Func<bool> get, System.Action<bool> set)
	{
		var allowed = abilities[key]?.Value<bool>() ?? true;
		if (allowed) return; // leave the player's own progression untouched
		_abilityRestore[key] = get();
		set(false);
	}

	private void RestoreAbilities()
	{
		if (_localMovement != null)
		{
			foreach (var kv in _abilityRestore)
			{
				switch (kv.Key)
				{
					case "dash": _localMovement.dashUnlocked = kv.Value; break;
					case "wallJump": _localMovement.wallJumpUnlocked = kv.Value; break;
					case "doubleJump": _localMovement.doubleJumpUnlocked = kv.Value; break;
					case "blockSwap": _localMovement.blockSwapUnlocked = kv.Value; break;
					case "omniDash": _localMovement.omniDashUnlocked = kv.Value; break;
				}
			}
		}
		_abilityRestore.Clear();
	}

	private void ApplyLocalAppearance()
	{
		if (!IsLocalSeeking()) return;
		_prevDotColor = MpNetworkManager.GetDotColorHex();
		_prevNameColor = MpNetworkManager.GetNameColorHex();
		MpNetworkManager.SetDotColorHex("#FF0000");
		MpNetworkManager.SetNameColorHex("#FF0000");
	}

	private void EndRoundLocally(string reason)
	{
		if (!_roundActive) return;
		_roundActive = false;
		_seekerReleased = false;
		_roundMapHubId = null;
		_statusMessage = "Round over: " + reason;
		if (_localMovement != null && _movementFrozen) { _localMovement.enabled = true; _movementFrozen = false; }
		if (_prevDotColor != null) { MpNetworkManager.SetDotColorHex(_prevDotColor); MpNetworkManager.SetNameColorHex(_prevNameColor); _prevDotColor = null; _prevNameColor = null; }
		RestoreAbilities();
	}

	private void OnReadyClicked()
	{
		var mgr = MpNetworkManager.Instance;
		if (mgr == null || !mgr.InLobby) return;
		bool currentlyReady = _readyStates.TryGetValue(mgr.LocalPlayerId, out var r) && r;
		mgr.SendGameMessage(new JObject { ["k"] = "ready", ["ready"] = !currentlyReady });
	}

	private void OnStartClicked()
	{
		var mgr = MpNetworkManager.Instance;
		if (mgr == null || !mgr.InLobby || !mgr.IsHost || _roundActive) return;
		if (!AllReady(mgr)) { _statusMessage = "Waiting for everyone to be ready."; return; }

		var others = mgr.LastSnapshotPlayers.Select(p => p.id).ToList();
		var everyone = new List<int>(others) { mgr.LocalPlayerId };
		if (everyone.Count < 2) { _statusMessage = "Need at least 2 players."; return; }
		var seeker = everyone[Random.Range(0, everyone.Count)];

		string mapHubId = null, mapName = null;
		if (_selectedMapIndex >= 0 && _selectedMapIndex < _hostableMaps.Count)
		{
			var map = _hostableMaps[_selectedMapIndex];
			mapHubId = map.HubId;
			mapName = map.Name;
		}

		var abilities = new JObject();
		foreach (var kv in _abilityEnabled) abilities[kv.Key] = kv.Value;

		mgr.SendGameMessage(new JObject
		{
			["k"] = "start",
			["mode"] = _mode == Mode.Infection ? "infection" : "hideandseek",
			["seeker"] = seeker,
			["hideSeconds"] = HideSeconds,
			["roundSeconds"] = RoundSeconds,
			["mapHubId"] = mapHubId,
			["mapName"] = mapName,
			["abilities"] = abilities,
		});
	}

	private void OnGUI()
	{
		DrawHud();
	}

	private void DrawHud()
	{
		if (!_roundActive) return;
		var mgr = MpNetworkManager.Instance;
		if (mgr == null) return;
		string label;
		if (Time.time < _hideEndTime)
		{
			var left = Mathf.CeilToInt(_hideEndTime - Time.time);
			label = IsLocalSeeking() ? "Hiders are hiding: " + left + "s" : "Hide! " + left + "s";
		}
		else
		{
			var left = Mathf.CeilToInt(_roundEndTime - Time.time);
			label = (_mode == Mode.HideAndSeek ? "Hide and Seek" : "Infection") + " - " + left + "s left";
			if (IsLocalSeeking()) label += _mode == Mode.HideAndSeek ? " (you're it)" : " (infected)";
		}
		var rect = new Rect(20, 20, 400, 30);
		GUI.Box(rect, "");
		var style = new GUIStyle(GUI.skin.label) { fontSize = 18, normal = { textColor = IsLocalSeeking() ? Color.red : Color.white } };
		GUI.Label(rect, label, style);
	}
}

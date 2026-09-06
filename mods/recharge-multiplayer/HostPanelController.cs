using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Newtonsoft.Json.Linq;
using Recharge.ModApi;
using TMPro;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.UI;

internal class HostPanelController : MonoBehaviour
{
	private IRechargeHost _host;
	private pauseMenuScript _menu;
	private GameObject _hostPanel;
	private Button _toggleButton;
	private bool _autoReadyTried;
	private int _lastKnownPlayerId;
	private bool _localReadyIntent;

	private Button _modeButton;
	private Button _mapButton;
	private GameObject _rosterGo;
	private Button _startButton;
	private GameObject _statusGo;

	private readonly (string Key, string Label)[] _abilityDefs =
	{
		("dash", "Dash"), ("wallJump", "Wall Jump"), ("doubleJump", "Double Jump"),
		("blockSwap", "Block Swap"),
	};
	private readonly Dictionary<string, bool> _abilityEnabled = new Dictionary<string, bool>
	{
		["dash"] = true, ["wallJump"] = true, ["doubleJump"] = true, ["blockSwap"] = true,
	};
	private readonly List<(string Key, Button Btn)> _abilityButtons = new List<(string, Button)>();
	private readonly Dictionary<string, bool> _abilityRestore = new Dictionary<string, bool>();

	private List<MpMapLibrary.HostableMap> _hostableMaps = new List<MpMapLibrary.HostableMap>();
	private int _selectedMapIndex = -1; // -1 = current map, don't touch it
	private volatile bool _mapListLoading;

	private readonly Dictionary<int, bool> _readyStates = new Dictionary<int, bool>();
	private readonly Dictionary<int, float> _lastTagSentAt = new Dictionary<int, float>();
	private const float TagResendInterval = 1f;

	public void Init(IRechargeHost host)
	{
		_host = host;
	}

	public void InstallMenuRow(pauseMenuScript menu)
	{
		_menu = menu;
		if (MpNetworkManager.LatestInLobbyRow == null) return; // DOTnet's own panel hasn't built its in-lobby row yet this scene

		if (MpNetworkManager.LatestInLobbyRow.transform.Find("HostPanelToggle") == null)
		{
			var toggleTemplate = menu.mainBitPublic.transform.Find("Settings")?.gameObject;
			if (toggleTemplate != null)
			{
				var toggleGo = Object.Instantiate(toggleTemplate, MpNetworkManager.LatestInLobbyRow.transform);
				toggleGo.name = "HostPanelToggle";
				toggleGo.SetActive(true);
				var toggleRt = (RectTransform)toggleGo.transform;
				toggleRt.anchoredPosition = new Vector2(150, -160);
				toggleRt.sizeDelta = new Vector2(270, 60);
				PauseMenuHelper.SetButtonLabel(toggleGo, "Host Panel");
				_toggleButton = toggleGo.GetComponent<Button>();
				_toggleButton.onClick = new Button.ButtonClickedEvent();
				_toggleButton.onClick.AddListener(OnToggleOrReadyClicked);
			}
		}

		if (menu.settingsBitPublic.transform.parent.Find("HostPanelBit") != null) return;

		var panel = BuildStandalonePanel(menu);
		if (panel == null) return;

		var template = menu.mainBitPublic.transform.Find("Settings")?.gameObject;
		if (template == null) return;

		_modeButton = BuildActionButton(panel.transform, template, "Mode: Normal", new Vector2(0, 170), OnCycleModeClicked, width: 380, height: 48, fontSize: 20f);
		_mapButton = BuildActionButton(panel.transform, template, "Map: Current Map", new Vector2(0, 115), OnCycleMapClicked, width: 380, height: 48, fontSize: 20f);

		CreateDivider(panel.transform, new Vector2(0, 88), 420);

		var abilityCaptionGo = Object.Instantiate(template, panel.transform);
		abilityCaptionGo.name = "HostPanel_AbilityCaption";
		abilityCaptionGo.SetActive(true);
		var abilityCaptionBtn = abilityCaptionGo.GetComponent<Button>();
		if (abilityCaptionBtn != null) abilityCaptionBtn.enabled = false;
		var abilityCaptionRt = (RectTransform)abilityCaptionGo.transform;
		abilityCaptionRt.anchoredPosition = new Vector2(0, 72);
		abilityCaptionRt.sizeDelta = new Vector2(380, 26);
		var abilityCaptionText = abilityCaptionGo.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (abilityCaptionText != null)
		{
			abilityCaptionText.enableAutoSizing = false;
			abilityCaptionText.fontSize = 15;
			abilityCaptionText.color = new Color(1f, 1f, 1f, 0.6f);
			abilityCaptionText.textWrappingMode = TextWrappingModes.NoWrap;
			abilityCaptionText.overflowMode = TextOverflowModes.Overflow;
		}
		PauseMenuHelper.SetButtonLabel(abilityCaptionGo, "Abilities (tap to toggle)");

		float[] xs = { -174, -58, 58, 174 };
		for (int i = 0; i < _abilityDefs.Length; i++)
		{
			var key = _abilityDefs[i].Key;
			var go = Object.Instantiate(template, panel.transform);
			go.name = "HostPanel_Ability_" + key;
			go.SetActive(true);
			var rt = (RectTransform)go.transform;
			rt.anchoredPosition = new Vector2(xs[i], 35);
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
				abilityText.fontSizeMin = 8f;
				abilityText.fontSizeMax = 16f;
				abilityText.textWrappingMode = TextWrappingModes.NoWrap;
				abilityText.overflowMode = TextOverflowModes.Overflow;
			}
			var btn = go.GetComponent<Button>();
			btn.onClick = new Button.ButtonClickedEvent();
			btn.onClick.AddListener(() => _abilityEnabled[key] = !_abilityEnabled[key]);
			_abilityButtons.Add((key, btn));
		}

		CreateDivider(panel.transform, new Vector2(0, 9), 420);

		var rosterBoxGo = new GameObject("HostPanelRosterBox", typeof(RectTransform), typeof(Image));
		rosterBoxGo.transform.SetParent(panel.transform, false);
		var rosterBoxRt = (RectTransform)rosterBoxGo.transform;
		rosterBoxRt.anchoredPosition = new Vector2(0, -35);
		rosterBoxRt.sizeDelta = new Vector2(420, 80);
		rosterBoxGo.GetComponent<Image>().color = new Color(0f, 0f, 0f, 0.25f);

		_rosterGo = Object.Instantiate(template, panel.transform);
		_rosterGo.name = "HostPanelRoster";
		_rosterGo.SetActive(true);
		var rosterBtn = _rosterGo.GetComponent<Button>();
		if (rosterBtn != null) rosterBtn.enabled = false;
		var rosterImg = _rosterGo.GetComponent<Image>();
		if (rosterImg != null) rosterImg.color = new Color(0f, 0f, 0f, 0f);
		var rosterRt = (RectTransform)_rosterGo.transform;
		rosterRt.anchoredPosition = new Vector2(0, -35);
		rosterRt.sizeDelta = new Vector2(400, 72);
		var rosterText = _rosterGo.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (rosterText != null) { rosterText.enableAutoSizing = false; rosterText.fontSize = 14; rosterText.textWrappingMode = TextWrappingModes.Normal; }

		_startButton = BuildActionButton(panel.transform, template, "Start Playing", new Vector2(0, -110), OnStartOrStopClicked);

		_statusGo = Object.Instantiate(template, panel.transform);
		_statusGo.name = "HostPanelStatus";
		_statusGo.SetActive(true);
		var statusBtn = _statusGo.GetComponent<Button>();
		if (statusBtn != null) statusBtn.enabled = false;
		var statusRt = (RectTransform)_statusGo.transform;
		statusRt.anchoredPosition = new Vector2(0, -170);
		statusRt.sizeDelta = new Vector2(560, 40);
		var statusText = _statusGo.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (statusText != null) { statusText.enableAutoSizing = false; statusText.fontSize = 16; statusText.textWrappingMode = TextWrappingModes.Normal; }

		RefreshMapList();
	}

	// Host gets the full config panel; everyone else just gets a Ready toggle.
	private void OnToggleOrReadyClicked()
	{
		var mgr = MpNetworkManager.Instance;
		if (mgr != null && mgr.IsHost) OnToggleHostPanelClicked();
		else OnReadyClicked();
	}

	private void OnToggleHostPanelClicked()
	{
		if (_hostPanel == null) return;
		if (MpNetworkManager.LatestMpPanel != null) MpNetworkManager.LatestMpPanel.SetActive(false);
		_hostPanel.SetActive(true);
	}

	private GameObject BuildStandalonePanel(pauseMenuScript menu)
	{
		var existing = menu.settingsBitPublic.transform.parent.Find("HostPanelBit");
		if (existing != null) { _hostPanel = existing.gameObject; return _hostPanel; }

		var clone = Object.Instantiate(menu.settingsBitPublic, menu.settingsBitPublic.transform.parent);
		clone.name = "HostPanelBit";
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
			if (titleTmp != null) titleTmp.text = "Host Panel";
			var loc = title.GetComponent<UnityEngine.Localization.Components.LocalizeStringEvent>();
			if (loc != null) Object.DestroyImmediate(loc);

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

		_hostPanel = clone;
		return clone;
	}

	private void OnCycleModeClicked()
	{
		_mode = _mode switch
		{
			Mode.Normal => Mode.HideAndSeek,
			Mode.HideAndSeek => Mode.Infection,
			Mode.Infection => Mode.Coop,
			_ => Mode.Normal,
		};
	}

	private void OnCycleMapClicked()
	{
		_selectedMapIndex++;
		if (_selectedMapIndex >= _hostableMaps.Count) _selectedMapIndex = -1;
	}

	private static void CreateDivider(Transform parent, Vector2 pos, float width)
	{
		var go = new GameObject("Divider", typeof(RectTransform));
		go.transform.SetParent(parent, false);
		var rt = (RectTransform)go.transform;
		rt.anchoredPosition = pos;
		rt.sizeDelta = new Vector2(width, 2);
		go.AddComponent<Image>().color = new Color(1f, 1f, 1f, 0.15f);
	}

	private static Button BuildActionButton(Transform parent, GameObject template, string label, Vector2 pos, System.Action onClick, float width = 260, float height = 60, float fontSize = 24f)
	{
		var go = Object.Instantiate(template, parent);
		go.name = "HostPanel_" + label;
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

		if (!inLobby) { _autoReadyTried = false; _localReadyIntent = false; _lastKnownPlayerId = 0; }
		else if (isHost && !_autoReadyTried)
		{
			_autoReadyTried = true;
			mgr.SendGameMessage(new JObject { ["k"] = "ready", ["ready"] = true });
		}

		// A silent auto-reconnect hands out a brand new connection id, which
		// orphans this client's own entry in everyone's _readyStates - resend
		// it under the new id so the roster doesn't stay stuck on "Waiting".
		if (mgr != null && mgr.LocalPlayerId != 0 && mgr.LocalPlayerId != _lastKnownPlayerId)
		{
			bool resumed = _lastKnownPlayerId != 0 && inLobby;
			_lastKnownPlayerId = mgr.LocalPlayerId;
			if (resumed)
			{
				_autoReadyTried = true;
				mgr.SendGameMessage(new JObject { ["k"] = "ready", ["ready"] = isHost || _localReadyIntent });
			}
		}

		if (_toggleButton != null)
		{
			if (isHost) PauseMenuHelper.SetButtonLabel(_toggleButton.gameObject, "Host Panel");
			else
			{
				bool ready = mgr != null && _readyStates.TryGetValue(mgr.LocalPlayerId, out var tr) && tr;
				PauseMenuHelper.SetButtonLabel(_toggleButton.gameObject, ready ? "Unready" : "Ready");
			}
		}

		if (_modeButton != null)
		{
			_modeButton.interactable = canConfigure;
			var modeLabel = _mode == Mode.Infection ? "Infection" : _mode == Mode.HideAndSeek ? "Hide & Seek" : _mode == Mode.Coop ? "Co-op" : "Normal";
			PauseMenuHelper.SetButtonLabel(_modeButton.gameObject, "Mode: " + modeLabel);
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
			PauseMenuHelper.SetButtonLabel(btn.gameObject, label + "\n" + (enabled ? "On" : "Off"));
			var img = btn.GetComponent<Image>();
			if (img != null) img.color = enabled ? new Color(0.2f, 0.55f, 0.28f) : new Color(0.55f, 0.22f, 0.2f);
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

		bool openEnded = _mode == Mode.Normal || _mode == Mode.Coop;
		bool normalActive = _roundActive && openEnded;
		if (_startButton != null)
		{
			if (normalActive && isHost)
			{
				_startButton.interactable = true;
				PauseMenuHelper.SetButtonLabel(_startButton.gameObject, "Stop Playing");
			}
			else
			{
				_startButton.interactable = mgr != null && inLobby && isHost && !_roundActive && AllReady(mgr);
				PauseMenuHelper.SetButtonLabel(_startButton.gameObject, openEnded ? "Start Playing" : "Start Round");
			}
		}

		if (_statusGo == null) return;
		string statusText;
		if (mgr == null || !inLobby) statusText = "Host or join a lobby to play.";
		else if (normalActive) statusText = isHost ? "Playing - click Stop Playing to end." : "Playing.";
		else if (_roundActive) statusText = "Round in progress.";
		else if (!isHost) statusText = "Waiting for the host to start.";
		else if (!string.IsNullOrEmpty(_statusMessage)) statusText = _statusMessage;
		else if (!AllReady(mgr)) statusText = "Waiting for everyone to ready up...";
		else statusText = openEnded ? "Everyone's ready - click Start Playing!" : "Everyone's ready - click Start Round!";
		PauseMenuHelper.SetButtonLabel(_statusGo, statusText);
	}

	private enum Mode { Normal, HideAndSeek, Infection, Coop }
	private readonly CoopManager _coop = new CoopManager();
	private Mode _mode = Mode.Normal;
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

	private bool _spectating;
	private int _spectateIndex;
	private readonly List<int> _spectateTargets = new List<int>();

	private bool _returnToLobbyPending;
	private float _returnToLobbyFadeStart = -1f;
	private const float ReturnToLobbyFadeDuration = 0.35f;

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
		TryApplyPendingAbilities();

		if (_returnToLobbyPending && Time.unscaledTime - _returnToLobbyFadeStart >= ReturnToLobbyFadeDuration)
		{
			_returnToLobbyPending = false;
			ReturnToLobbyMenu();
		}

		if (!mgr.InLobby) { EndRoundLocally("left the lobby"); return; }
		if (!_roundActive) return;
		if (_mode == Mode.Coop) { _coop.Tick(Time.unscaledDeltaTime, mgr.IsHost, mgr.SendGameMessage); return; }
		if (_mode == Mode.Normal) return; // just playing - no seek/hide/tag mechanics to run

		bool hiding = Time.unscaledTime < _hideEndTime;
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
			CloseMenuIfOpen();
		}

		if (!hiding && IsLocalSeeking() && _localMovement != null)
		{
			foreach (var p in mgr.LastSnapshotPlayers)
			{
				if (IsOut(p.id)) continue;
				var dist = Vector2.Distance(_localMovement.transform.position, new Vector2(p.x, p.y));
				if (dist > TagRadius) continue;
				// Throttled - unthrottled resends can trip the relay's per-connection rate limit.
				if (_lastTagSentAt.TryGetValue(p.id, out var last) && Time.unscaledTime - last < TagResendInterval) continue;
				_lastTagSentAt[p.id] = Time.unscaledTime;
				mgr.SendGameMessage(new JObject { ["k"] = "tag", ["target"] = p.id });
			}
		}

		if (_spectating)
		{
			RefreshSpectateTargets();
			var mouse = Mouse.current;
			if (mouse != null)
			{
				if (mouse.leftButton.wasPressedThisFrame) { _spectateIndex--; ApplySpectateCamera(); }
				else if (mouse.rightButton.wasPressedThisFrame) { _spectateIndex++; ApplySpectateCamera(); }
			}
		}

		if (Time.unscaledTime >= _roundEndTime) EndRoundLocally("time's up");
	}

	private void EnterSpectate()
	{
		if (_localMovement != null) { _localMovement.enabled = false; _movementFrozen = true; }
		_spectating = true;
		_spectateIndex = 0;
		RefreshSpectateTargets();
		ApplySpectateCamera();
	}

	private void ExitSpectate()
	{
		if (!_spectating) return;
		_spectating = false;
		if (_localMovement != null && _localMovement.cam != null)
			_localMovement.cam.newTarget(_localMovement.gameObject, _localMovement.cam.defaultoffset, true, Vector2.zero);
	}

	private void RefreshSpectateTargets()
	{
		_spectateTargets.Clear();
		var mgr = MpNetworkManager.Instance;
		if (mgr == null) return;
		foreach (var p in mgr.LastSnapshotPlayers)
			if (p.id != _seekerId && !_found.Contains(p.id)) _spectateTargets.Add(p.id);
	}

	private void ApplySpectateCamera()
	{
		if (_localMovement == null || _localMovement.cam == null || _spectateTargets.Count == 0) return;
		if (_spectateIndex < 0) _spectateIndex = _spectateTargets.Count - 1;
		if (_spectateIndex >= _spectateTargets.Count) _spectateIndex = 0;
		var root = MpGhostManager.GetGhostRoot(_spectateTargets[_spectateIndex]);
		if (root != null) _localMovement.cam.newTarget(root, Vector3.zero, false, Vector2.zero);
	}

	private bool IsLocalSeeking()
	{
		var mgr = MpNetworkManager.Instance;
		if (_mode == Mode.Normal || _mode == Mode.Coop) return false;
		if (_mode == Mode.HideAndSeek) return mgr.LocalPlayerId == _seekerId;
		return _infected.Contains(mgr.LocalPlayerId);
	}

	private bool IsOut(int playerId)
	{
		if (_mode == Mode.Normal || _mode == Mode.Coop) return false;
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
			var modeStr = (string)payload["mode"];
			_mode = modeStr == "infection" ? Mode.Infection : modeStr == "coop" ? Mode.Coop : modeStr == "normal" ? Mode.Normal : Mode.HideAndSeek;
			_seekerId = (int)payload["seeker"];
			_infected.Clear();
			_found.Clear();
			_readyStates.Clear();
			_lastTagSentAt.Clear();
			if (_mode == Mode.Infection) _infected.Add(_seekerId);
			_hideEndTime = Time.unscaledTime + (float)payload["hideSeconds"];
			_roundEndTime = (_mode == Mode.Normal || _mode == Mode.Coop) ? float.MaxValue : Time.unscaledTime + (float)payload["roundSeconds"];
			_roundActive = true;
			_seekerReleased = false;
			_roundMapHubId = (string)payload["mapHubId"];
			_pendingAbilities = _mode != Mode.Coop ? payload["abilities"] as JObject : null;
			if (_mode == Mode.HideAndSeek || _mode == Mode.Infection) ActivateModeSaveFile(_mode);
			ApplyLocalAppearance();
			TryApplyPendingAbilities();
			if (_mode == Mode.HideAndSeek) DisableWattsAndClones();
			_statusMessage = (_mode == Mode.Normal || _mode == Mode.Coop) ? "Playing!" : "Round started!";
			if (!IsLocalSeeking())
			{
				EnsureMapLoaded(_roundMapHubId);
				CloseMenuIfOpen();
			}
			if (_mode == Mode.Coop)
			{
				try
				{
					var mgrInst = MpNetworkManager.Instance;
					_coop.Begin(mgrInst.IsHost, mgrInst.LastSnapshotPlayers.Count + 1, _localMovement);
				}
				catch (System.Exception e) { Debug.LogError("[HostPanel] Coop.Begin failed: " + e); }
			}
		}
		else if (kind == "stop")
		{
			EndRoundLocally("host ended the session");
		}
		else if (kind == "coopSync" || kind == "coopDelta")
		{
			_coop.HandleMessage(kind, payload, MpNetworkManager.Instance.IsHost);
		}
		else if (kind == "tag" && _roundActive)
		{
			var target = (int)payload["target"];
			if (_mode == Mode.HideAndSeek)
			{
				if (target != _seekerId && _found.Add(target))
				{
					if (target == MpNetworkManager.Instance.LocalPlayerId) { _statusMessage = "You were found!"; EnterSpectate(); }
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

	private JObject _pendingAbilities;

	// _localMovement may not have resolved yet the instant "start" arrives (a
	// fresh scene, or the player object not yet found) - retried every frame
	// until it succeeds instead of silently giving up on the one attempt.
	private void TryApplyPendingAbilities()
	{
		if (_pendingAbilities == null || _localMovement == null) return;
		ApplyAbilityRestrictions(_pendingAbilities);
		_pendingAbilities = null;
	}

	private void ApplyAbilityRestrictions(JObject abilities)
	{
		_abilityRestore.Clear();
		if (abilities == null || _localMovement == null) return;
		ApplyAbility(abilities, "dash", () => _localMovement.dashUnlocked, v => _localMovement.dashUnlocked = v);
		ApplyAbility(abilities, "wallJump", () => _localMovement.wallJumpUnlocked, v => _localMovement.wallJumpUnlocked = v);
		ApplyAbility(abilities, "doubleJump", () => _localMovement.doubleJumpUnlocked, v => _localMovement.doubleJumpUnlocked = v);
		ApplyAbility(abilities, "blockSwap", () => _localMovement.blockSwapUnlocked, v => _localMovement.blockSwapUnlocked = v);
	}

	private void ApplyAbility(JObject abilities, string key, System.Func<bool> get, System.Action<bool> set)
	{
		var allowed = abilities[key]?.Value<bool>() ?? true;
		var current = get();
		if (current == allowed) return;
		_abilityRestore[key] = current;
		set(allowed);
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
				}
			}
		}
		_abilityRestore.Clear();
	}

	private double _savedWatts;
	private bool _wattsSaved;
	private readonly List<clonesScript> _disabledClones = new List<clonesScript>();

	private void DisableWattsAndClones()
	{
		if (globalStats.currencyLookup != null)
		{
			_savedWatts = globalStats.currencyLookup[globalStats.Currencies.Cash];
			_wattsSaved = true;
		}
		_disabledClones.Clear();
		foreach (var c in Object.FindObjectsByType<clonesScript>(FindObjectsInactive.Include, FindObjectsSortMode.None))
		{
			if (!c.enabled) continue;
			c.enabled = false;
			_disabledClones.Add(c);
		}
	}

	private void RestoreWattsAndClones()
	{
		if (_wattsSaved && globalStats.currencyLookup != null)
		{
			globalStats.currencyLookup[globalStats.Currencies.Cash] = _savedWatts;
			_wattsSaved = false;
		}
		foreach (var c in _disabledClones)
			if (c != null) c.enabled = true;
		_disabledClones.Clear();
	}

	private const string DefaultGreyHex = "#888888";

	private void ApplyLocalAppearance()
	{
		if (_mode == Mode.Normal || _mode == Mode.Coop) return;
		if (_prevDotColor == null)
		{
			_prevDotColor = MpNetworkManager.GetDotColorHex();
			_prevNameColor = MpNetworkManager.GetNameColorHex();
		}
		var color = IsLocalSeeking() ? "#FF0000" : DefaultGreyHex;
		MpNetworkManager.SetDotColorHex(color);
		MpNetworkManager.SetNameColorHex(color);
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
		RestoreWattsAndClones();
		ExitSpectate();
		if (_mode == Mode.Coop) _coop.End(MpNetworkManager.Instance?.IsHost ?? false);
		if (_mode == Mode.HideAndSeek || _mode == Mode.Infection) DeactivateModeSaveFile();
		if (reason == "everyone was found") { _returnToLobbyPending = true; _returnToLobbyFadeStart = Time.unscaledTime; }
	}

	private const string HideAndSeekSaveFolder = "/SavedataHideAndSeek";
	private const string InfectionSaveFolder = "/SavedataInfection";
	private readonly List<courseScript> _modeCourses = new List<courseScript>();
	private bool _modeSaveActive;

	private void ActivateModeSaveFile(Mode mode)
	{
		try
		{
			var folder = mode == Mode.HideAndSeek ? HideAndSeekSaveFolder : InfectionSaveFolder;
			_modeCourses.Clear();
			_modeCourses.AddRange(Object.FindObjectsByType<courseScript>(FindObjectsInactive.Include, FindObjectsSortMode.None));
			ModeSaveFile.ResetEconomyToZero(_localMovement, _modeCourses);
			ModeSaveFile.DeleteAndRecreateFolder(folder);
			ModeSaveFile.Save(folder, _localMovement, _modeCourses);
			_modeSaveActive = true;
		}
		catch (System.Exception e) { Debug.LogError("[HostPanel] ActivateModeSaveFile failed: " + e); }
	}

	private void DeactivateModeSaveFile()
	{
		if (!_modeSaveActive) return;
		_modeSaveActive = false;
		try { ModeSaveFile.Restore(ModeSaveFile.RealSaveFolder(), _localMovement, _modeCourses); }
		catch (System.Exception e) { Debug.LogError("[HostPanel] DeactivateModeSaveFile failed: " + e); }
		_modeCourses.Clear();
	}

	private void CloseMenuIfOpen()
	{
		if (_menu != null && _menu.menuOpen) _menu.menuButtonPressed();
	}

	private void ReturnToLobbyMenu()
	{
		if (_menu == null || _menu.menuOpen) return;
		_menu.menuButtonPressed();
		if (MpNetworkManager.LatestMainBit != null) MpNetworkManager.LatestMainBit.SetActive(false);
		if (MpNetworkManager.LatestMpPanel != null) MpNetworkManager.LatestMpPanel.SetActive(true);
	}

	private void OnReadyClicked()
	{
		var mgr = MpNetworkManager.Instance;
		if (mgr == null || !mgr.InLobby) return;
		bool currentlyReady = _readyStates.TryGetValue(mgr.LocalPlayerId, out var r) && r;
		_localReadyIntent = !currentlyReady;
		mgr.SendGameMessage(new JObject { ["k"] = "ready", ["ready"] = !currentlyReady });
		if (!currentlyReady) TryConsumePendingMapLoad();
	}

	private void TryConsumePendingMapLoad()
	{
		var m = MpNetworkManager.GetOrCreate();
		if (!string.IsNullOrEmpty(m.PendingLocalMapId)) { m.LoadPendingLocalMap(); return; }
		if (m.PendingBaseGameHard.HasValue)
		{
			bool hard = m.PendingBaseGameHard.Value;
			m.PendingBaseGameHard = null;
			if (_menu != null) { if (hard) _menu.changeSceneHard(); else _menu.changeScene(); }
			return;
		}
		if (!string.IsNullOrEmpty(m.PendingMapHubId))
		{
			_statusMessage = "Downloading map...";
			m.DownloadPendingMap();
		}
	}

	private void OnStartOrStopClicked()
	{
		var mgr = MpNetworkManager.Instance;
		if (mgr != null && _roundActive && (_mode == Mode.Normal || _mode == Mode.Coop)) OnStopClicked();
		else OnStartClicked();
	}

	private void OnStopClicked()
	{
		var mgr = MpNetworkManager.Instance;
		if (mgr == null || !mgr.InLobby || !mgr.IsHost) return;
		mgr.SendGameMessage(new JObject { ["k"] = "stop" });
		EndRoundLocally("host ended the session");
	}

	private void OnStartClicked()
	{
		var mgr = MpNetworkManager.Instance;
		if (mgr == null || !mgr.InLobby || !mgr.IsHost || _roundActive) return;
		if (!AllReady(mgr)) { _statusMessage = "Waiting for everyone to be ready."; return; }

		TryConsumePendingMapLoad();

		var others = mgr.LastSnapshotPlayers.Select(p => p.id).ToList();
		var everyone = new List<int>(others) { mgr.LocalPlayerId };

		int seeker = -1;
		if (_mode != Mode.Normal && _mode != Mode.Coop)
		{
			if (everyone.Count < 2) { _statusMessage = "Need at least 2 players."; return; }
			seeker = everyone[Random.Range(0, everyone.Count)];
		}

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
			["mode"] = _mode == Mode.Infection ? "infection" : _mode == Mode.HideAndSeek ? "hideandseek" : _mode == Mode.Coop ? "coop" : "normal",
			["seeker"] = seeker,
			["hideSeconds"] = (_mode == Mode.Normal || _mode == Mode.Coop) ? 0f : HideSeconds,
			["roundSeconds"] = RoundSeconds,
			["mapHubId"] = mapHubId,
			["mapName"] = mapName,
			["abilities"] = abilities,
		});
	}

	private void OnGUI()
	{
		DrawHud();
		DrawSpectateHud();
		DrawReturnToLobbyFade();
	}

	private void DrawReturnToLobbyFade()
	{
		if (!_returnToLobbyPending) return;
		var t = Mathf.Clamp01((Time.unscaledTime - _returnToLobbyFadeStart) / ReturnToLobbyFadeDuration);
		var prevColor = GUI.color;
		GUI.color = new Color(0f, 0f, 0f, t);
		GUI.DrawTexture(new Rect(0, 0, Screen.width, Screen.height), Texture2D.whiteTexture);
		GUI.color = prevColor;
	}

	private void DrawHud()
	{
		if (!_roundActive || _mode == Mode.Normal || _mode == Mode.Coop) return;
		var mgr = MpNetworkManager.Instance;
		if (mgr == null) return;
		string label;
		if (Time.unscaledTime < _hideEndTime)
		{
			var left = Mathf.CeilToInt(_hideEndTime - Time.unscaledTime);
			label = IsLocalSeeking() ? "Hiders are hiding: " + left + "s" : "Hide! " + left + "s";
		}
		else
		{
			var left = Mathf.CeilToInt(_roundEndTime - Time.unscaledTime);
			label = (_mode == Mode.HideAndSeek ? "Hide and Seek" : "Infection") + " - " + left + "s left";
			if (IsLocalSeeking()) label += _mode == Mode.HideAndSeek ? " (you're it)" : " (infected)";
		}
		var rect = new Rect(20, 20, 400, 30);
		GUI.Box(rect, "");
		var style = new GUIStyle(GUI.skin.label) { fontSize = 18, normal = { textColor = IsLocalSeeking() ? Color.red : Color.white } };
		GUI.Label(rect, label, style);
	}

	private void DrawSpectateHud()
	{
		if (!_spectating) return;
		var mgr = MpNetworkManager.Instance;
		string name = "no one left";
		if (_spectateTargets.Count > 0 && _spectateIndex >= 0 && _spectateIndex < _spectateTargets.Count)
		{
			var id = _spectateTargets[_spectateIndex];
			var p = mgr?.LastSnapshotPlayers.FirstOrDefault(x => x.id == id);
			name = p != null ? p.name : ("Player " + id);
		}
		var rect = new Rect(20, 60, 400, 30);
		GUI.Box(rect, "");
		var style = new GUIStyle(GUI.skin.label) { fontSize = 16, normal = { textColor = Color.white } };
		GUI.Label(rect, "Spectating: " + name + "  (click: prev / right-click: next)", style);
	}
}

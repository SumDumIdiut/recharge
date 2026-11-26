using System.Collections.Generic;
using System.IO;
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
	private TMP_FontAsset _font;
	private GameObject _hostPanel;
	private Button _toggleButton;
	private bool _autoReadyTried;
	private int _lastKnownPlayerId;
	private bool _localReadyIntent;

	private Button _modeButton;
	private Button _mapButton;
	private Button _saveButton;
	private TMP_Text _rosterText;
	private Button _startButton;
	private TMP_Text _statusText;

	private GameObject _mainContent;
	private enum PickerKind { None, Map, Save }
	private PickerKind _activePicker = PickerKind.None;
	private GameObject _pickerSection;
	private TMP_Text _pickerHeader;
	private readonly List<GameObject> _pickerRows = new List<GameObject>();
	private int _pickerPage;
	private TMP_Text _pickerPageLabel;
	private Button _pickerPrevButton;
	private Button _pickerNextButton;
	private string _selectedSaveName;

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

	private List<MpMapLibrary.HostableMap> _hostableMaps = new List<MpMapLibrary.HostableMap>();
	private int _selectedMapIndex = -1;
	private string _lastLoggedMapLabel;
	private volatile bool _mapListLoading;

	private readonly Dictionary<int, bool> _readyStates = new Dictionary<int, bool>();

	public static HostPanelController Instance { get; private set; }

	public void Init(IRechargeHost host)
	{
		_host = host;
		Instance = this;
	}

	// ---- entering the world after a host / join from the Recharge app ----
	// In the in-game menu the host or guest enters the world by pressing Ready (TryConsumePendingMapLoad). From the app nobody presses it, so
	// the lobby would sit on the title screen; this does that step once the title menu is really up (the app's intent can arrive while the
	// game is still starting, before its menu exists, and a scene change that early leaves a black screen).
	private bool _enterWorldPending;
	private float _enterWorldAfter, _enterWorldGiveUp;
	private static readonly System.Reflection.FieldInfo StartHasRunField = Reflect.FieldOf<pauseMenuScript>("startHasRun");

	/// <summary>Main thread. Called after the relay accepted lobby.host or lobby.join.</summary>
	public void RequestEnterWorld()
	{
		_enterWorldPending = true;
		_enterWorldAfter = Time.unscaledTime + 3f;
		_enterWorldGiveUp = Time.unscaledTime + 120f;
	}

	private void TryEnterWorld()
	{
		if (!_enterWorldPending) return;
		if (Time.unscaledTime > _enterWorldGiveUp) { _enterWorldPending = false; Debug.Log("[HostPanel] enter-world gave up (no title menu)"); return; }
		var mgr = MpNetworkManager.Instance;
		if (mgr == null || !mgr.InLobby || _menu == null || Time.unscaledTime < _enterWorldAfter) return;
		if (UnityEngine.SceneManagement.SceneManager.GetActiveScene().name != "MainMenu") { _enterWorldPending = false; return; } // already in a world
		if (StartHasRunField != null && StartHasRunField.GetValue(_menu) is bool started && !started) return;
		_enterWorldPending = false;
		Debug.Log("[HostPanel] entering the lobby's world from the title screen");
		TryConsumePendingMapLoad();
	}

	public void InstallMenuRow(pauseMenuScript menu)
	{
		_menu = menu;
		if (MpNetworkManager.LatestInLobbyRow == null) return;

		if (MpNetworkManager.LatestInLobbyRow.transform.Find("HostPanelToggle") == null)
		{
			_font = FindFont(MpNetworkManager.LatestMpPanel) ?? FindFont(PauseMenuHelper.MainBit(menu));
			var toggleGo = AddButton(MpNetworkManager.LatestInLobbyRow.transform, "HostPanelToggle",
				new Vector2(150, -160), new Vector2(270, 60), "Host Panel", 18f,
				PanelWidgets.DefaultAccentColor, TextAlignmentOptions.Center, OnToggleOrReadyClicked);
			_toggleButton = toggleGo.GetComponent<Button>();
		}

		var settingsBit = PauseMenuHelper.SettingsBit(menu);
		if (settingsBit == null || settingsBit.transform.parent.Find("HostPanelBit") != null) return;

		var panel = BuildStandalonePanel(menu);
		if (panel == null) return;
		_font = FindFont(panel) ?? _font;
		BuildPanelContent(panel);
		RefreshMapList();
	}

	/// <summary>All panel chrome is built from PanelWidgets so this panel reads as a sibling of the Map/Mods panels.</summary>
	private void BuildPanelContent(GameObject panel)
	{
		var root = panel.transform;
		PauseMenuHelper.NormalizePanelLayout(panel);
		var panelRt = panel.GetComponent<RectTransform>();
		if (panelRt != null) panelRt.sizeDelta = new Vector2(620f, 640f);

		PanelWidgets.CreateDivider(root, new Vector2(0, 225), 580);
		AddLabel(root, "HostPanel_Heading", new Vector2(0, 200), new Vector2(560, 36), "Host Panel",
			24f, PanelWidgets.DefaultAccentColor, TextAlignmentOptions.Center);

		_modeButton = AddButton(root, "HostPanel_Mode", new Vector2(-152, 150), new Vector2(148, 60), "Mode: Normal",
			16f, Color.white, TextAlignmentOptions.Center, OnCycleModeClicked).GetComponent<Button>();
		_mapButton = AddButton(root, "HostPanel_Map", new Vector2(0, 150), new Vector2(148, 60), "Map: Current Map",
			16f, Color.white, TextAlignmentOptions.Center, OnOpenMapPickerClicked).GetComponent<Button>();
		_saveButton = AddButton(root, "HostPanel_Save", new Vector2(152, 150), new Vector2(148, 60), "Save: New Save",
			16f, Color.white, TextAlignmentOptions.Center, OnOpenSavePickerClicked).GetComponent<Button>();

		BuildPickerSection(root);

		_mainContent = PanelWidgets.CreateContainer(root, "HostPanel_MainContent", Vector2.zero).gameObject;
		var content = _mainContent.transform;

		PanelWidgets.CreateDivider(content, new Vector2(0, 110), 420);
		AddLabel(content, "HostPanel_AbilityCaption", new Vector2(0, 85), new Vector2(380, 26), "Abilities (tap to toggle)",
			15f, new Color(1f, 1f, 1f, 0.65f), TextAlignmentOptions.Center);

		float[] xs = { -174, -58, 58, 174 };
		for (int i = 0; i < _abilityDefs.Length; i++)
		{
			var key = _abilityDefs[i].Key;
			var go = AddButton(content, "HostPanel_Ability_" + key, new Vector2(xs[i], 45), new Vector2(110, 44),
				_abilityDefs[i].Label, 14f, Color.white, TextAlignmentOptions.Center,
				() => _abilityEnabled[key] = !_abilityEnabled[key]);
			_abilityButtons.Add((key, go.GetComponent<Button>()));
		}

		PanelWidgets.CreateDivider(content, new Vector2(0, 5), 420);
		var boxSprite = PanelWidgets.FindPanelSprite(root, out var boxType);
		PanelWidgets.CreateBox(content, new Vector2(0, -40), new Vector2(420, 80), boxSprite, boxType, 2.5f);
		_rosterText = AddLabel(content, "HostPanelRoster", new Vector2(0, -40), new Vector2(400, 72), "",
			14f, Color.white, TextAlignmentOptions.TopLeft);

		_startButton = AddButton(content, "HostPanel_Start", new Vector2(0, -125), new Vector2(260, 60), "Start Playing",
			22f, PanelWidgets.DefaultAccentColor, TextAlignmentOptions.Center, OnStartOrStopClicked).GetComponent<Button>();
		_statusText = AddLabel(content, "HostPanelStatus", new Vector2(0, -185), new Vector2(560, 40), "",
			16f, new Color(1f, 1f, 1f, 0.8f), TextAlignmentOptions.Center);
	}

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

	// Not a top-level pause-menu row - only reachable via the "Host Panel"
	// toggle button installed inside the DOTnet panel (InstallMenuRow
	// below), so its Back button/Escape return there rather than to the
	// main pause menu.
	private GameObject BuildStandalonePanel(pauseMenuScript menu)
	{
		var panel = PauseMenuHelper.GetOrCreatePanel(menu, "HostPanel", "Host Panel", backTarget: MpNetworkManager.LatestMpPanel);
		if (panel == null) return null;

		var closer = panel.GetComponent<PanelEscapeCloser>();
		if (closer != null)
		{
			// Escape backs out of an open map/save picker first (same as
			// hitting its own Cancel button), and only closes the whole
			// Host Panel once no picker is open.
			closer.ConsumeEscapeFirst = () =>
			{
				if (_activePicker == PickerKind.None) return false;
				_activePicker = PickerKind.None;
				return true;
			};
		}

		_hostPanel = panel;
		return panel;
	}

	private void OnCycleModeClicked()
	{
		_mode = _mode switch
		{
			Mode.Normal => Mode.Coop,
			_ => Mode.Normal,
		};
		_selectedSaveName = null;
	}

	private void BuildPickerSection(Transform panel)
	{
		_pickerSection = PanelWidgets.CreateContainer(panel, "HostPanel_PickerSection", Vector2.zero).gameObject;
		PanelWidgets.CreateDivider(_pickerSection.transform, new Vector2(0, 190), 420);
		_pickerHeader = AddLabel(_pickerSection.transform, "HostPanel_PickerHeader", new Vector2(0, 165),
			new Vector2(400, 34), "", 22f, PanelWidgets.DefaultAccentColor, TextAlignmentOptions.Center);

		_pickerPrevButton = AddButton(_pickerSection.transform, "HostPanel_PickerPrev", new Vector2(-150, -160),
			new Vector2(56, 40), "<", 18f, PanelWidgets.DefaultAccentColor, TextAlignmentOptions.Center, () => ChangePickerPage(-1)).GetComponent<Button>();
		_pickerNextButton = AddButton(_pickerSection.transform, "HostPanel_PickerNext", new Vector2(150, -160),
			new Vector2(56, 40), ">", 18f, PanelWidgets.DefaultAccentColor, TextAlignmentOptions.Center, () => ChangePickerPage(1)).GetComponent<Button>();
		_pickerPageLabel = AddLabel(_pickerSection.transform, "HostPanel_PickerPageLabel", new Vector2(0, -160),
			new Vector2(180, 30), "", 14f, new Color(1f, 1f, 1f, 0.6f), TextAlignmentOptions.Center);

		AddButton(_pickerSection.transform, "HostPanel_PickerCancel", new Vector2(0, -215), new Vector2(260, 50),
			"Cancel", 20f, Color.white, TextAlignmentOptions.Center, () => _activePicker = PickerKind.None);
		_pickerSection.SetActive(false);
	}

	private void OnOpenMapPickerClicked()
	{
		_activePicker = PickerKind.Map;
		_pickerPage = 0;
		RefreshPickerRows();
	}

	private void OnOpenSavePickerClicked()
	{
		_activePicker = PickerKind.Save;
		_pickerPage = 0;
		RefreshPickerRows();
	}

	private static string SaveRootFolder(Mode mode) => mode == Mode.Coop ? "/SavedataCoop" : null;

	private List<string> ListSavesForCurrentMode()
	{
		var root = SaveRootFolder(_mode);
		if (root == null) return new List<string>();
		var path = Application.persistentDataPath + root;
		if (!Directory.Exists(path)) return new List<string>();
		return Directory.GetDirectories(path).Select(Path.GetFileName).OrderBy(n => n).ToList();
	}

	private const int PickerRowsPerPage = 5;

	private void RefreshPickerRows()
	{
		foreach (var row in _pickerRows) Object.DestroyImmediate(row);
		_pickerRows.Clear();

		var entries = new List<(string Label, System.Action OnClick)>();
		if (_activePicker == PickerKind.Map)
		{
			SetText(_pickerHeader, "Choose a Map");
			entries.Add(("Base Game", () => { _selectedMapIndex = -2; _activePicker = PickerKind.None; Debug.Log("[HostPanel] map picker: selected Base Game (-2)"); }));
			if (MpMapLibrary.HasBSide) entries.Add(("B-Side", () => { _selectedMapIndex = -3; _activePicker = PickerKind.None; Debug.Log("[HostPanel] map picker: selected B-Side (-3)"); }));
			for (int i = 0; i < _hostableMaps.Count; i++)
			{
				var idx = i;
				entries.Add((_hostableMaps[i].Name, () => { _selectedMapIndex = idx; _activePicker = PickerKind.None; Debug.Log($"[HostPanel] map picker: selected hub map idx={idx} name={_hostableMaps[idx].Name}"); }));
			}
		}
		else if (_activePicker == PickerKind.Save)
		{
			SetText(_pickerHeader, "Choose a Save");
			entries.Add(("New Save", () => { _selectedSaveName = null; _activePicker = PickerKind.None; }));
			foreach (var name in ListSavesForCurrentMode())
			{
				var captured = name;
				entries.Add((captured, () => { _selectedSaveName = captured; _activePicker = PickerKind.None; }));
			}
		}

		var totalPages = Mathf.Max(1, Mathf.CeilToInt(entries.Count / (float)PickerRowsPerPage));
		_pickerPage = Mathf.Clamp(_pickerPage, 0, totalPages - 1);

		float y = 115f;
		const float spacing = 52f;
		var start = _pickerPage * PickerRowsPerPage;
		var end = Mathf.Min(start + PickerRowsPerPage, entries.Count);
		for (int i = start; i < end; i++)
		{
			if (i > start) _pickerRows.Add(PanelWidgets.CreateDivider(_pickerSection.transform, new Vector2(0, y + spacing / 2f), 380));
			_pickerRows.Add(CreatePickerRow(entries[i].Label, y, entries[i].OnClick));
			y -= spacing;
		}

		SetText(_pickerPageLabel, totalPages > 1 ? $"Page {_pickerPage + 1}/{totalPages}" : "");
		if (_pickerPrevButton != null) _pickerPrevButton.interactable = _pickerPage > 0;
		if (_pickerNextButton != null) _pickerNextButton.interactable = _pickerPage < totalPages - 1;
	}

	private void ChangePickerPage(int delta)
	{
		_pickerPage += delta;
		RefreshPickerRows();
	}

	private GameObject CreatePickerRow(string label, float y, System.Action onClick)
	{
		return AddButton(_pickerSection.transform, "HostPanel_PickerRow", new Vector2(0, y), new Vector2(380, 44),
			label, 18f, Color.white, TextAlignmentOptions.MidlineLeft, onClick);
	}

	// ---- PanelWidgets helpers: one look for the whole panel, with Juke's FitLabel on every label ----
	private TMP_Text AddLabel(Transform parent, string name, Vector2 pos, Vector2 size, string text,
		float fontSize, Color color, TextAlignmentOptions align)
	{
		var tmp = PanelWidgets.CreateLabel(parent, _font, pos, size, text, fontSize, color, align);
		tmp.name = name;
		tmp.fontSizeMin = PanelWidgets.MinFitFontSize;
		tmp.fontSizeMax = fontSize;
		SetText(tmp, text);
		return tmp;
	}

	private GameObject AddButton(Transform parent, string name, Vector2 pos, Vector2 size, string label,
		float fontSize, Color textColor, TextAlignmentOptions align, System.Action onClick)
	{
		var go = PanelWidgets.CreateButton(parent, _font, name, pos, size, label, fontSize, textColor, align);
		var tmp = LabelOf(go);
		if (tmp != null)
		{
			tmp.fontSizeMin = PanelWidgets.MinFitFontSize;
			tmp.fontSizeMax = fontSize;
			PanelWidgets.FitLabel(tmp);
		}
		var button = go.GetComponent<Button>();
		if (button != null && onClick != null)
			button.onClick.AddListener(() => { try { onClick(); } catch (System.Exception e) { Debug.LogWarning("[HostPanel] click failed: " + e.Message); } });
		return go;
	}

	private static void SetText(TMP_Text tmp, string text, Color? color = null)
	{
		if (tmp == null) return;
		string value = text ?? "";
		bool sameColor = !color.HasValue || (tmp.color == color.Value && tmp.faceColor == color.Value);
		if (tmp.text == value && sameColor) return; // FitLabel forces a mesh rebuild; skip it when nothing changed
		tmp.richText = false;
		tmp.text = value;
		if (color.HasValue) { tmp.color = color.Value; tmp.faceColor = color.Value; }
		PanelWidgets.FitLabel(tmp);
	}

	private static void SetButtonText(GameObject go, string text, Color? color = null) => SetText(LabelOf(go), text, color);

	private static TMP_Text LabelOf(GameObject go)
	{
		if (go == null) return null;
		var label = go.transform.Find("Text (TMP)");
		return label != null ? label.GetComponent<TMP_Text>() : null;
	}

	private static TMP_FontAsset FindFont(GameObject panel)
	{
		try
		{
			var title = panel != null ? panel.transform.Find("Settings") : null;
			if (title == null && panel != null && panel.transform.childCount > 0) title = panel.transform.GetChild(0);
			var tmp = title != null ? title.GetComponentInChildren<TMP_Text>(true) : null;
			return tmp != null && tmp.font != null ? tmp.font : TMP_Settings.defaultFontAsset;
		}
		catch (System.Exception)
		{
			return null; // TMP falls back to its own default asset
		}
	}

	private void RefreshMapList()
	{
		if (_mapListLoading) return;
		_mapListLoading = true;
		Debug.Log($"[HostPanel] RefreshMapList: starting fetch, current _selectedMapIndex={_selectedMapIndex}");
		var previouslySelectedHubId = _selectedMapIndex >= 0 && _selectedMapIndex < _hostableMaps.Count
			? _hostableMaps[_selectedMapIndex].HubId
			: null;
		new Thread(() =>
		{
			try { _hostableMaps = MpMapLibrary.GetHostableMaps(); }
			finally
			{
				_mapListLoading = false;
				Debug.Log($"[HostPanel] RefreshMapList: fetch completed, previouslySelectedHubId={previouslySelectedHubId ?? "null"} _selectedMapIndex(before any touch)={_selectedMapIndex}");
				if (previouslySelectedHubId != null)
					_selectedMapIndex = _hostableMaps.FindIndex(m => m.HubId == previouslySelectedHubId);
			}
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
			if (mgr.PendingHostMapKind == "base") _selectedMapIndex = -2;
			else if (mgr.PendingHostMapKind == "bside") _selectedMapIndex = -3;
			mgr.PendingHostMapKind = null;
			mgr.SendGameMessage(new JObject { ["k"] = "ready", ["ready"] = true });
		}

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
			if (isHost) SetButtonText(_toggleButton.gameObject, "Host Panel", PanelWidgets.DefaultAccentColor);
			else
			{
				bool ready = mgr != null && _readyStates.TryGetValue(mgr.LocalPlayerId, out var tr) && tr;
				SetButtonText(_toggleButton.gameObject, ready ? "Unready" : "Ready", PanelWidgets.DefaultAccentColor);
			}
		}

		if (_hostPanel == null || !_hostPanel.activeInHierarchy) return;

		if (_modeButton != null)
		{
			_modeButton.interactable = canConfigure;
			var modeLabel = _mode == Mode.Coop ? "Co-op" : "Normal";
			SetButtonText(_modeButton.gameObject, "Mode:\n" + modeLabel);
		}
		if (_mapButton != null)
		{
			_mapButton.interactable = canConfigure;
			var mapLabel = _selectedMapIndex >= 0 && _selectedMapIndex < _hostableMaps.Count ? _hostableMaps[_selectedMapIndex].Name
				: _selectedMapIndex == -2 ? "Base Game"
				: _selectedMapIndex == -3 ? "B-Side"
				: "Current Map";
			if (mapLabel != _lastLoggedMapLabel)
			{
				_lastLoggedMapLabel = mapLabel;
				Debug.Log($"[HostPanel] map label changed to '{mapLabel}' (_selectedMapIndex={_selectedMapIndex})");
			}
			SetButtonText(_mapButton.gameObject, "Map:\n" + mapLabel);
		}
		if (_saveButton != null)
		{
			bool canPickSave = canConfigure && SaveRootFolder(_mode) != null;
			_saveButton.interactable = canPickSave;
			var saveLabel = _selectedSaveName ?? "New Save";
			if (saveLabel.Length > 14) saveLabel = saveLabel.Substring(0, 12) + "..";
			SetButtonText(_saveButton.gameObject, "Save:\n" + saveLabel);
		}

		bool showingPicker = _activePicker != PickerKind.None;
		if (_modeButton != null) _modeButton.gameObject.SetActive(!showingPicker);
		if (_mapButton != null) _mapButton.gameObject.SetActive(!showingPicker);
		if (_saveButton != null) _saveButton.gameObject.SetActive(!showingPicker);
		if (_mainContent != null) _mainContent.SetActive(!showingPicker);
		if (_pickerSection != null) _pickerSection.SetActive(showingPicker);
		if (showingPicker) return;

		bool canConfigureAbilities = canConfigure && _mode == Mode.Normal;
		foreach (var (key, btn) in _abilityButtons)
		{
			if (btn == null) continue;
			bool enabled = _abilityEnabled[key];
			btn.interactable = canConfigureAbilities;
			var label = _abilityDefs.First(d => d.Key == key).Label;
			SetButtonText(btn.gameObject, label + "\n" + (enabled ? "On" : "Off"),
				enabled ? PanelWidgets.DefaultAccentColor : new Color(1f, 1f, 1f, 0.55f));
		}

		if (_rosterText != null)
		{
			if (mgr == null || !inLobby) SetText(_rosterText, "");
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
				SetText(_rosterText, sb.ToString());
			}
		}

		bool roundActiveAsHost = _roundActive && isHost;
		if (_startButton != null)
		{
			if (!isHost)
			{
				_startButton.interactable = mgr != null && inLobby;
				bool selfReady = mgr != null && _readyStates.TryGetValue(mgr.LocalPlayerId, out var sready) && sready;
				SetButtonText(_startButton.gameObject, selfReady ? "Unready" : "Ready", PanelWidgets.DefaultAccentColor);
			}
			else if (roundActiveAsHost)
			{
				_startButton.interactable = true;
				SetButtonText(_startButton.gameObject, "Stop Playing", PanelWidgets.DefaultAccentColor);
			}
			else
			{
				_startButton.interactable = mgr != null && inLobby && isHost && !_roundActive && (_mode != Mode.Coop || AllReady(mgr));
				SetButtonText(_startButton.gameObject, "Start Playing", PanelWidgets.DefaultAccentColor);
			}
		}

		if (_statusText == null) return;
		string statusText;
		if (mgr == null || !inLobby) statusText = "Host or join a lobby to play.";
		else if (roundActiveAsHost) statusText = "Playing - click Stop Playing to end.";
		else if (_roundActive) statusText = "Playing.";
		else if (!isHost) statusText = "Waiting for the host to start.";
		else if (!string.IsNullOrEmpty(_statusMessage)) statusText = _statusMessage;
		else if (_mode == Mode.Coop && !AllReady(mgr)) statusText = "Waiting for everyone to ready up...";
		else statusText = "Ready - click Start Playing!";
		SetText(_statusText, statusText, roundActiveAsHost || (mgr != null && inLobby && isHost && (_mode != Mode.Coop || AllReady(mgr)))
			? PanelWidgets.DefaultAccentColor
			: new Color(1f, 1f, 1f, 0.8f));
	}

	private enum Mode { Normal, Coop }
	private readonly CoopManager _coop = new CoopManager();
	private readonly NormalMode _normal = new NormalMode();
	private Mode _mode = Mode.Normal;
	private bool _roundActive;
	private int _roundPlayerCount = 1;
	private float _cloneHideAccumulator;
	private const float CloneHideInterval = 0.5f;
	private int _lastAppliedRoundId = -1;
	private int _sentRoundId;
	private float _roundResendAccumulator;
	private const float RoundResendInterval = 3f;
	private int _pendingStopResends;
	private float _stopResendAccumulator;
	private const float StopResendInterval = 1f;
	private float _readyResendAccumulator;
	private const float ReadyResendInterval = 2f;
	private string _roundMapHubId;
	private string _roundMapKind = "current";
	private volatile bool _mapDownloading;
	private string _statusMessage = "";
	// The host's position captured when the round starts: everyone teleports
	// here on start, and late joiners spawn here too (the host's first spawn).
	private double _roundSpawnX, _roundSpawnY;
	private bool _hasRoundSpawn;

	private Movement _localMovement;

	/// <summary>No pause-menu row for DOTnet: in a lobby, F4 in the pause menu opens its panel (Ready / Host Panel, Leave Lobby, Colour).</summary>
	public const Key PanelKey = Key.F4;
	private bool _wasInLobby;

	private void HandlePanelKey(MpNetworkManager mgr)
	{
		bool inLobby = mgr.InLobby;
		if (inLobby && !_wasInLobby)
			mgr.ChatLines.Add("[DOTnet] In the pause menu, press " + PanelKey + " for Ready, the Host Panel and Leave Lobby.");
		_wasInLobby = inLobby;
		var kb = Keyboard.current;
		if (!inLobby || kb == null || !kb[PanelKey].wasPressedThisFrame) return;
		if (UnityEngine.SceneManagement.SceneManager.GetActiveScene().name == "MainMenu") return;
		var main = MpNetworkManager.LatestMainBit;
		var panel = MpNetworkManager.LatestMpPanel;
		if (main == null || panel == null || !main.activeInHierarchy) return; // only from the pause menu's main page
		main.SetActive(false);
		panel.SetActive(true);
	}

	private void Update()
	{
		RefreshMenu();

		var mgr = MpNetworkManager.Instance;
		if (mgr == null) return;
		HandlePanelKey(mgr);

		mgr.OnGameMessage -= OnGameMessage;
		mgr.OnGameMessage += OnGameMessage;

		if (_localMovement == null)
		{
			var playerGo = GameObject.FindGameObjectWithTag("Player");
			if (playerGo != null)
			{
				_localMovement = playerGo.GetComponent<Movement>();
				if (_mode == Mode.Coop && _localMovement != null) _coop.RefreshSceneReferences(_localMovement);
				if (_mode == Mode.Normal && _localMovement != null && _lastAppliedAbilities != null)
					_normal.Apply(_localMovement, _lastAppliedAbilities);
				if (_roundActive && _localMovement != null) TeleportLocalPlayerToStartSpawn();
			}
		}
		TryApplyPendingAbilities();
		TryStartModeEconomy();
		TryCloseMenuIfNeeded();
		TryEnterWorld();
		TryApplyPendingSceneChange();
		TryTeleportToStartSpawn();

		if (mgr.IsHost && _pendingStopResends > 0)
		{
			_stopResendAccumulator += Time.unscaledDeltaTime;
			if (_stopResendAccumulator >= StopResendInterval)
			{
				_stopResendAccumulator = 0f;
				_pendingStopResends--;
				mgr.SendGameMessage(new JObject { ["k"] = "stop" });
			}
		}

		if (!mgr.InLobby) { EndRoundLocally("left the lobby"); return; }

		if (!_roundActive)
		{
			_readyResendAccumulator += Time.unscaledDeltaTime;
			if (_readyResendAccumulator >= ReadyResendInterval)
			{
				_readyResendAccumulator = 0f;
				mgr.SendGameMessage(new JObject { ["k"] = "ready", ["ready"] = mgr.IsHost || _localReadyIntent });
			}
			return;
		}

		if (mgr.IsHost)
		{
			_roundResendAccumulator += Time.unscaledDeltaTime;
			if (_roundResendAccumulator >= RoundResendInterval)
			{
				_roundResendAccumulator = 0f;
				ResendCurrentRoundState();
			}
		}

		if (_mode == Mode.Coop)
		{
			_cloneHideAccumulator += Time.unscaledDeltaTime;
			if (_cloneHideAccumulator >= CloneHideInterval)
			{
				_cloneHideAccumulator = 0f;
				_coop.HideCloneUpgradeBoxes();
			}
			_coop.Tick(Time.unscaledDeltaTime, mgr.IsHost, mgr.SendGameMessage);
		}
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
			var roundId = payload["roundId"]?.Value<int>() ?? -1;
			Debug.Log($"[HostPanel] recv start: from={from} roundId={roundId} lastApplied={_lastAppliedRoundId} localId={MpNetworkManager.Instance?.LocalPlayerId}");
			if (roundId == _lastAppliedRoundId) return;
			_lastAppliedRoundId = roundId;

			var modeStr = (string)payload["mode"];
			_mode = modeStr == "coop" ? Mode.Coop : Mode.Normal;
			_readyStates.Clear();
			_roundActive = true;
			if (MpNetworkManager.LatestMpPanel != null) MpNetworkManager.LatestMpPanel.SetActive(false);
			if (_mode == Mode.Coop) _coop.HideCloneUpgradeBoxes();
			_roundMapHubId = (string)payload["mapHubId"];
			_roundMapKind = payload["mapKind"]?.Value<string>() ?? "current";
			_selectedSaveName = payload["saveName"]?.Value<string>();
			_roundPlayerCount = payload["playerCount"]?.Value<int>() ?? (MpNetworkManager.Instance?.LastSnapshotPlayers.Count + 1 ?? 1);
			if (payload["spawnX"] != null && payload["spawnY"] != null)
			{
				_roundSpawnX = payload["spawnX"].Value<double>();
				_roundSpawnY = payload["spawnY"].Value<double>();
				_hasRoundSpawn = true;
			}
			else _hasRoundSpawn = false;
			_pendingAbilities = _mode != Mode.Coop ? payload["abilities"] as JObject : null;
			_lastAppliedAbilities = _pendingAbilities;
			_pendingModeStart = _mode == Mode.Coop;
			TryStartModeEconomy();
			TryApplyPendingAbilities();
			_pendingTeleportToStart = true;
			_statusMessage = "Playing!";
			if (_roundMapKind == "base" || _roundMapKind == "bside")
			{
				_pendingSceneChangeKind = _roundMapKind;
			}
			else
			{
				EnsureMapLoaded(_roundMapHubId, closeMenuWhenReady: true);
				TryCloseMenuIfNeeded();
			}
		}
		else if (kind == "stop")
		{
			EndRoundLocally("host ended the session");
		}
		else if (kind == "coopSync" || kind == "coopDelta")
		{
			_coop.HandleMessage(kind, payload, from, MpNetworkManager.Instance.LocalPlayerId);
		}
	}

	private void EnsureMapLoaded(string mapHubId, bool closeMenuWhenReady)
	{
		if (string.IsNullOrEmpty(mapHubId) || _host == null) { if (closeMenuWhenReady) _pendingMenuClose = true; return; }
		if (MpMapLibrary.IsDownloaded(mapHubId))
		{
			_host.Events.Emit("recharge.maps.load_requested", mapHubId);
			if (closeMenuWhenReady) _pendingMenuClose = true;
			return;
		}
		if (_mapDownloading) return;
		_mapDownloading = true;
		_statusMessage = "Downloading map...";
		new Thread(() =>
		{
			try
			{
				MpMapLibrary.DownloadAndExtract(mapHubId);
				_host.Events.Emit("recharge.maps.load_requested", mapHubId);
				if (closeMenuWhenReady) _pendingMenuClose = true;
			}
			catch (System.Exception e) { _statusMessage = "Map download failed: " + e.Message; }
			finally { _mapDownloading = false; }
		})
		{ IsBackground = true }.Start();
	}

	private JObject _pendingAbilities;
	private JObject _lastAppliedAbilities;

	private void TryApplyPendingAbilities()
	{
		if (_pendingAbilities == null || _localMovement == null) return;
		_normal.Apply(_localMovement, _pendingAbilities);
		_pendingAbilities = null;
	}

	private bool _pendingModeStart;

	private void TryStartModeEconomy()
	{
		if (!_pendingModeStart || _localMovement == null) return;
		_pendingModeStart = false;
		try
		{
			var mgrInst = MpNetworkManager.Instance;
			_coop.Begin(mgrInst.IsHost, _roundPlayerCount, _localMovement, _selectedSaveName);
		}
		catch (System.Exception e) { Debug.LogError("[HostPanel] Coop.Begin failed: " + e); }
	}

	private void EndRoundLocally(string reason)
	{
		if (!_roundActive) return;
		_roundActive = false;
		_roundMapHubId = null;
		_roundMapKind = "current";
		_statusMessage = "Round over: " + reason;
		_autoReadyTried = false;
		_normal.Restore();
		_lastAppliedAbilities = null;
		if (_mode == Mode.Coop) _coop.HideCloneUpgradeBoxes();
		_coop.RestoreCloneUpgradeBoxes();
		if (_mode == Mode.Coop) _coop.End(MpNetworkManager.Instance?.IsHost ?? false);
	}

	private bool _pendingMenuClose;

	private void TryCloseMenuIfNeeded()
	{
		if (!_pendingMenuClose || _menu == null) return;
		_pendingMenuClose = false;
		if (_menu.menuOpen) { _menu.menuButtonPressed(); Debug.Log("[HostPanel] TryCloseMenuIfNeeded: closed"); }
		else Debug.Log("[HostPanel] TryCloseMenuIfNeeded: no-op, menu already closed");
	}

	private string _pendingSceneChangeKind;

	private void TryApplyPendingSceneChange()
	{
		if (_pendingSceneChangeKind == null || _menu == null) return;
		var kind = _pendingSceneChangeKind;
		_pendingSceneChangeKind = null;
		var mgrForScene = MpNetworkManager.Instance;
		if (mgrForScene != null) mgrForScene.PendingBaseGameHard = kind == "bside";
		if (kind == "bside") _menu.changeSceneHard(); else _menu.changeScene();
	}

	private bool _pendingTeleportToStart;
	private static readonly System.Reflection.FieldInfo StartGateResetPointField = Reflect.FieldOf<startGate>("resetPoint");

	private void TryTeleportToStartSpawn()
	{
		if (!_pendingTeleportToStart || _localMovement == null) return;
		_pendingTeleportToStart = false;
		TeleportLocalPlayerToStartSpawn();
	}

	private void TeleportLocalPlayerToStartSpawn()
	{
		if (_localMovement == null) return;
		Vector2 pos;
		if (_hasRoundSpawn)
		{
			// The host's first-spawn coordinate (world space -> this client's local space).
			pos = (Vector2)MpOrigin.ToLocal(_roundSpawnX, _roundSpawnY);
		}
		else
		{
			// No host spawn (older host, or base game): fall back to the map's start gate.
			courseScript firstCourse = null;
			foreach (var c in Object.FindObjectsByType<courseScript>(FindObjectsInactive.Include, FindObjectsSortMode.None))
				if (c != null && (firstCourse == null || c.courseNumber < firstCourse.courseNumber)) firstCourse = c;
			if (firstCourse == null) return;
			var gate = firstCourse.GetComponentInChildren<startGate>(true);
			if (gate == null) return;
			var resetPointGo = StartGateResetPointField?.GetValue(gate) as GameObject;
			if (resetPointGo == null) return;
			pos = resetPointGo.transform.position;
		}
		_localMovement.transform.position = pos;
		// respawnPoint is world space: the game adds FloatingOrigin.currentOrigin back on respawn.
		_localMovement.respawnPoint = pos - (Vector2)MpOrigin.Current;
		var body = _localMovement.GetComponent<Rigidbody2D>();
		if (body != null) body.position = pos;
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
			_pendingSceneChangeKind = hard ? "bside" : "base";
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
		if (mgr != null && _roundActive && mgr.IsHost) OnStopClicked();
		else OnStartClicked();
	}

	private void OnStopClicked()
	{
		var mgr = MpNetworkManager.Instance;
		if (mgr == null || !mgr.InLobby || !mgr.IsHost) return;
		mgr.SendGameMessage(new JObject { ["k"] = "stop" });
		_pendingStopResends = 4;
		_stopResendAccumulator = 0f;
		EndRoundLocally("host ended the session");
	}

	private void OnStartClicked()
	{
		var mgr = MpNetworkManager.Instance;
		if (mgr == null || !mgr.InLobby || !mgr.IsHost || _roundActive) return;
		// Co-op waits for everyone to ready up; normal mode starts on demand.
		if (_mode == Mode.Coop && !AllReady(mgr)) { _statusMessage = "Waiting for everyone to be ready."; return; }

		TryConsumePendingMapLoad();

		// The host's current position becomes the round's spawn: everyone lands
		// here on start, and late joiners spawn here too (the host's first spawn).
		if (_localMovement != null) { MpOrigin.ToWorld(_localMovement.transform.position, out _roundSpawnX, out _roundSpawnY); _hasRoundSpawn = true; }
		else _hasRoundSpawn = false;

		var others = mgr.LastSnapshotPlayers.Select(p => p.id).ToList();
		var everyone = new List<int>(others) { mgr.LocalPlayerId };

		string mapHubId = null, mapName = null;
		if (_selectedMapIndex >= 0 && _selectedMapIndex < _hostableMaps.Count)
		{
			var map = _hostableMaps[_selectedMapIndex];
			mapHubId = map.HubId;
			mapName = map.Name;
		}
		var mapKind = _selectedMapIndex == -2 ? "base" : _selectedMapIndex == -3 ? "bside" : "current";

		var abilities = new JObject();
		foreach (var kv in _abilityEnabled) abilities[kv.Key] = kv.Value;

		_sentRoundId++;
		_roundResendAccumulator = 0f;
		_roundPlayerCount = everyone.Count;
		Debug.Log($"[HostPanel] sending start: roundId={_sentRoundId} mode={_mode} everyone=[{string.Join(",", everyone)}] localId={mgr.LocalPlayerId}");
		var startMsg = new JObject
		{
			["k"] = "start",
			["mode"] = _mode == Mode.Coop ? "coop" : "normal",
			["mapHubId"] = mapHubId,
			["mapName"] = mapName,
			["mapKind"] = mapKind,
			["abilities"] = abilities,
			["saveName"] = _selectedSaveName,
			["roundId"] = _sentRoundId,
			["playerCount"] = _roundPlayerCount,
		};
		if (_hasRoundSpawn) { startMsg["spawnX"] = _roundSpawnX; startMsg["spawnY"] = _roundSpawnY; }
		mgr.SendGameMessage(startMsg);
	}

	private void ResendCurrentRoundState()
	{
		var mgr = MpNetworkManager.Instance;
		if (mgr == null) return;
		var abilities = new JObject();
		foreach (var kv in _abilityEnabled) abilities[kv.Key] = kv.Value;
		var resend = new JObject
		{
			["k"] = "start",
			["mode"] = _mode == Mode.Coop ? "coop" : "normal",
			["mapHubId"] = _roundMapHubId,
			["mapName"] = null,
			["mapKind"] = _roundMapKind,
			["abilities"] = abilities,
			["saveName"] = _selectedSaveName,
			["roundId"] = _sentRoundId,
			["playerCount"] = _roundPlayerCount,
		};
		// Late joiners get the host's first-spawn coordinate, unchanged.
		if (_hasRoundSpawn) { resend["spawnX"] = _roundSpawnX; resend["spawnY"] = _roundSpawnY; }
		mgr.SendGameMessage(resend);
	}

}

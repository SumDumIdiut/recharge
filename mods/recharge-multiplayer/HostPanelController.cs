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
	private GameObject _hostPanel;
	private Button _toggleButton;
	private bool _autoReadyTried;
	private int _lastKnownPlayerId;
	private bool _localReadyIntent;

	private Button _modeButton;
	private Button _mapButton;
	private Button _saveButton;
	private GameObject _rosterGo;
	private Button _startButton;
	private GameObject _statusGo;

	private GameObject _mainContent;
	private enum PickerKind { None, Map, Save }
	private PickerKind _activePicker = PickerKind.None;
	private GameObject _pickerSection;
	private TMP_Text _pickerHeader;
	private GameObject _pickerTemplate;
	private readonly List<GameObject> _pickerRows = new List<GameObject>();
	private int _pickerPage;
	private TMP_Text _pickerPageLabel;
	private Button _pickerPrevButton;
	private Button _pickerNextButton;
	private string _selectedSaveName; // null = "New Save" (fresh, wiped)

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

		_modeButton = BuildActionButton(panel.transform, template, "Mode: Normal", new Vector2(-152, 170), OnCycleModeClicked, width: 148, height: 48, fontSize: 16f);
		_mapButton = BuildActionButton(panel.transform, template, "Map: Current Map", new Vector2(0, 170), OnOpenMapPickerClicked, width: 148, height: 48, fontSize: 16f);
		_saveButton = BuildActionButton(panel.transform, template, "Save: New Save", new Vector2(152, 170), OnOpenSavePickerClicked, width: 148, height: 48, fontSize: 16f);
		MakeAutoSizeLabel(_modeButton, 8f, 15f);
		MakeAutoSizeLabel(_mapButton, 8f, 15f);
		MakeAutoSizeLabel(_saveButton, 8f, 15f);

		BuildPickerSection(panel.transform, template);

		_mainContent = new GameObject("HostPanel_MainContent", typeof(RectTransform));
		_mainContent.transform.SetParent(panel.transform, false);

		CreateDivider(_mainContent.transform, new Vector2(0, 125), 420);

		var abilityCaptionGo = Object.Instantiate(template, _mainContent.transform);
		abilityCaptionGo.name = "HostPanel_AbilityCaption";
		abilityCaptionGo.SetActive(true);
		var abilityCaptionBtn = abilityCaptionGo.GetComponent<Button>();
		if (abilityCaptionBtn != null) abilityCaptionBtn.enabled = false;
		var abilityCaptionRt = (RectTransform)abilityCaptionGo.transform;
		abilityCaptionRt.anchoredPosition = new Vector2(0, 100);
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
			var go = Object.Instantiate(template, _mainContent.transform);
			go.name = "HostPanel_Ability_" + key;
			go.SetActive(true);
			var rt = (RectTransform)go.transform;
			rt.anchoredPosition = new Vector2(xs[i], 55);
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

		CreateDivider(_mainContent.transform, new Vector2(0, 15), 420);

		var rosterBoxGo = new GameObject("HostPanelRosterBox", typeof(RectTransform), typeof(Image));
		rosterBoxGo.transform.SetParent(_mainContent.transform, false);
		var rosterBoxRt = (RectTransform)rosterBoxGo.transform;
		rosterBoxRt.anchoredPosition = new Vector2(0, -35);
		rosterBoxRt.sizeDelta = new Vector2(420, 80);
		rosterBoxGo.GetComponent<Image>().color = new Color(0f, 0f, 0f, 0.25f);

		_rosterGo = Object.Instantiate(template, _mainContent.transform);
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

		_startButton = BuildActionButton(_mainContent.transform, template, "Start Playing", new Vector2(0, -110), OnStartOrStopClicked);

		_statusGo = Object.Instantiate(template, _mainContent.transform);
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

	// Now opens for everyone - config controls already gate off canConfigure
	private void OnToggleOrReadyClicked()
	{
		OnToggleHostPanelClicked();
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
		_selectedSaveName = null; // a save picked for one mode isn't valid for another
	}

	private static void MakeAutoSizeLabel(Button btn, float min, float max)
	{
		var tmp = btn.GetComponentInChildren<TMP_Text>();
		if (tmp == null) return;
		tmp.enableAutoSizing = true;
		tmp.fontSizeMin = min;
		tmp.fontSizeMax = max;
		tmp.textWrappingMode = TextWrappingModes.NoWrap;
		tmp.overflowMode = TextOverflowModes.Overflow;
	}

	private void BuildPickerSection(Transform panel, GameObject template)
	{
		_pickerTemplate = template;
		_pickerSection = new GameObject("HostPanel_PickerSection", typeof(RectTransform));
		_pickerSection.transform.SetParent(panel, false);

		var headerGo = Object.Instantiate(template, _pickerSection.transform);
		headerGo.name = "HostPanel_PickerHeader";
		headerGo.SetActive(true);
		var headerBtn = headerGo.GetComponent<Button>();
		if (headerBtn != null) headerBtn.enabled = false;
		var headerRt = (RectTransform)headerGo.transform;
		headerRt.anchoredPosition = new Vector2(0, 165);
		headerRt.sizeDelta = new Vector2(400, 34);
		_pickerHeader = headerGo.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (_pickerHeader != null)
		{
			var loc = _pickerHeader.GetComponent<UnityEngine.Localization.Components.LocalizeStringEvent>();
			if (loc != null) Object.DestroyImmediate(loc);
			_pickerHeader.enableAutoSizing = false;
			_pickerHeader.fontSize = 22;
			_pickerHeader.textWrappingMode = TextWrappingModes.NoWrap;
			_pickerHeader.overflowMode = TextOverflowModes.Overflow;
		}

		_pickerPrevButton = BuildActionButton(_pickerSection.transform, template, "<", new Vector2(-150, -142), () => ChangePickerPage(-1), width: 56, height: 40, fontSize: 18f);
		_pickerNextButton = BuildActionButton(_pickerSection.transform, template, ">", new Vector2(150, -142), () => ChangePickerPage(1), width: 56, height: 40, fontSize: 18f);

		var pageLabelGo = Object.Instantiate(template, _pickerSection.transform);
		pageLabelGo.name = "HostPanel_PickerPageLabel";
		pageLabelGo.SetActive(true);
		var pageLabelBtn = pageLabelGo.GetComponent<Button>();
		if (pageLabelBtn != null) pageLabelBtn.enabled = false;
		var pageLabelRt = (RectTransform)pageLabelGo.transform;
		pageLabelRt.anchoredPosition = new Vector2(0, -142);
		pageLabelRt.sizeDelta = new Vector2(180, 30);
		_pickerPageLabel = pageLabelGo.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (_pickerPageLabel != null)
		{
			var loc = _pickerPageLabel.GetComponent<UnityEngine.Localization.Components.LocalizeStringEvent>();
			if (loc != null) Object.DestroyImmediate(loc);
			_pickerPageLabel.enableAutoSizing = false;
			_pickerPageLabel.fontSize = 14;
			_pickerPageLabel.color = new Color(1f, 1f, 1f, 0.6f);
			_pickerPageLabel.textWrappingMode = TextWrappingModes.NoWrap;
			_pickerPageLabel.overflowMode = TextOverflowModes.Overflow;
		}

		var cancelGo = BuildActionButton(_pickerSection.transform, template, "Cancel", new Vector2(0, -195), () => _activePicker = PickerKind.None);
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

	private static string SaveRootFolder(Mode mode) => mode switch
	{
		Mode.Coop => "/SavedataCoop",
		Mode.HideAndSeek => HideAndSeekSaveFolder,
		Mode.Infection => InfectionSaveFolder,
		_ => null,
	};

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
		// DestroyImmediate, not Destroy - avoids a frame of old+new rows overlapping
		foreach (var row in _pickerRows) Object.DestroyImmediate(row);
		_pickerRows.Clear();

		var entries = new List<(string Label, System.Action OnClick)>();
		if (_activePicker == PickerKind.Map)
		{
			if (_pickerHeader != null) _pickerHeader.text = "Choose a Map";
			entries.Add(("Current Map", () => { _selectedMapIndex = -1; _activePicker = PickerKind.None; }));
			for (int i = 0; i < _hostableMaps.Count; i++)
			{
				var idx = i;
				entries.Add((_hostableMaps[i].Name, () => { _selectedMapIndex = idx; _activePicker = PickerKind.None; }));
			}
		}
		else if (_activePicker == PickerKind.Save)
		{
			if (_pickerHeader != null) _pickerHeader.text = "Choose a Save";
			entries.Add(("New Save", () => { _selectedSaveName = null; _activePicker = PickerKind.None; }));
			foreach (var name in ListSavesForCurrentMode())
			{
				var captured = name;
				entries.Add((captured, () => { _selectedSaveName = captured; _activePicker = PickerKind.None; }));
			}
		}

		// caps rows shown per page so the list can't grow into the Cancel button
		var totalPages = Mathf.Max(1, Mathf.CeilToInt(entries.Count / (float)PickerRowsPerPage));
		_pickerPage = Mathf.Clamp(_pickerPage, 0, totalPages - 1);

		float y = 110f;
		const float spacing = 54f;
		var start = _pickerPage * PickerRowsPerPage;
		var end = Mathf.Min(start + PickerRowsPerPage, entries.Count);
		for (int i = start; i < end; i++)
		{
			_pickerRows.Add(CreatePickerRow(entries[i].Label, y, entries[i].OnClick));
			y -= spacing;
		}

		if (_pickerPageLabel != null) _pickerPageLabel.text = totalPages > 1 ? $"Page {_pickerPage + 1}/{totalPages}" : "";
		if (_pickerPrevButton != null) _pickerPrevButton.gameObject.SetActive(totalPages > 1);
		if (_pickerNextButton != null) _pickerNextButton.gameObject.SetActive(totalPages > 1);
	}

	private void ChangePickerPage(int delta)
	{
		_pickerPage += delta;
		RefreshPickerRows();
	}

	private GameObject CreatePickerRow(string label, float y, System.Action onClick)
	{
		var go = Object.Instantiate(_pickerTemplate, _pickerSection.transform);
		go.name = "HostPanel_PickerRow";
		go.SetActive(true);
		var rt = (RectTransform)go.transform;
		rt.anchoredPosition = new Vector2(0, y);
		rt.sizeDelta = new Vector2(380, 44);
		PauseMenuHelper.SetButtonLabel(go, label);
		var tmp = go.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (tmp != null)
		{
			tmp.enableAutoSizing = true;
			tmp.fontSizeMin = 10f;
			tmp.fontSizeMax = 20f;
			tmp.textWrappingMode = TextWrappingModes.NoWrap;
			tmp.overflowMode = TextOverflowModes.Overflow;
		}
		var btn = go.GetComponent<Button>();
		btn.onClick = new Button.ButtonClickedEvent();
		btn.onClick.AddListener(() => onClick());
		return go;
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
		// preserve the selection across the scene-reload rebuild
		var previouslySelectedHubId = _selectedMapIndex >= 0 && _selectedMapIndex < _hostableMaps.Count
			? _hostableMaps[_selectedMapIndex].HubId
			: null;
		new Thread(() =>
		{
			try { _hostableMaps = MpMapLibrary.GetHostableMaps(); }
			finally
			{
				_mapListLoading = false;
				_selectedMapIndex = previouslySelectedHubId != null
					? _hostableMaps.FindIndex(m => m.HubId == previouslySelectedHubId)
					: -1;
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
			mgr.SendGameMessage(new JObject { ["k"] = "ready", ["ready"] = true });
		}

		// a reconnect hands out a new connection id - resend ready under it
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

		// seeker's menu-close is deferred during HideSeconds (see Update()) - show why
		bool seekerWaiting = _roundActive && mgr != null && IsLocalSeeking() && Time.unscaledTime < _hideEndTime;
		if (_toggleButton != null)
		{
			if (seekerWaiting)
			{
				var left = Mathf.CeilToInt(_hideEndTime - Time.unscaledTime);
				PauseMenuHelper.SetButtonLabel(_toggleButton.gameObject, "You're it! " + left + "s");
			}
			else PauseMenuHelper.SetButtonLabel(_toggleButton.gameObject, "Host Panel");
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
		if (_saveButton != null)
		{
			bool canPickSave = canConfigure && SaveRootFolder(_mode) != null;
			_saveButton.interactable = canPickSave;
			var saveLabel = _selectedSaveName ?? "New Save";
			if (saveLabel.Length > 14) saveLabel = saveLabel.Substring(0, 12) + "..";
			PauseMenuHelper.SetButtonLabel(_saveButton.gameObject, "Save: " + saveLabel);
		}

		bool showingPicker = _activePicker != PickerKind.None;
		if (_mainContent != null) _mainContent.SetActive(!showingPicker);
		if (_pickerSection != null) _pickerSection.SetActive(showingPicker);
		if (showingPicker) return;

		// Coop never applies these (its abilities are earned via the shared
		// economy, not host-restricted) - _pendingAbilities is null-ed out for
		// Coop in the "start" handler, so leaving these clickable silently did nothing.
		bool canConfigureAbilities = canConfigure && _mode != Mode.Coop;
		foreach (var (key, btn) in _abilityButtons)
		{
			if (btn == null) continue;
			bool enabled = _abilityEnabled[key];
			btn.interactable = canConfigureAbilities;
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
		bool roundActiveAsHost = _roundActive && isHost;
		if (_startButton != null)
		{
			if (!isHost)
			{
				// guests reuse this slot as their Ready toggle instead of Start/Stop
				_startButton.interactable = mgr != null && inLobby;
				bool selfReady = mgr != null && _readyStates.TryGetValue(mgr.LocalPlayerId, out var sready) && sready;
				PauseMenuHelper.SetButtonLabel(_startButton.gameObject, selfReady ? "Unready" : "Ready");
			}
			else if (roundActiveAsHost)
			{
				_startButton.interactable = true;
				PauseMenuHelper.SetButtonLabel(_startButton.gameObject, openEnded ? "Stop Playing" : "Stop Round");
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
		else if (seekerWaiting) statusText = "You're the seeker - hiders get " + Mathf.CeilToInt(_hideEndTime - Time.unscaledTime) + "s to hide...";
		else if (roundActiveAsHost) statusText = openEnded ? "Playing - click Stop Playing to end." : "Round in progress - click Stop Round to end.";
		else if (_roundActive) statusText = openEnded ? "Playing." : "Round in progress.";
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
	private int _lastAppliedRoundId = -1;
	private int _sentRoundId;
	private float _roundResendAccumulator;
	private const float RoundResendInterval = 3f;
	private int _pendingStopResends;
	private float _stopResendAccumulator;
	private const float StopResendInterval = 1f;
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
		TryStartModeEconomy();
		TryCloseMenuIfNeeded();

		if (_returnToLobbyPending && Time.unscaledTime - _returnToLobbyFadeStart >= ReturnToLobbyFadeDuration)
			ReturnToLobbyMenu();

		// same relay-drop risk as "start" (see its handler's comment) - resend a
		// few times regardless of _roundActive, since the host's own already
		// ended by the time this runs. EndRoundLocally is already a no-op once
		// stopped, so resending "stop" itself is always safe.
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
		if (!_roundActive) return;

		if (mgr.IsHost)
		{
			_roundResendAccumulator += Time.unscaledDeltaTime;
			if (_roundResendAccumulator >= RoundResendInterval)
			{
				_roundResendAccumulator = 0f;
				ResendCurrentRoundState();
			}
		}

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
			EnsureMapLoaded(_roundMapHubId, closeMenuWhenReady: true);
			TryCloseMenuIfNeeded();
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
			var roundId = payload["roundId"]?.Value<int>() ?? -1;
			Debug.Log($"[HostPanel] recv start: from={from} roundId={roundId} lastApplied={_lastAppliedRoundId} localId={MpNetworkManager.Instance?.LocalPlayerId}");
			// The relay drops a game_msg for anyone not in its member set at that
			// exact instant (a reconnect blip removes you until rejoin completes) -
			// no retry, no replay, gone. The host now resends "start" periodically
			// (see Update()) so anyone who missed the original catches up within a
			// few seconds; roundId makes a resend a no-op for clients that already
			// applied it, instead of re-running the disruptive resets below.
			if (roundId == _lastAppliedRoundId) return;
			_lastAppliedRoundId = roundId;

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
			_selectedSaveName = payload["saveName"]?.Value<string>();
			_pendingAbilities = _mode != Mode.Coop ? payload["abilities"] as JObject : null;
			_pendingModeStart = _mode == Mode.HideAndSeek || _mode == Mode.Infection || _mode == Mode.Coop;
			TryStartModeEconomy();
			ApplyLocalAppearance();
			TryApplyPendingAbilities();
			if (_mode == Mode.HideAndSeek) DisableWattsAndClones();
			_statusMessage = (_mode == Mode.Normal || _mode == Mode.Coop) ? "Playing!" : "Round started!";
			Debug.Log($"[HostPanel] start: IsLocalSeeking={IsLocalSeeking()} menuNull={_menu == null} menuOpen={_menu?.menuOpen}");
			if (!IsLocalSeeking())
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

	// closeMenu was previously always set true right after calling this - but a
	// map this client doesn't have yet downloads on a background thread, and
	// the menu closed into whatever scene was already loaded regardless,
	// looking exactly like "stuck"/"not entering the game" until the download
	// finished. Only set _pendingMenuClose once the map is actually ready (or
	// there's nothing to load in the first place).
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
				if (closeMenuWhenReady) _pendingMenuClose = true; // main-thread Update() picks this up - don't touch _menu from this thread
			}
			catch (System.Exception e) { _statusMessage = "Map download failed: " + e.Message; }
			finally { _mapDownloading = false; }
		})
		{ IsBackground = true }.Start();
	}

	private JObject _pendingAbilities;

	// retried every frame until _localMovement resolves, instead of one-shot
	private void TryApplyPendingAbilities()
	{
		if (_pendingAbilities == null || _localMovement == null) return;
		ApplyAbilityRestrictions(_pendingAbilities);
		_pendingAbilities = null;
	}

	private bool _pendingModeStart;

	// same _localMovement-retry reasoning as TryApplyPendingAbilities
	private void TryStartModeEconomy()
	{
		if (!_pendingModeStart || _localMovement == null) return;
		_pendingModeStart = false;
		if (_mode == Mode.HideAndSeek || _mode == Mode.Infection)
		{
			ActivateModeSaveFile(_mode, _selectedSaveName);
		}
		else if (_mode == Mode.Coop)
		{
			try
			{
				var mgrInst = MpNetworkManager.Instance;
				_coop.Begin(mgrInst.IsHost, mgrInst.LastSnapshotPlayers.Count + 1, _localMovement, _selectedSaveName);
			}
			catch (System.Exception e) { Debug.LogError("[HostPanel] Coop.Begin failed: " + e); }
		}
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
		// _readyStates gets wiped on the next round's "start" - re-arm auto-ready
		_autoReadyTried = false;
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

	private string _activeModeSaveFolder;

	private void ActivateModeSaveFile(Mode mode, string saveName)
	{
		try
		{
			var root = mode == Mode.HideAndSeek ? HideAndSeekSaveFolder : InfectionSaveFolder;
			var resolvedName = saveName ?? ("New-" + System.DateTime.Now.ToString("yyyyMMdd-HHmmss"));
			var folder = root + "/" + resolvedName;
			_activeModeSaveFolder = folder;
			_modeCourses.Clear();
			_modeCourses.AddRange(Object.FindObjectsByType<courseScript>(FindObjectsInactive.Include, FindObjectsSortMode.None));
			if (saveName != null && ModeSaveFile.Exists(folder))
			{
				ModeSaveFile.Load(folder, _localMovement, _modeCourses);
			}
			else
			{
				ModeSaveFile.ResetEconomyToZero(_localMovement, _modeCourses);
				ModeSaveFile.DeleteAndRecreateFolder(folder);
				ModeSaveFile.Save(folder, _localMovement, _modeCourses);
			}
			_modeSaveActive = true;
		}
		catch (System.Exception e) { Debug.LogError("[HostPanel] ActivateModeSaveFile failed: " + e); }
	}

	private void DeactivateModeSaveFile()
	{
		if (!_modeSaveActive) return;
		_modeSaveActive = false;
		try { if (_activeModeSaveFolder != null) ModeSaveFile.Save(_activeModeSaveFolder, _localMovement, _modeCourses); }
		catch (System.Exception e) { Debug.LogError("[HostPanel] persist failed: " + e); }
		try { ModeSaveFile.Restore(ModeSaveFile.RealSaveFolder(), _localMovement, _modeCourses); }
		catch (System.Exception e) { Debug.LogError("[HostPanel] DeactivateModeSaveFile failed: " + e); }
		_activeModeSaveFolder = null;
		_modeCourses.Clear();
	}

	private bool _pendingMenuClose;

	// _menu can be null/stale at the exact instant "start" arrives if this
	// client is still mid scene-load (InstallMenuRow hasn't re-run yet) -
	// the old one-shot CloseMenuIfOpen() had no retry, unlike every other
	// pending* flag in this file, so a client caught in that window would
	// never actually get their menu closed for the rest of the round.
	private void TryCloseMenuIfNeeded()
	{
		if (!_pendingMenuClose || _menu == null) return;
		_pendingMenuClose = false;
		if (_menu.menuOpen) { _menu.menuButtonPressed(); Debug.Log("[HostPanel] TryCloseMenuIfNeeded: closed"); }
		else Debug.Log("[HostPanel] TryCloseMenuIfNeeded: no-op, menu already closed");
	}

	private void ReturnToLobbyMenu()
	{
		if (_menu == null) return; // retried next frame via the Update() call site
		_returnToLobbyPending = false;
		if (_menu.menuOpen) return;
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

		_sentRoundId++;
		_roundResendAccumulator = 0f;
		Debug.Log($"[HostPanel] sending start: roundId={_sentRoundId} mode={_mode} seeker={seeker} everyone=[{string.Join(",", everyone)}] localId={mgr.LocalPlayerId}");
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
			["saveName"] = _selectedSaveName,
			["roundId"] = _sentRoundId,
		});
	}

	// The relay drops a game_msg for anyone not in its lobby member set at that
	// exact instant (see the "start" handler's comment) - resending the same
	// round's "start" periodically while it's active means a client who missed
	// it (a reconnect blip, mainly) catches up within a few seconds instead of
	// never entering the round at all. roundId makes this a no-op for clients
	// that already applied it.
	private void ResendCurrentRoundState()
	{
		var mgr = MpNetworkManager.Instance;
		if (mgr == null) return;
		var abilities = new JObject();
		foreach (var kv in _abilityEnabled) abilities[kv.Key] = kv.Value;
		mgr.SendGameMessage(new JObject
		{
			["k"] = "start",
			["mode"] = _mode == Mode.Infection ? "infection" : _mode == Mode.HideAndSeek ? "hideandseek" : _mode == Mode.Coop ? "coop" : "normal",
			["seeker"] = _seekerId,
			["hideSeconds"] = Mathf.Max(0f, _hideEndTime - Time.unscaledTime),
			["roundSeconds"] = _roundEndTime == float.MaxValue ? 0f : Mathf.Max(0f, _roundEndTime - Time.unscaledTime),
			["mapHubId"] = _roundMapHubId,
			["mapName"] = null,
			["abilities"] = abilities,
			["saveName"] = _selectedSaveName,
			["roundId"] = _sentRoundId,
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

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

	public void Init(IRechargeHost host)
	{
		_host = host;
	}

	public void InstallMenuRow(pauseMenuScript menu)
	{
		_menu = menu;
		if (MpNetworkManager.LatestInLobbyRow == null) return;

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

		_modeButton = BuildActionButton(panel.transform, template, "Mode: Normal", new Vector2(-152, 170), OnCycleModeClicked, width: 148, height: 60, fontSize: 16f);
		_mapButton = BuildActionButton(panel.transform, template, "Map: Current Map", new Vector2(0, 170), OnOpenMapPickerClicked, width: 148, height: 60, fontSize: 16f);
		_saveButton = BuildActionButton(panel.transform, template, "Save: New Save", new Vector2(152, 170), OnOpenSavePickerClicked, width: 148, height: 60, fontSize: 16f);
		MakeAutoSizeLabel(_modeButton, 10f, 20f);
		MakeAutoSizeLabel(_mapButton, 10f, 20f);
		MakeAutoSizeLabel(_saveButton, 10f, 20f);

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
			Mode.Normal => Mode.Coop,
			_ => Mode.Normal,
		};
		_selectedSaveName = null;
	}

	private static void MakeAutoSizeLabel(Button btn, float min, float max)
	{
		var tmp = btn.GetComponentInChildren<TMP_Text>();
		if (tmp == null) return;
		tmp.enableAutoSizing = true;
		tmp.fontSizeMin = min;
		tmp.fontSizeMax = max;
		tmp.textWrappingMode = TextWrappingModes.Normal;
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
			if (_pickerHeader != null) _pickerHeader.text = "Choose a Map";
			entries.Add(("Base Game", () => { _selectedMapIndex = -2; _activePicker = PickerKind.None; Debug.Log("[HostPanel] map picker: selected Base Game (-2)"); }));
			entries.Add(("B-Side", () => { _selectedMapIndex = -3; _activePicker = PickerKind.None; Debug.Log("[HostPanel] map picker: selected B-Side (-3)"); }));
			for (int i = 0; i < _hostableMaps.Count; i++)
			{
				var idx = i;
				entries.Add((_hostableMaps[i].Name, () => { _selectedMapIndex = idx; _activePicker = PickerKind.None; Debug.Log($"[HostPanel] map picker: selected hub map idx={idx} name={_hostableMaps[idx].Name}"); }));
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
			if (isHost) PauseMenuHelper.SetButtonLabel(_toggleButton.gameObject, "Host Panel");
			else
			{
				bool ready = mgr != null && _readyStates.TryGetValue(mgr.LocalPlayerId, out var tr) && tr;
				PauseMenuHelper.SetButtonLabel(_toggleButton.gameObject, ready ? "Unready" : "Ready");
			}
		}

		if (_hostPanel == null || !_hostPanel.activeInHierarchy) return;

		if (_modeButton != null)
		{
			_modeButton.interactable = canConfigure;
			var modeLabel = _mode == Mode.Coop ? "Co-op" : "Normal";
			PauseMenuHelper.SetButtonLabel(_modeButton.gameObject, "Mode:\n" + modeLabel);
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
			PauseMenuHelper.SetButtonLabel(_mapButton.gameObject, "Map:\n" + mapLabel);
		}
		if (_saveButton != null)
		{
			bool canPickSave = canConfigure && SaveRootFolder(_mode) != null;
			_saveButton.interactable = canPickSave;
			var saveLabel = _selectedSaveName ?? "New Save";
			if (saveLabel.Length > 14) saveLabel = saveLabel.Substring(0, 12) + "..";
			PauseMenuHelper.SetButtonLabel(_saveButton.gameObject, "Save:\n" + saveLabel);
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

		bool roundActiveAsHost = _roundActive && isHost;
		if (_startButton != null)
		{
			if (!isHost)
			{
				_startButton.interactable = mgr != null && inLobby;
				bool selfReady = mgr != null && _readyStates.TryGetValue(mgr.LocalPlayerId, out var sready) && sready;
				PauseMenuHelper.SetButtonLabel(_startButton.gameObject, selfReady ? "Unready" : "Ready");
			}
			else if (roundActiveAsHost)
			{
				_startButton.interactable = true;
				PauseMenuHelper.SetButtonLabel(_startButton.gameObject, "Stop Playing");
			}
			else
			{
				_startButton.interactable = mgr != null && inLobby && isHost && !_roundActive && AllReady(mgr);
				PauseMenuHelper.SetButtonLabel(_startButton.gameObject, "Start Playing");
			}
		}

		if (_statusGo == null) return;
		string statusText;
		if (mgr == null || !inLobby) statusText = "Host or join a lobby to play.";
		else if (roundActiveAsHost) statusText = "Playing - click Stop Playing to end.";
		else if (_roundActive) statusText = "Playing.";
		else if (!isHost) statusText = "Waiting for the host to start.";
		else if (!string.IsNullOrEmpty(_statusMessage)) statusText = _statusMessage;
		else if (!AllReady(mgr)) statusText = "Waiting for everyone to ready up...";
		else statusText = "Everyone's ready - click Start Playing!";
		PauseMenuHelper.SetButtonLabel(_statusGo, statusText);
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

	private Movement _localMovement;

	private void Update()
	{
		RefreshMenu();

		var mgr = MpNetworkManager.Instance;
		if (mgr == null) return;

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
			_coop.HandleMessage(kind, payload, MpNetworkManager.Instance.IsHost);
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
	private static readonly System.Reflection.FieldInfo StartGateResetPointField =
		typeof(startGate).GetField("resetPoint", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);

	private void TryTeleportToStartSpawn()
	{
		if (!_pendingTeleportToStart || _localMovement == null) return;
		_pendingTeleportToStart = false;
		TeleportLocalPlayerToStartSpawn();
	}

	private void TeleportLocalPlayerToStartSpawn()
	{
		if (_localMovement == null) return;
		courseScript firstCourse = null;
		foreach (var c in Object.FindObjectsByType<courseScript>(FindObjectsInactive.Include, FindObjectsSortMode.None))
			if (c != null && (firstCourse == null || c.courseNumber < firstCourse.courseNumber)) firstCourse = c;
		if (firstCourse == null) return;
		var gate = firstCourse.GetComponentInChildren<startGate>(true);
		if (gate == null) return;
		var resetPointGo = StartGateResetPointField?.GetValue(gate) as GameObject;
		if (resetPointGo == null) return;

		Vector2 pos = resetPointGo.transform.position;
		_localMovement.transform.position = pos;
		_localMovement.respawnPoint = pos;
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
		if (!AllReady(mgr)) { _statusMessage = "Waiting for everyone to be ready."; return; }

		TryConsumePendingMapLoad();

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
		mgr.SendGameMessage(new JObject
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
		});
	}

	private void ResendCurrentRoundState()
	{
		var mgr = MpNetworkManager.Instance;
		if (mgr == null) return;
		var abilities = new JObject();
		foreach (var kv in _abilityEnabled) abilities[kv.Key] = kv.Value;
		mgr.SendGameMessage(new JObject
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
		});
	}

}

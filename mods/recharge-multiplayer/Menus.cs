using System;
using System.Collections.Generic;
using System.Threading;
using Recharge.ModApi;
using TMPro;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.SceneManagement;
using UnityEngine.UI;
using Object = UnityEngine.Object;

internal class MpChatKeybindRow : MonoBehaviour
{
	private TMP_Text _keyText;

	public void Init(TMP_Text keyText, Button keyButton)
	{
		_keyText = keyText;
		keyButton.onClick.RemoveAllListeners();
		keyButton.onClick.AddListener(MpInGameChatHud.BeginRebind);
	}

	private void Update()
	{
		if (_keyText == null) return;
		_keyText.text = MpInGameChatHud.IsRebinding ? "..." : MpInGameChatHud.ChatKeyName.ToUpperInvariant();
	}
}

internal class MpInGameChatHud : MonoBehaviour
{
	private const string ChatKeyPrefsKey = "MpChatKeyBind";

	private Canvas _canvas;
	private CanvasGroup _logGroup;
	private Transform _logRowsContainer;
	private readonly List<GameObject> _logRows = new List<GameObject>();
	private GameObject _inputRow;
	private TMP_InputField _input;
	private int _lastChatLineCount = -1;
	private float _lastMessageAt = -999f;
	private const float LogFadeDelay = 15f;
	private const float LogFadeDuration = 0.5f;
	private bool _chatOpen;
	private int _openedFrame = -1;
	private int _closedFrame = -1;

	private static Key _chatKey = LoadChatKey();
	public static bool IsRebinding { get; private set; }

	public bool ForceShow;

	private const int MaxVisibleLines = 6;

	public static string ChatKeyName => _chatKey.ToString();

	public static void BeginRebind() => IsRebinding = true;

	private static readonly System.Reflection.FieldInfo MoveActionField =
		typeof(Movement).GetField("moveAction", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
	private static readonly System.Reflection.FieldInfo JumpActionField =
		typeof(Movement).GetField("jumpAction", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
	private static readonly System.Reflection.FieldInfo DashActionField =
		typeof(Movement).GetField("dashAction", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
	private static readonly System.Reflection.FieldInfo ResetActionField =
		typeof(Movement).GetField("resetAction", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);

	private static void SetPlayerInputEnabled(bool enabled)
	{
		var player = MpNetworkManager.LocalPlayer;
		if (player == null) return;
		SetActionEnabled(MoveActionField, player, enabled);
		SetActionEnabled(JumpActionField, player, enabled);
		SetActionEnabled(DashActionField, player, enabled);
		SetActionEnabled(ResetActionField, player, enabled);
	}

	private static void SetActionEnabled(System.Reflection.FieldInfo field, Movement player, bool enabled)
	{
		if (field?.GetValue(player) is InputAction action)
		{
			if (enabled) action.Enable(); else action.Disable();
		}
	}

	private static Key LoadChatKey()
	{
		var name = PlayerPrefs.GetString(ChatKeyPrefsKey, "Enter");
		return Enum.TryParse<Key>(name, out var k) ? k : Key.Enter;
	}

	private static void SetChatKey(Key key)
	{
		_chatKey = key;
		PlayerPrefs.SetString(ChatKeyPrefsKey, key.ToString());
		PlayerPrefs.Save();
	}

	private void Awake()
	{
		BuildUi();
		Debug.Log("[MpInGameChatHud] built, canvas=" + (_canvas != null));
	}

	private void BuildUi()
	{
		var canvasGo = new GameObject("MpChatHud", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
		canvasGo.transform.SetParent(transform, false);
		_canvas = canvasGo.GetComponent<Canvas>();
		_canvas.renderMode = RenderMode.ScreenSpaceOverlay;
		_canvas.sortingOrder = 400;
		var scaler = canvasGo.GetComponent<CanvasScaler>();
		scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
		scaler.referenceResolution = new Vector2(1920, 1080);
		scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
		scaler.matchWidthOrHeight = 0.5f;

		var logGo = new GameObject("LogPanel", typeof(RectTransform), typeof(CanvasGroup), typeof(Image));
		logGo.transform.SetParent(canvasGo.transform, false);
		var logRt = (RectTransform)logGo.transform;
		logRt.anchorMin = new Vector2(1, 1);
		logRt.anchorMax = new Vector2(1, 1);
		logRt.pivot = new Vector2(1, 1);
		logRt.anchoredPosition = new Vector2(-20, -20);
		logRt.sizeDelta = new Vector2(460, 150);
		logGo.GetComponent<Image>().color = new Color(0f, 0f, 0f, 0.45f);
		logGo.AddComponent<RectMask2D>();
		_logGroup = logGo.GetComponent<CanvasGroup>();
		_logGroup.alpha = 0f;
		_logGroup.blocksRaycasts = false;
		_logGroup.interactable = false;

		var logRowsGo = new GameObject("LogRows", typeof(RectTransform));
		logRowsGo.transform.SetParent(logGo.transform, false);
		var logRowsRt = (RectTransform)logRowsGo.transform;
		logRowsRt.anchorMin = Vector2.zero;
		logRowsRt.anchorMax = Vector2.one;
		logRowsRt.offsetMin = new Vector2(10, 8);
		logRowsRt.offsetMax = new Vector2(-10, -8);
		_logRowsContainer = logRowsGo.transform;

		_inputRow = new GameObject("ChatInputRow", typeof(RectTransform), typeof(Image));
		_inputRow.transform.SetParent(canvasGo.transform, false);
		var inputRt = (RectTransform)_inputRow.transform;
		inputRt.anchorMin = new Vector2(1, 1);
		inputRt.anchorMax = new Vector2(1, 1);
		inputRt.pivot = new Vector2(1, 1);
		inputRt.anchoredPosition = new Vector2(-20, -176);
		inputRt.sizeDelta = new Vector2(460, 34);
		_inputRow.GetComponent<Image>().color = new Color(0f, 0f, 0f, 0.6f);

		var textArea = new GameObject("Text Area", typeof(RectTransform));
		textArea.transform.SetParent(_inputRow.transform, false);
		var textAreaRt = (RectTransform)textArea.transform;
		textAreaRt.anchorMin = Vector2.zero;
		textAreaRt.anchorMax = Vector2.one;
		textAreaRt.offsetMin = new Vector2(8, 2);
		textAreaRt.offsetMax = new Vector2(-8, -2);
		textArea.AddComponent<RectMask2D>();

		var textGo = new GameObject("Text", typeof(RectTransform));
		textGo.transform.SetParent(textArea.transform, false);
		var textRt = (RectTransform)textGo.transform;
		textRt.anchorMin = Vector2.zero;
		textRt.anchorMax = Vector2.one;
		textRt.offsetMin = Vector2.zero;
		textRt.offsetMax = Vector2.zero;
		var text = textGo.AddComponent<TextMeshProUGUI>();
		text.fontSize = 18;
		text.color = Color.white;
		text.alignment = TextAlignmentOptions.MidlineLeft;
		text.enableWordWrapping = false;

		var placeholderGo = new GameObject("Placeholder", typeof(RectTransform));
		placeholderGo.transform.SetParent(textArea.transform, false);
		var placeholderRt = (RectTransform)placeholderGo.transform;
		placeholderRt.anchorMin = Vector2.zero;
		placeholderRt.anchorMax = Vector2.one;
		placeholderRt.offsetMin = Vector2.zero;
		placeholderRt.offsetMax = Vector2.zero;
		var placeholderText = placeholderGo.AddComponent<TextMeshProUGUI>();
		placeholderText.text = "Say something...";
		placeholderText.fontSize = 18;
		placeholderText.color = new Color(1f, 1f, 1f, 0.4f);
		placeholderText.fontStyle = FontStyles.Italic;
		placeholderText.alignment = TextAlignmentOptions.MidlineLeft;

		_input = _inputRow.AddComponent<TMP_InputField>();
		_input.textViewport = textAreaRt;
		_input.textComponent = text;
		_input.placeholder = placeholderText;
		_input.text = "";
		_input.onSubmit.AddListener(_ => SendAndClose());
		_inputRow.SetActive(false);
	}

	private void Update()
	{
		if (IsRebinding)
		{
			var kbd = Keyboard.current;
			if (kbd != null)
			{
				foreach (var control in kbd.allKeys)
				{
					if (control.wasPressedThisFrame)
					{
						SetChatKey(control.keyCode);
						IsRebinding = false;
						break;
					}
				}
			}
			return;
		}

		var mgr = MpNetworkManager.Instance;
		bool inLobby = mgr != null && mgr.InLobby;
		bool pauseMenuOpen = Time.timeScale <= 0f;
		bool inMainMenu = SceneManager.GetActiveScene().name == "MainMenu";
		bool shouldShow = inLobby && !inMainMenu && (!pauseMenuOpen || ForceShow);

		_canvas.enabled = shouldShow;
		if (!shouldShow)
		{
			if (_chatOpen) CloseInput();
			return;
		}

		if (mgr.ChatLines.Count != _lastChatLineCount)
		{
			RefreshChatLog(mgr.ChatLines);
			_lastMessageAt = Time.unscaledTime;
		}

		var kb = Keyboard.current;
		if (kb != null && !_chatOpen && kb[_chatKey].wasPressedThisFrame && Time.frameCount != _closedFrame)
		{
			OpenInput();
		}
		else if (kb != null && _chatOpen)
		{
			bool backspaceOnEmpty = kb.backspaceKey.wasPressedThisFrame && string.IsNullOrEmpty(_input.text);
			if (kb.escapeKey.wasPressedThisFrame || backspaceOnEmpty) CloseInput();
		}

		if (_chatOpen && Time.frameCount != _openedFrame && !_input.isFocused)
		{
			CloseInput();
		}

		bool sinceMessageFresh = Time.unscaledTime - _lastMessageAt < LogFadeDelay;
		float targetAlpha = (_chatOpen || sinceMessageFresh) ? 1f : 0f;
		_logGroup.alpha = Mathf.MoveTowards(_logGroup.alpha, targetAlpha, Time.unscaledDeltaTime / LogFadeDuration);
	}

	private const float LogRowHeight = 22f;
	private const int LogMaxMessageLines = 2;
	private const float LogNameColumnWidth = 140f;
	private const float LogColumnSpacing = 10f;

	private void RefreshChatLog(List<string> chatLines)
	{
		_lastChatLineCount = chatLines.Count;
		foreach (var row in _logRows) UnityEngine.Object.Destroy(row);
		_logRows.Clear();
		if (chatLines.Count == 0) return;

		var start = Mathf.Max(0, chatLines.Count - MaxVisibleLines);
		var visible = chatLines.GetRange(start, chatLines.Count - start);
		var containerWidth = ((RectTransform)_logRowsContainer).rect.width;
		var messageColumnWidth = Mathf.Max(0, containerWidth - LogNameColumnWidth - LogColumnSpacing);

		float y = 2f;
		for (int i = visible.Count - 1; i >= 0; i--)
		{
			var line = visible[i];
			var colonIdx = line.IndexOf(": ", StringComparison.Ordinal);
			var namePart = colonIdx >= 0 ? line.Substring(0, colonIdx) : line;
			var messagePart = colonIdx >= 0 ? line.Substring(colonIdx + 2) : "";

			var rowGo = new GameObject("ChatRow", typeof(RectTransform), typeof(HorizontalLayoutGroup));
			rowGo.transform.SetParent(_logRowsContainer, false);
			var rowRt = (RectTransform)rowGo.transform;
			rowRt.anchorMin = new Vector2(0, 0);
			rowRt.anchorMax = new Vector2(1, 0);
			rowRt.pivot = new Vector2(0.5f, 0f);
			var hlg = rowGo.GetComponent<HorizontalLayoutGroup>();
			hlg.childAlignment = TextAnchor.UpperLeft;
			hlg.childControlWidth = true;
			hlg.childControlHeight = true;
			hlg.childForceExpandWidth = false;
			hlg.childForceExpandHeight = true;
			hlg.spacing = LogColumnSpacing;

			var nameGo = new GameObject("Name", typeof(RectTransform), typeof(LayoutElement));
			nameGo.transform.SetParent(rowGo.transform, false);
			nameGo.GetComponent<LayoutElement>().preferredWidth = LogNameColumnWidth;
			var nameTmp = nameGo.AddComponent<TextMeshProUGUI>();
			nameTmp.fontSize = 17;
			nameTmp.alignment = TextAlignmentOptions.TopLeft;
			nameTmp.enableWordWrapping = false;
			nameTmp.overflowMode = TextOverflowModes.Ellipsis;
			nameTmp.color = Color.white;
			nameTmp.outlineWidth = 0.18f;
			nameTmp.outlineColor = new Color32(0, 0, 0, 255);
			nameTmp.text = namePart;

			var msgGo = new GameObject("Message", typeof(RectTransform), typeof(LayoutElement));
			msgGo.transform.SetParent(rowGo.transform, false);
			msgGo.GetComponent<LayoutElement>().flexibleWidth = 1f;
			var msgTmp = msgGo.AddComponent<TextMeshProUGUI>();
			msgTmp.fontSize = 17;
			msgTmp.alignment = TextAlignmentOptions.TopRight;
			msgTmp.enableWordWrapping = true;
			msgTmp.overflowMode = TextOverflowModes.Ellipsis;
			msgTmp.maxVisibleLines = LogMaxMessageLines;
			msgTmp.color = Color.white;
			msgTmp.outlineWidth = 0.18f;
			msgTmp.outlineColor = new Color32(0, 0, 0, 255);
			msgTmp.text = messagePart;

			var neededHeight = msgTmp.GetPreferredValues(messagePart, messageColumnWidth, 0f).y;
			var rowHeight = Mathf.Clamp(neededHeight, LogRowHeight, LogRowHeight * LogMaxMessageLines);

			rowRt.anchoredPosition = new Vector2(0, y);
			rowRt.sizeDelta = new Vector2(0, rowHeight);
			y += rowHeight;

			_logRows.Add(rowGo);
		}
	}

	private void OpenInput()
	{
		_chatOpen = true;
		_openedFrame = Time.frameCount;
		_inputRow.SetActive(true);
		_input.text = "";
		_input.ActivateInputField();
		EventSystem.current.SetSelectedGameObject(_input.gameObject);
		SetPlayerInputEnabled(false);
	}

	private void CloseInput()
	{
		_chatOpen = false;
		_closedFrame = Time.frameCount;
		_input.DeactivateInputField();
		_inputRow.SetActive(false);
		if (EventSystem.current != null && EventSystem.current.currentSelectedGameObject == _input.gameObject)
			EventSystem.current.SetSelectedGameObject(null);
		SetPlayerInputEnabled(true);
	}

	private void SendAndClose()
	{
		if (Time.frameCount == _openedFrame) return;
		var text = _input.text;
		CloseInput();
		if (!string.IsNullOrWhiteSpace(text)) MpNetworkManager.Instance?.SendChat(text);
	}
}

internal class MpPanelUI : MonoBehaviour
{
	private TMP_Text _status;

	private GameObject _hostRow;
	private TMP_InputField _lobbyNameField;
	private List<MpMapLibrary.HostableMap> _hostableMaps = new List<MpMapLibrary.HostableMap>();
	private volatile bool _mapListLoading;

	private GameObject _mapPickerSection;
	private readonly List<GameObject> _mapPickerRows = new List<GameObject>();
	private bool _showingMapPicker;

	private GameObject _listBox;
	private GameObject _listContent;
	private readonly List<GameObject> _lobbyListRows = new List<GameObject>();
	private List<MpLobbyInfo> _lastRenderedLobbies;
	private int _lastRenderedPageIndex = -1;
	private Button _prevPageButton;
	private Button _nextPageButton;
	private TMP_Text _pageLabel;
	private int _lobbyPageIndex;
	private const int LobbyPageSize = 2;

	private GameObject _directConnectSection;
	private TMP_InputField _hostField;
	private TMP_InputField _portField;
	private Button _connectButton;
	private TMP_Text _connectButtonLabel;

	private GameObject _inLobbyRow;
	private TMP_Text _leaveLabel;
	private bool _leaveConfirmArmed;
	private float _leaveConfirmArmedAt;
	private const float LeaveConfirmTimeout = 3f;
	private TMP_Text _inLobbyLabel;
	private TMP_Text _playersLabel;
	private GameObject _chatBox;
	private Transform _chatLogContainer;
	private readonly List<GameObject> _chatLogRows = new List<GameObject>();
	private TMP_InputField _chatInputField;
	private int _lastChatLineCount = -1;

	private GameObject _buttonTemplate;
	private TMP_FontAsset _font;
	private float _refreshAccumulator;
	private float _lobbyListPollAccumulator;

	private GameObject _appearanceButton;
	private GameObject _appearanceSection;
	private bool _showingAppearance;
	private Image _colourSwatch;
	private Slider _rSlider, _gSlider, _bSlider;
	private TMP_InputField _nameField;
	private Color _pendingColor = Color.white;

	private readonly Color[] _colorPresets =
	{
		Color.white, new Color(1f, 0.3f, 0.3f), new Color(1f, 0.6f, 0.15f), new Color(1f, 0.9f, 0.2f),
		new Color(0.3f, 0.9f, 0.4f), new Color(0.2f, 0.85f, 0.85f), new Color(0.3f, 0.5f, 1f), new Color(0.85f, 0.4f, 0.95f),
		new Color(0.05f, 0.05f, 0.05f), new Color(0.4f, 0.4f, 0.4f), new Color(0.75f, 0.75f, 0.75f), new Color(0.55f, 0.35f, 0.2f),
		new Color(1f, 0.75f, 0.8f), new Color(0.7f, 0.2f, 0.2f), new Color(0.6f, 0.3f, 0.05f), new Color(0.8f, 0.75f, 0.1f),
		new Color(0.1f, 0.5f, 0.15f), new Color(0.05f, 0.35f, 0.35f), new Color(0.1f, 0.2f, 0.55f), new Color(0.4f, 0.1f, 0.5f),
		new Color(1f, 0.5f, 0.7f), new Color(0.6f, 1f, 0.9f), new Color(0.9f, 0.9f, 0.6f), new Color(0.5f, 0.9f, 1f),
	};
	private const int PresetsPerPage = 8;
	private readonly List<Image> _presetSwatches = new List<Image>();
	private int _presetPage;
	private TMP_Text _presetPageLabel;
	private pauseMenuScript _menu;


	public void Build(GameObject panel, TMP_FontAsset font, GameObject settingsButtonTemplate, pauseMenuScript menu)
	{
		_font = font;
		_buttonTemplate = settingsButtonTemplate;
		_menu = menu;
		var root = panel.transform;

		CreateDivider(root, new Vector2(-140, 188), 300);

		_status = CreateLabel(root, "Status", new Vector2(0, 165), new Vector2(600, 34), "Not connected");
		_status.alignment = TextAlignmentOptions.Center;
		_status.fontSize = 22;
		_status.enableWordWrapping = false;
		_status.overflowMode = TextOverflowModes.Ellipsis;

		var connectGo = CloneButton(root, "Connect", new Vector2(190, 165), new Vector2(200, 54));
		_connectButton = connectGo.GetComponent<Button>();
		_connectButtonLabel = connectGo.GetComponentInChildren<TMP_Text>();
		_connectButton.onClick.AddListener(OnConnectClicked);

		_appearanceButton = CloneButton(root, "Colour", new Vector2(-190, 165), new Vector2(200, 54));
		_appearanceButton.GetComponent<Button>().onClick.AddListener(OnAppearanceClicked);

		_hostRow = new GameObject("HostRow", typeof(RectTransform));
		_hostRow.transform.SetParent(root, false);
		_lobbyNameField = CreateInputField(_hostRow.transform, new Vector2(-90, 110), new Vector2(300, 44), "Lobby name");

		var hostGo = CloneButton(_hostRow.transform, "Host", new Vector2(195, 110), new Vector2(170, 60));
		hostGo.GetComponent<Button>().onClick.AddListener(OnHostButtonClicked);

		BuildListBox(root);
		BuildDirectConnectSection(root);
		BuildMapPickerSection(root);

		_inLobbyRow = new GameObject("InLobbyRow", typeof(RectTransform));
		_inLobbyRow.transform.SetParent(root, false);
		_inLobbyLabel = CreateLabel(_inLobbyRow.transform, "InLobbyLabel", new Vector2(0, 160), new Vector2(560, 34), "");
		_playersLabel = CreateLabel(_inLobbyRow.transform, "PlayersLabel", new Vector2(0, 133), new Vector2(560, 24), "");
		_playersLabel.fontSize = 16;
		_playersLabel.enableWordWrapping = false;
		_playersLabel.overflowMode = TextOverflowModes.Ellipsis;
		_playersLabel.color = new Color(1f, 1f, 1f, 0.75f);

		BuildChatSection(_inLobbyRow.transform);
		var leaveGo = CloneButton(_inLobbyRow.transform, "Leave Lobby", new Vector2(-150, -160), new Vector2(270, 60));
		_leaveLabel = leaveGo.GetComponentInChildren<TMP_Text>();
		leaveGo.GetComponent<Button>().onClick.AddListener(OnLeaveClicked);

		MpNetworkManager.LatestInLobbyRow = _inLobbyRow;

		BuildAppearanceSection(root);
	}

	private void BuildAppearanceSection(Transform root)
	{
		_appearanceSection = new GameObject("AppearanceSection", typeof(RectTransform));
		_appearanceSection.transform.SetParent(root, false);

		var header = CreateLabel(_appearanceSection.transform, "ColourHeader", new Vector2(0, 165), new Vector2(400, 34), "Colour");
		header.alignment = TextAlignmentOptions.Center;
		header.fontSize = 22;

		_colourSwatch = CreateSwatchButton(_appearanceSection.transform, new Vector2(0, 110), new Vector2(160, 50));
		ApplyRoundedBoxStyle(_colourSwatch, Color.white);

		const float presetSize = 50f;
		const float presetSpacing = 62f;
		var startX = -(PresetsPerPage - 1) * presetSpacing / 2f;
		for (int i = 0; i < _colorPresets.Length; i++)
		{
			var c = _colorPresets[i];
			var slot = i % PresetsPerPage;
			var x = startX + slot * presetSpacing;
			var swatch = CreateSwatchButton(_appearanceSection.transform, new Vector2(x, 30), new Vector2(presetSize, presetSize), c, () => Apply(c));
			ApplyRoundedBoxStyle(swatch, c);
			_presetSwatches.Add(swatch);
		}

		var prevGo = CloneButton(_appearanceSection.transform, "<", new Vector2(-280, 30), new Vector2(56, 54));
		var prevBtn = prevGo.GetComponent<Button>();
		prevBtn.onClick.AddListener(() => ChangePresetPage(-1));
		LockButtonColor(prevBtn);
		var nextGo = CloneButton(_appearanceSection.transform, ">", new Vector2(280, 30), new Vector2(56, 54));
		var nextBtn = nextGo.GetComponent<Button>();
		nextBtn.onClick.AddListener(() => ChangePresetPage(1));
		LockButtonColor(nextBtn);

		_presetPageLabel = CreateLabel(_appearanceSection.transform, "PresetPage", new Vector2(0, -5), new Vector2(160, 20), "");
		_presetPageLabel.alignment = TextAlignmentOptions.Center;
		_presetPageLabel.fontSize = 13;
		_presetPageLabel.color = new Color(1f, 1f, 1f, 0.6f);
		RefreshPresetPage();

		_nameField = CreateInputField(_appearanceSection.transform, new Vector2(0, -40), new Vector2(300, 40), "Your name");
		_nameField.characterLimit = 24;
		_nameField.onEndEdit.AddListener(OnNameFieldChanged);

		_rSlider = CreateColorSlider(_appearanceSection.transform, new Vector2(0, -80), "R", new Color(1f, 0.4f, 0.4f));
		_gSlider = CreateColorSlider(_appearanceSection.transform, new Vector2(0, -122), "G", new Color(0.4f, 1f, 0.4f));
		_bSlider = CreateColorSlider(_appearanceSection.transform, new Vector2(0, -164), "B", new Color(0.4f, 0.6f, 1f));
		_rSlider.onValueChanged.AddListener(_ => OnSliderChanged());
		_gSlider.onValueChanged.AddListener(_ => OnSliderChanged());
		_bSlider.onValueChanged.AddListener(_ => OnSliderChanged());

		var doneGo = CloneButton(_appearanceSection.transform, "Done", new Vector2(0, -195), new Vector2(280, 60));
		doneGo.GetComponent<Button>().onClick.AddListener(OnAppearanceDoneClicked);

		_appearanceSection.SetActive(false);
	}

	private static void LockButtonColor(Button btn)
	{
		var cb = btn.colors;
		cb.highlightedColor = cb.normalColor;
		cb.selectedColor = cb.normalColor;
		cb.pressedColor = new Color(cb.normalColor.r * 0.8f, cb.normalColor.g * 0.8f, cb.normalColor.b * 0.8f, cb.normalColor.a);
		btn.colors = cb;
	}

	private Image CreateSwatchButton(Transform parent, Vector2 pos, Vector2 size, Color? fixedColor = null, UnityEngine.Events.UnityAction onClick = null)
	{
		var go = new GameObject("Swatch", typeof(RectTransform), typeof(Image), typeof(Button));
		go.transform.SetParent(parent, false);
		var rt = (RectTransform)go.transform;
		rt.anchoredPosition = pos;
		rt.sizeDelta = size;
		var img = go.GetComponent<Image>();
		img.color = fixedColor ?? Color.white;
		if (onClick != null) go.GetComponent<Button>().onClick.AddListener(onClick);
		return img;
	}

	private Slider CreateColorSlider(Transform parent, Vector2 pos, string label, Color trackColor)
	{
		var container = new GameObject(label + "SliderRow", typeof(RectTransform));
		container.transform.SetParent(parent, false);
		((RectTransform)container.transform).anchoredPosition = pos;

		var labelTmp = CreateLabel(container.transform, "Label", new Vector2(-270, 0), new Vector2(30, 30), label);
		labelTmp.alignment = TextAlignmentOptions.MidlineLeft;
		labelTmp.fontSize = 22;
		labelTmp.color = trackColor;

		var sliderGo = new GameObject("Slider", typeof(RectTransform));
		sliderGo.transform.SetParent(container.transform, false);
		var sliderRt = (RectTransform)sliderGo.transform;
		sliderRt.anchoredPosition = new Vector2(30, 0);
		sliderRt.sizeDelta = new Vector2(480, 24);

		var bg = new GameObject("Background", typeof(RectTransform), typeof(Image));
		bg.transform.SetParent(sliderGo.transform, false);
		var bgRt = (RectTransform)bg.transform;
		bgRt.anchorMin = new Vector2(0, 0.25f);
		bgRt.anchorMax = new Vector2(1, 0.75f);
		bgRt.offsetMin = Vector2.zero;
		bgRt.offsetMax = Vector2.zero;
		bg.GetComponent<Image>().color = new Color(1f, 1f, 1f, 0.15f);

		var fillArea = new GameObject("Fill Area", typeof(RectTransform));
		fillArea.transform.SetParent(sliderGo.transform, false);
		var fillAreaRt = (RectTransform)fillArea.transform;
		fillAreaRt.anchorMin = new Vector2(0, 0.25f);
		fillAreaRt.anchorMax = new Vector2(1, 0.75f);
		fillAreaRt.offsetMin = new Vector2(5, 0);
		fillAreaRt.offsetMax = new Vector2(-5, 0);

		var fill = new GameObject("Fill", typeof(RectTransform), typeof(Image));
		fill.transform.SetParent(fillArea.transform, false);
		var fillRt = (RectTransform)fill.transform;
		fillRt.anchorMin = Vector2.zero;
		fillRt.anchorMax = new Vector2(0, 1);
		fillRt.sizeDelta = new Vector2(10, 0);
		fill.GetComponent<Image>().color = trackColor;

		var handleArea = new GameObject("Handle Slide Area", typeof(RectTransform));
		handleArea.transform.SetParent(sliderGo.transform, false);
		var handleAreaRt = (RectTransform)handleArea.transform;
		handleAreaRt.anchorMin = Vector2.zero;
		handleAreaRt.anchorMax = Vector2.one;
		handleAreaRt.offsetMin = new Vector2(10, 0);
		handleAreaRt.offsetMax = new Vector2(-10, 0);

		var handle = new GameObject("Handle", typeof(RectTransform), typeof(Image));
		handle.transform.SetParent(handleArea.transform, false);
		var handleRt = (RectTransform)handle.transform;
		handleRt.sizeDelta = new Vector2(20, 20);
		handle.GetComponent<Image>().color = Color.white;

		var slider = sliderGo.AddComponent<Slider>();
		slider.fillRect = fillRt;
		slider.handleRect = handleRt;
		slider.targetGraphic = handle.GetComponent<Image>();
		slider.direction = Slider.Direction.LeftToRight;
		slider.minValue = 0;
		slider.maxValue = 255;
		slider.wholeNumbers = true;
		slider.value = 128;
		return slider;
	}

	private void ChangePresetPage(int delta)
	{
		var totalPages = Mathf.CeilToInt(_colorPresets.Length / (float)PresetsPerPage);
		_presetPage = ((_presetPage + delta) % totalPages + totalPages) % totalPages;
		RefreshPresetPage();
	}

	private void RefreshPresetPage()
	{
		var totalPages = Mathf.CeilToInt(_colorPresets.Length / (float)PresetsPerPage);
		for (int i = 0; i < _presetSwatches.Count; i++)
			_presetSwatches[i].gameObject.SetActive(i / PresetsPerPage == _presetPage);
		if (_presetPageLabel != null) _presetPageLabel.text = $"Page {_presetPage + 1}/{totalPages}";
	}

	private void OnAppearanceClicked()
	{
		_showingAppearance = true;
		_pendingColor = ParseHexOrDefault(MpNetworkManager.GetNameColorHex(), Color.white);
		RefreshSwatchPreview();
		SyncSlidersToColor();
		if (_nameField != null) _nameField.text = PlayerPrefs.GetString("MpDisplayName", "");
	}

	private static void OnNameFieldChanged(string value)
	{
		PlayerPrefs.SetString("MpDisplayName", value.Trim());
		PlayerPrefs.Save();
	}

	public void TestOpenAppearance() => OnAppearanceClicked();

	private void OnAppearanceDoneClicked()
	{
		_showingAppearance = false;
	}

	private void OnSliderChanged()
	{
		Apply(new Color(_rSlider.value / 255f, _gSlider.value / 255f, _bSlider.value / 255f));
	}

	private void Apply(Color c)
	{
		_pendingColor = c;
		RefreshSwatchPreview();
		SyncSlidersToColor();
		var hex = ColorToHex(_pendingColor);
		MpNetworkManager.SetNameColorHex(hex);
		MpNetworkManager.SetDotColorHex(hex);
	}

	private void SyncSlidersToColor()
	{
		_rSlider.SetValueWithoutNotify(_pendingColor.r * 255f);
		_gSlider.SetValueWithoutNotify(_pendingColor.g * 255f);
		_bSlider.SetValueWithoutNotify(_pendingColor.b * 255f);
	}

	private void RefreshSwatchPreview()
	{
		ApplyRoundedBoxStyle(_colourSwatch, _pendingColor);
	}

	private static Color ParseHexOrDefault(string hex, Color fallback)
		=> !string.IsNullOrEmpty(hex) && ColorUtility.TryParseHtmlString(hex, out var c) ? c : fallback;

	private static string ColorToHex(Color c) => "#" + ColorUtility.ToHtmlStringRGB(c);

	private void BuildChatSection(Transform parent)
	{
		_chatBox = new GameObject("ChatBox", typeof(RectTransform));
		_chatBox.transform.SetParent(parent, false);
		var boxRt = (RectTransform)_chatBox.transform;
		boxRt.anchoredPosition = new Vector2(0, 15);
		boxRt.sizeDelta = new Vector2(600, 200);
		var boxImg = _chatBox.AddComponent<Image>();
		ApplyRoundedBoxStyle(boxImg, Color.white);
		_chatBox.AddComponent<RectMask2D>();

		var chatLogGo = new GameObject("ChatLog", typeof(RectTransform));
		chatLogGo.transform.SetParent(_chatBox.transform, false);
		var chatLogRt = (RectTransform)chatLogGo.transform;
		chatLogRt.anchorMin = new Vector2(0.5f, 0.5f);
		chatLogRt.anchorMax = new Vector2(0.5f, 0.5f);
		chatLogRt.pivot = new Vector2(0.5f, 1f);
		chatLogRt.anchoredPosition = new Vector2(0, 90);
		chatLogRt.sizeDelta = new Vector2(560, 180);
		_chatLogContainer = chatLogGo.transform;

		_chatInputField = CreateInputField(parent, new Vector2(-150, -115), new Vector2(260, 44), "Say something...");
		var sendGo = CloneButton(parent, "Send", new Vector2(140, -115), new Vector2(280, 60));
		sendGo.GetComponent<Button>().onClick.AddListener(OnSendChatClicked);
		_chatInputField.onSubmit.AddListener(_ => OnSendChatClicked());
	}

	private void BuildListBox(Transform root)
	{
		_listBox = new GameObject("LobbyListBox", typeof(RectTransform));
		_listBox.transform.SetParent(root, false);
		var boxRt = (RectTransform)_listBox.transform;
		boxRt.anchoredPosition = new Vector2(0, -22);
		boxRt.sizeDelta = new Vector2(600, 170);
		var boxImg = _listBox.AddComponent<Image>();
		ApplyRoundedBoxStyle(boxImg, Color.white);

		var header = CreateLabel(_listBox.transform, "ListHeader", new Vector2(-90, 70), new Vector2(380, 26), "Open lobbies");
		header.fontSize = 20;
		header.color = new Color(1f, 1f, 1f, 0.65f);
		header.alignment = TextAlignmentOptions.MidlineLeft;

		var refreshGo = CloneButton(_listBox.transform, "Refresh", new Vector2(235, 70), new Vector2(130, 32), "Refresh");
		var refreshLabel = refreshGo.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (refreshLabel != null) refreshLabel.fontSize = 18f;
		var refreshButton = refreshGo.GetComponent<Button>();
		refreshButton.navigation = new Navigation { mode = Navigation.Mode.None };
		refreshButton.onClick.AddListener(() => MpNetworkManager.GetOrCreate().RequestLobbyList());

		_listContent = new GameObject("LobbyListContent", typeof(RectTransform));
		_listContent.transform.SetParent(_listBox.transform, false);

		var prevGo = CloneButton(_listBox.transform, "PrevPage", new Vector2(-230, -68), new Vector2(100, 30), "< Prev");
		_prevPageButton = prevGo.GetComponent<Button>();
		_prevPageButton.navigation = new Navigation { mode = Navigation.Mode.None };
		_prevPageButton.onClick.AddListener(() => { _lobbyPageIndex--; RefreshLobbyList(MpNetworkManager.GetOrCreate().LastLobbyList); });
		var prevLabel = prevGo.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (prevLabel != null) prevLabel.fontSize = 16f;

		_pageLabel = CreateLabel(_listBox.transform, "PageLabel", new Vector2(0, -68), new Vector2(160, 28), "");
		_pageLabel.fontSize = 18;
		_pageLabel.color = new Color(1f, 1f, 1f, 0.6f);

		var nextGo = CloneButton(_listBox.transform, "NextPage", new Vector2(230, -68), new Vector2(100, 30), "Next >");
		_nextPageButton = nextGo.GetComponent<Button>();
		_nextPageButton.navigation = new Navigation { mode = Navigation.Mode.None };
		_nextPageButton.onClick.AddListener(() => { _lobbyPageIndex++; RefreshLobbyList(MpNetworkManager.GetOrCreate().LastLobbyList); });
		var nextLabel = nextGo.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (nextLabel != null) nextLabel.fontSize = 16f;
	}

	private static Sprite _cachedBoxSprite;
	private static bool _lookedForBoxSprite;

	private static Sprite FindBoxSprite()
	{
		if (_lookedForBoxSprite) return _cachedBoxSprite;
		_lookedForBoxSprite = true;
		var linkButtons = Object.FindObjectsByType<LinkOpener>(FindObjectsInactive.Include, FindObjectsSortMode.None);
		foreach (var lb in linkButtons)
		{
			var t = lb.transform.parent;
			while (t != null)
			{
				var bg = t.GetComponent<Image>();
				if (bg != null && bg.sprite != null) { _cachedBoxSprite = bg.sprite; return _cachedBoxSprite; }
				t = t.parent;
			}
		}
		return _cachedBoxSprite;
	}

	private void ApplyRoundedBoxStyle(Image img, Color tint)
	{
		var sprite = FindBoxSprite();
		if (sprite != null)
		{
			img.sprite = sprite;
			img.type = Image.Type.Sliced;
			img.pixelsPerUnitMultiplier = 2.2f;
		}
		img.color = tint;
	}

	private void BuildDirectConnectSection(Transform root)
	{
		_directConnectSection = new GameObject("DirectConnectSection", typeof(RectTransform));
		_directConnectSection.transform.SetParent(root, false);

		var header = CreateLabel(_directConnectSection.transform, "DirectConnectHeader", new Vector2(0, -128), new Vector2(560, 26), "Direct Connect");
		header.fontSize = 20;
		header.color = new Color(1f, 1f, 1f, 0.65f);

		_hostField = CreateInputField(_directConnectSection.transform, new Vector2(-90, -160), new Vector2(380, 44), "Server IP");
		_portField = CreateInputField(_directConnectSection.transform, new Vector2(200, -160), new Vector2(160, 44), "Port");
	}

	private void BuildMapPickerSection(Transform root)
	{
		_mapPickerSection = new GameObject("MapPickerSection", typeof(RectTransform));
		_mapPickerSection.transform.SetParent(root, false);

		var header = CreateLabel(_mapPickerSection.transform, "MapPickerHeader", new Vector2(0, 165), new Vector2(400, 34), "Choose a Map");
		header.alignment = TextAlignmentOptions.Center;
		header.fontSize = 22;

		var cancelGo = CloneButton(_mapPickerSection.transform, "CancelMapPicker", new Vector2(0, -195), new Vector2(280, 60), "Cancel");
		cancelGo.GetComponent<Button>().onClick.AddListener(() => _showingMapPicker = false);

		_mapPickerSection.SetActive(false);
	}

	private void RefreshMapPickerRows()
	{
		foreach (var row in _mapPickerRows) Object.Destroy(row);
		_mapPickerRows.Clear();

		float y = 120f;
		const float rowSpacing = 56f;

		_mapPickerRows.Add(CreateMapPickerRow(new Vector2(0, y), "Base Game", -1));
		y -= rowSpacing;

		_mapPickerRows.Add(CreateMapPickerRow(new Vector2(0, y), "B-Side", -2));
		y -= rowSpacing;

		for (int i = 0; i < _hostableMaps.Count; i++)
		{
			_mapPickerRows.Add(CreateMapPickerRow(new Vector2(0, y), _hostableMaps[i].Name, i));
			y -= rowSpacing;
		}
	}

	private GameObject CreateMapPickerRow(Vector2 pos, string label, int mapIndex)
	{
		var go = CloneButton(_mapPickerSection.transform, "MapRow", pos, new Vector2(400, 48), label);
		go.GetComponent<Button>().onClick.AddListener(() => FinalizeHost(mapIndex));
		return go;
	}

	private void OnEnable()
	{
		_refreshAccumulator = 999f;
		_lobbyListPollAccumulator = 999f;
		RefreshMapPicker();
	}

	private void RefreshMapPicker()
	{
		if (_mapListLoading) return;
		_mapListLoading = true;
		new Thread(() =>
		{
			try { _hostableMaps = MpMapLibrary.GetHostableMaps(); }
			finally { _mapListLoading = false; }
		})
		{ IsBackground = true }.Start();
	}

	private void OnConnectClicked()
	{
		var mgr = MpNetworkManager.GetOrCreate();
		if (mgr.IsConnected) { mgr.Disconnect(); return; }
		if (!int.TryParse(_portField.text, out var port)) port = 443;
		var host = string.IsNullOrEmpty(_hostField.text) ? "codecade.co.za" : _hostField.text;
		mgr.ConnectAsync(host, port);
	}

	private void OnHostButtonClicked()
	{
		_showingMapPicker = true;
		RefreshMapPickerRows();
	}

	private void FinalizeHost(int mapIndex)
	{
		var name = _lobbyNameField.text;
		if (mapIndex >= 0 && mapIndex < _hostableMaps.Count)
		{
			var map = _hostableMaps[mapIndex];
			MpNetworkManager.GetOrCreate().HostLobby(name, map.LocalId, map.HubId, map.Name, false);
		}
		else
		{
			bool hard = mapIndex == -2;
			var mgr = MpNetworkManager.GetOrCreate();
			mgr.PendingBaseGameHard = hard;
			mgr.PendingHostMapKind = hard ? "bside" : "base";
			mgr.HostLobby(name, null, null, null, hard);
		}
		_showingMapPicker = false;
	}

	private void OnLeaveClicked()
	{
		if (!_leaveConfirmArmed)
		{
			_leaveConfirmArmed = true;
			_leaveConfirmArmedAt = Time.unscaledTime;
			if (_leaveLabel != null) _leaveLabel.text = "Click again to confirm";
			return;
		}
		_leaveConfirmArmed = false;
		if (_leaveLabel != null) _leaveLabel.text = "Leave Lobby";
		MpNetworkManager.GetOrCreate().LeaveLobby();
	}

	private void OnSendChatClicked()
	{
		if (_chatInputField == null || string.IsNullOrWhiteSpace(_chatInputField.text)) return;
		MpNetworkManager.GetOrCreate().SendChat(_chatInputField.text);
		_chatInputField.text = "";
		_chatInputField.ActivateInputField();
	}

	private void Update()
	{
		var mgr = MpNetworkManager.GetOrCreate();
		bool connected = mgr.IsConnected;
		bool inLobby = mgr.InLobby;

		if (_leaveConfirmArmed && Time.unscaledTime - _leaveConfirmArmedAt >= LeaveConfirmTimeout)
		{
			_leaveConfirmArmed = false;
			if (_leaveLabel != null) _leaveLabel.text = "Leave Lobby";
		}

		if (connected && !inLobby)
		{
			_lobbyListPollAccumulator += Time.unscaledDeltaTime;
			if (_lobbyListPollAccumulator >= 1.5f)
			{
				_lobbyListPollAccumulator = 0f;
				mgr.RequestLobbyList();
			}
		}

		_refreshAccumulator += Time.unscaledDeltaTime;
		if (_refreshAccumulator < 0.2f) return;
		_refreshAccumulator = 0f;

		bool showingOverlay = _showingAppearance || _showingMapPicker;
		_status.gameObject.SetActive(!inLobby && !showingOverlay);
		_status.text = mgr.StatusText;
		_connectButtonLabel.text = connected ? "Disconnect" : "Connect";
		_connectButton.gameObject.SetActive(!inLobby && !showingOverlay);
		_appearanceButton.SetActive(!inLobby && !showingOverlay);

		_appearanceSection.SetActive(_showingAppearance);
		_mapPickerSection.SetActive(_showingMapPicker);
		if (showingOverlay)
		{
			_hostRow.SetActive(false);
			_listBox.SetActive(false);
			_directConnectSection.SetActive(false);
			_inLobbyRow.SetActive(false);
			return;
		}

		_hostRow.SetActive(!inLobby);
		_listBox.SetActive(!inLobby);
		_directConnectSection.SetActive(!inLobby);
		_inLobbyRow.SetActive(inLobby);
		if (inLobby)
		{
			_inLobbyLabel.text = "In lobby: " + mgr.CurrentLobbyName;
			RefreshPlayersLabel(mgr.LastSnapshotPlayers);
			RefreshChatLog(mgr.ChatLines);
		}

		if (connected && !inLobby) RefreshLobbyList(mgr.LastLobbyList);
	}

	private void RefreshPlayersLabel(List<MpPlayerState> others)
	{
		var selfHex = MpNetworkManager.GetNameColorHex();
		var selfName = MpNetworkManager.SanitizeForRichText(MpNetworkManager.GetDisplayName());
		var sb = new System.Text.StringBuilder("Players: <color=").Append(selfHex).Append('>').Append(selfName).Append("</color>");
		foreach (var p in others)
		{
			var hexRe = !string.IsNullOrEmpty(p.nameColor) && p.nameColor.Length == 7 && p.nameColor[0] == '#' ? p.nameColor : "#FFFFFF";
			var safeName = MpNetworkManager.SanitizeForRichText(p.name);
			sb.Append(", <color=").Append(hexRe).Append('>').Append(safeName).Append("</color>");
			if (p.isPaused) sb.Append(" (paused)");
		}
		_playersLabel.text = sb.ToString();
	}

	private TMP_Text _chatMeasurer;

	private float MeasureChatLineHeight(string text, float width)
	{
		if (_chatMeasurer == null)
		{
			var go = new GameObject("ChatMeasurer", typeof(RectTransform));
			go.transform.SetParent(_chatBox.transform, false);
			_chatMeasurer = go.AddComponent<TextMeshProUGUI>();
			_chatMeasurer.font = _font;
			_chatMeasurer.fontSize = 18;
			_chatMeasurer.enableWordWrapping = true;
			go.SetActive(false);
		}
		return _chatMeasurer.GetPreferredValues(text, width, 0f).y;
	}

	private void RefreshChatLog(List<string> chatLines)
	{
		if (chatLines.Count == _lastChatLineCount) return;
		_lastChatLineCount = chatLines.Count;

		foreach (var row in _chatLogRows) Object.Destroy(row);
		_chatLogRows.Clear();
		if (chatLines.Count == 0) return;

		const float containerWidth = 560f;
		const float containerHeight = 178f;

		var kept = new List<(string line, float height)>();
		float used = 0f;
		for (int i = chatLines.Count - 1; i >= 0; i--)
		{
			var line = chatLines[i];
			var height = MeasureChatLineHeight(line, containerWidth);
			if (used + height > containerHeight && kept.Count > 0) break;
			kept.Insert(0, (line, height));
			used += height;
		}

		float y = 0f;
		foreach (var (line, height) in kept)
		{
			var rowGo = new GameObject("ChatLine", typeof(RectTransform));
			rowGo.transform.SetParent(_chatLogContainer, false);
			var rowRt = (RectTransform)rowGo.transform;
			rowRt.anchorMin = new Vector2(0, 1);
			rowRt.anchorMax = new Vector2(1, 1);
			rowRt.pivot = new Vector2(0.5f, 1f);
			rowRt.anchoredPosition = new Vector2(0, -y);
			rowRt.sizeDelta = new Vector2(0, height);

			var tmp = rowGo.AddComponent<TextMeshProUGUI>();
			tmp.font = _font;
			tmp.fontSize = 18;
			tmp.alignment = TextAlignmentOptions.TopLeft;
			tmp.enableWordWrapping = true;
			tmp.color = new Color(1f, 1f, 1f, 0.9f);
			tmp.text = line;

			y += height;
			_chatLogRows.Add(rowGo);
		}
	}

	private void RefreshLobbyList(List<MpLobbyInfo> lobbies)
	{
		lobbies ??= new List<MpLobbyInfo>();
		int pageCount = Mathf.Max(1, Mathf.CeilToInt(lobbies.Count / (float)LobbyPageSize));
		_lobbyPageIndex = Mathf.Clamp(_lobbyPageIndex, 0, pageCount - 1);

		if (lobbies == _lastRenderedLobbies && _lobbyPageIndex == _lastRenderedPageIndex) return;
		_lastRenderedLobbies = lobbies;
		_lastRenderedPageIndex = _lobbyPageIndex;

		if (EventSystem.current != null)
		{
			var selected = EventSystem.current.currentSelectedGameObject;
			if (selected != null && selected.transform.IsChildOf(_listContent.transform))
				EventSystem.current.SetSelectedGameObject(null);
		}

		foreach (var row in _lobbyListRows) Object.Destroy(row);
		_lobbyListRows.Clear();

		bool needsPaging = lobbies.Count > LobbyPageSize;
		_prevPageButton.gameObject.SetActive(needsPaging);
		_nextPageButton.gameObject.SetActive(needsPaging);
		_pageLabel.gameObject.SetActive(needsPaging);
		_prevPageButton.interactable = _lobbyPageIndex > 0;
		_nextPageButton.interactable = _lobbyPageIndex < pageCount - 1;
		_pageLabel.text = $"{_lobbyPageIndex + 1}/{pageCount}";

		if (lobbies.Count == 0)
		{
			var emptyGo = CreateLabel(_listContent.transform, "EmptyLabel", new Vector2(0, 4), new Vector2(500, 30), "(no open lobbies yet)").gameObject;
			emptyGo.GetComponent<TMP_Text>().color = new Color(1f, 1f, 1f, 0.5f);
			_lobbyListRows.Add(emptyGo);
			return;
		}

		var start = _lobbyPageIndex * LobbyPageSize;
		var end = Mathf.Min(start + LobbyPageSize, lobbies.Count);
		float y = 28f;
		const float rowSpacing = 48f;
		for (int i = start; i < end; i++)
		{
			var lobby = lobbies[i];
			int capturedId = lobby.id;
			var rowGo = CreateLobbyRow(_listContent.transform, new Vector2(0, y), new Vector2(560, 44), lobby.name, lobby.count, lobby.hostColor);
			rowGo.GetComponent<Button>().onClick.AddListener(() => MpNetworkManager.GetOrCreate().JoinLobby(capturedId));
			_lobbyListRows.Add(rowGo);

			if (i < end - 1)
				_lobbyListRows.Add(CreateDivider(_listContent.transform, new Vector2(0, y - rowSpacing / 2f)));

			y -= rowSpacing;
		}
	}

	private GameObject CreateDivider(Transform parent, Vector2 anchoredPos, float width = 560)
	{
		var go = new GameObject("Divider", typeof(RectTransform));
		go.transform.SetParent(parent, false);
		var rt = (RectTransform)go.transform;
		rt.anchoredPosition = anchoredPos;
		rt.sizeDelta = new Vector2(width, 2);
		var img = go.AddComponent<Image>();
		img.color = new Color(1f, 1f, 1f, 0.15f);
		return go;
	}

	private GameObject CreateLobbyRow(Transform parent, Vector2 anchoredPos, Vector2 size, string lobbyName, int playerCount, string hostColorHex)
	{
		var go = Object.Instantiate(_buttonTemplate, parent);
		go.name = "LobbyRow";
		go.SetActive(true);
		var rt = (RectTransform)go.transform;
		rt.anchoredPosition = anchoredPos;
		rt.sizeDelta = size;

		var baseImg = go.GetComponent<Image>();
		if (baseImg != null) baseImg.color = new Color(0f, 0f, 0f, 0f);

		var font = _font;
		var textColor = new Color(1f, 0.55f, 0.15f, 1f);
		var nameColor = ParseHexOrDefault(hostColorHex, textColor);
		var label = go.transform.Find("Text (TMP)");
		if (label != null)
		{
			var existingTmp = label.GetComponent<TMP_Text>();
			if (existingTmp != null) font = existingTmp.font;
			Object.Destroy(label.gameObject);
		}

		var nameGo = new GameObject("NameLabel", typeof(RectTransform));
		nameGo.transform.SetParent(go.transform, false);
		var nameRt = (RectTransform)nameGo.transform;
		nameRt.anchorMin = Vector2.zero;
		nameRt.anchorMax = Vector2.one;
		nameRt.offsetMin = new Vector2(20f, 0f);
		nameRt.offsetMax = new Vector2(-140f, 0f);
		var nameTmp = nameGo.AddComponent<TextMeshProUGUI>();
		nameTmp.font = font;
		nameTmp.color = nameColor;
		nameTmp.enableAutoSizing = true;
		nameTmp.fontSizeMax = 24f;
		nameTmp.fontSizeMin = 12f;
		nameTmp.enableWordWrapping = false;
		nameTmp.alignment = TextAlignmentOptions.MidlineLeft;
		nameTmp.text = lobbyName;

		var countGo = new GameObject("CountLabel", typeof(RectTransform));
		countGo.transform.SetParent(go.transform, false);
		var countRt = (RectTransform)countGo.transform;
		countRt.anchorMin = Vector2.zero;
		countRt.anchorMax = Vector2.one;
		countRt.offsetMin = new Vector2(size.x - 130f, 0f);
		countRt.offsetMax = new Vector2(-16f, 0f);
		var countTmp = countGo.AddComponent<TextMeshProUGUI>();
		countTmp.font = font;
		countTmp.color = textColor;
		countTmp.enableAutoSizing = true;
		countTmp.fontSizeMax = 24f;
		countTmp.fontSizeMin = 12f;
		countTmp.enableWordWrapping = false;
		countTmp.alignment = TextAlignmentOptions.MidlineRight;
		countTmp.text = $"{playerCount} player{(playerCount == 1 ? "" : "s")}";

		var highlightGo = new GameObject("Highlight", typeof(RectTransform));
		highlightGo.transform.SetParent(go.transform, false);
		highlightGo.transform.SetAsFirstSibling();
		var highlightRt = (RectTransform)highlightGo.transform;
		highlightRt.anchorMin = Vector2.zero;
		highlightRt.anchorMax = Vector2.one;
		highlightRt.offsetMin = Vector2.zero;
		highlightRt.offsetMax = Vector2.zero;
		var highlightImg = highlightGo.AddComponent<Image>();
		highlightImg.color = new Color(0f, 0f, 0f, 0f);
		highlightImg.raycastTarget = false;

		var trigger = go.AddComponent<EventTrigger>();
		var enterEntry = new EventTrigger.Entry { eventID = EventTriggerType.PointerEnter };
		enterEntry.callback.AddListener(_ => highlightImg.color = new Color(0f, 0f, 0f, 0.25f));
		trigger.triggers.Add(enterEntry);
		var exitEntry = new EventTrigger.Entry { eventID = EventTriggerType.PointerExit };
		exitEntry.callback.AddListener(_ => highlightImg.color = new Color(0f, 0f, 0f, 0f));
		trigger.triggers.Add(exitEntry);

		var button = go.GetComponent<Button>();
		button.onClick = new Button.ButtonClickedEvent();
		button.navigation = new Navigation { mode = Navigation.Mode.None };
		return go;
	}

	private GameObject CloneButton(Transform parent, string name, Vector2 anchoredPos, Vector2 size, string labelOverride = null)
	{
		var go = Object.Instantiate(_buttonTemplate, parent);
		go.name = name;
		go.SetActive(true);
		var rt = (RectTransform)go.transform;
		rt.anchoredPosition = anchoredPos;
		rt.sizeDelta = size;

		var label = go.transform.Find("Text (TMP)");
		if (label != null)
		{
			var loc = label.GetComponent<UnityEngine.Localization.Components.LocalizeStringEvent>();
			if (loc != null) Object.DestroyImmediate(loc);

			var labelRt = (RectTransform)label;
			const float extraInset = 6f;
			labelRt.offsetMin = new Vector2(labelRt.offsetMin.x + extraInset, labelRt.offsetMin.y);
			labelRt.offsetMax = new Vector2(labelRt.offsetMax.x - extraInset, labelRt.offsetMax.y);

			var tmp = label.GetComponent<TMP_Text>();
			if (tmp != null)
			{
				tmp.text = labelOverride ?? name;
				tmp.enableAutoSizing = false;
				tmp.fontSize = 24f;
				tmp.enableWordWrapping = false;
			}
		}

		var button = go.GetComponent<Button>();
		button.onClick = new Button.ButtonClickedEvent();
		return go;
	}

	private TMP_Text CreateLabel(Transform parent, string name, Vector2 anchoredPos, Vector2 size, string text)
	{
		var go = new GameObject(name, typeof(RectTransform));
		go.transform.SetParent(parent, false);
		var rt = (RectTransform)go.transform;
		rt.anchoredPosition = anchoredPos;
		rt.sizeDelta = size;
		var tmp = go.AddComponent<TextMeshProUGUI>();
		tmp.font = _font;
		tmp.fontSize = 24;
		tmp.alignment = TextAlignmentOptions.Center;
		tmp.color = Color.white;
		tmp.text = text;
		return tmp;
	}

	private TMP_InputField CreateInputField(Transform parent, Vector2 anchoredPos, Vector2 size, string placeholder)
	{
		var go = new GameObject("InputField", typeof(RectTransform));
		go.transform.SetParent(parent, false);
		var rt = (RectTransform)go.transform;
		rt.anchoredPosition = anchoredPos;
		rt.sizeDelta = size;
		var bg = go.AddComponent<Image>();
		ApplyRoundedBoxStyle(bg, Color.white);

		var textArea = new GameObject("Text Area", typeof(RectTransform));
		textArea.transform.SetParent(go.transform, false);
		var textAreaRt = (RectTransform)textArea.transform;
		textAreaRt.anchorMin = Vector2.zero;
		textAreaRt.anchorMax = Vector2.one;
		textAreaRt.offsetMin = new Vector2(16, 4);
		textAreaRt.offsetMax = new Vector2(-12, -4);
		textArea.AddComponent<RectMask2D>();

		var textGo = new GameObject("Text", typeof(RectTransform));
		textGo.transform.SetParent(textArea.transform, false);
		var textRt = (RectTransform)textGo.transform;
		textRt.anchorMin = Vector2.zero;
		textRt.anchorMax = Vector2.one;
		textRt.offsetMin = Vector2.zero;
		textRt.offsetMax = Vector2.zero;
		var text = textGo.AddComponent<TextMeshProUGUI>();
		text.font = _font;
		text.fontSize = 22;
		text.color = Color.white;
		text.alignment = TextAlignmentOptions.MidlineLeft;
		text.enableWordWrapping = false;

		var placeholderGo = new GameObject("Placeholder", typeof(RectTransform));
		placeholderGo.transform.SetParent(textArea.transform, false);
		var placeholderRt = (RectTransform)placeholderGo.transform;
		placeholderRt.anchorMin = Vector2.zero;
		placeholderRt.anchorMax = Vector2.one;
		placeholderRt.offsetMin = Vector2.zero;
		placeholderRt.offsetMax = Vector2.zero;
		var placeholderText = placeholderGo.AddComponent<TextMeshProUGUI>();
		placeholderText.font = _font;
		placeholderText.fontSize = 22;
		placeholderText.color = new Color(1f, 1f, 1f, 0.4f);
		placeholderText.text = placeholder;
		placeholderText.fontStyle = FontStyles.Italic;
		placeholderText.alignment = TextAlignmentOptions.MidlineLeft;

		var input = go.AddComponent<TMP_InputField>();
		input.textViewport = textAreaRt;
		input.textComponent = text;
		input.placeholder = placeholderText;
		input.text = "";
		return input;
	}
}

internal static class MpMenuBuilder
{
	public static void Install(pauseMenuScript menu)
	{
		MpNetworkManager.GetOrCreate();

		if (menu.mainBitPublic == null || menu.settingsBitPublic == null) return;

		var mpPanel = BuildPanel(menu, backTarget: menu.mainBitPublic);
		PauseMenuHelper.AddRow(menu, "Multiplayer", "DOTnet", () => mpPanel.SetActive(true));

		MpNetworkManager.LatestMainBit = menu.mainBitPublic;
		MpNetworkManager.LatestMpPanel = mpPanel;
	}

	private static void SetButtonLabel(GameObject buttonGo, string text)
	{
		var label = buttonGo.transform.Find("Text (TMP)");
		if (label == null) return;
		var loc = label.GetComponent<UnityEngine.Localization.Components.LocalizeStringEvent>();
		if (loc != null) Object.DestroyImmediate(loc);
		var tmp = label.GetComponent<TMP_Text>();
		if (tmp != null) tmp.text = text;
	}

	private static GameObject BuildPanel(pauseMenuScript menu, GameObject backTarget)
	{
		var existing = menu.settingsBitPublic.transform.parent.Find("MultiplayerBit");
		if (existing != null) return existing.gameObject;

		var clone = Object.Instantiate(menu.settingsBitPublic, menu.settingsBitPublic.transform.parent);
		clone.name = "MultiplayerBit";
		clone.SetActive(false);

		var settingsScript = clone.GetComponent<SettingsScript>();
		if (settingsScript != null) Object.Destroy(settingsScript);

		Transform title = null;
		var toDestroy = new List<GameObject>();
		foreach (Transform child in clone.transform)
		{
			if (child.name == "Settings") { title = child; continue; }
			toDestroy.Add(child.gameObject);
		}
		foreach (var go in toDestroy) Object.Destroy(go);

		TMP_FontAsset font = null;
		if (title != null)
		{
			var titleTmp = title.GetComponent<TMP_Text>();
			if (titleTmp != null) { titleTmp.text = "DOTnet"; font = titleTmp.font; }
			var loc = title.GetComponent<UnityEngine.Localization.Components.LocalizeStringEvent>();
			if (loc != null) Object.DestroyImmediate(loc);

			var closeBtn = title.Find("Close");
			if (closeBtn != null)
			{
				SetButtonLabel(closeBtn.gameObject, "Back");
				var btn = closeBtn.GetComponent<Button>();
				btn.onClick = new Button.ButtonClickedEvent();
				btn.onClick.AddListener(() =>
				{
					clone.SetActive(false);
					backTarget.SetActive(true);
				});
			}
		}

		var ui = clone.AddComponent<MpPanelUI>();
		ui.Build(clone, font, settingsButtonTemplate: menu.mainBitPublic.transform.Find("Settings").gameObject, menu);
		return clone;
	}
}

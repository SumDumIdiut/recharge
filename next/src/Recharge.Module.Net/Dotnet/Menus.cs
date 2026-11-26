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

	private static readonly System.Reflection.FieldInfo MoveActionField = Reflect.FieldOf<Movement>("moveAction");
	private static readonly System.Reflection.FieldInfo JumpActionField = Reflect.FieldOf<Movement>("jumpAction");
	private static readonly System.Reflection.FieldInfo DashActionField = Reflect.FieldOf<Movement>("dashAction");
	private static readonly System.Reflection.FieldInfo ResetActionField = Reflect.FieldOf<Movement>("resetAction");

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
		logRt.anchorMin = new Vector2(1, 0);
		logRt.anchorMax = new Vector2(1, 0);
		logRt.pivot = new Vector2(1, 0);
		logRt.anchoredPosition = new Vector2(-20, 60);
		logRt.sizeDelta = new Vector2(460, 150);
		logGo.GetComponent<Image>().color = new Color(0f, 0f, 0f, 0.45f);
		logGo.AddComponent<RectMask2D>();
		_logGroup = logGo.GetComponent<CanvasGroup>();
		_logGroup.alpha = 0f;
		_logGroup.blocksRaycasts = false;
		_logGroup.interactable = false;

		var logRowsGo = PanelWidgets.CreateContainer(logGo.transform, "LogRows", Vector2.zero).gameObject;
		var logRowsRt = (RectTransform)logRowsGo.transform;
		logRowsRt.anchorMin = Vector2.zero;
		logRowsRt.anchorMax = Vector2.one;
		logRowsRt.offsetMin = new Vector2(10, 8);
		logRowsRt.offsetMax = new Vector2(-10, -8);
		_logRowsContainer = logRowsGo.transform;

		_inputRow = new GameObject("ChatInputRow", typeof(RectTransform), typeof(Image));
		_inputRow.transform.SetParent(canvasGo.transform, false);
		var inputRt = (RectTransform)_inputRow.transform;
		inputRt.anchorMin = new Vector2(1, 0);
		inputRt.anchorMax = new Vector2(1, 0);
		inputRt.pivot = new Vector2(1, 0);
		inputRt.anchoredPosition = new Vector2(-20, 20);
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

		var textGo = PanelWidgets.CreateContainer(textArea.transform, "Text", Vector2.zero).gameObject;
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

		var placeholderGo = PanelWidgets.CreateContainer(textArea.transform, "Placeholder", Vector2.zero).gameObject;
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
	private Image _connectDot;
	private GameObject _hostButton;
	private GameObject _refreshButton;
	private bool _autoConnectTried;
	private bool _wasConnected;

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

	public void Build(GameObject panel, TMP_FontAsset font, GameObject settingsButtonTemplate, pauseMenuScript menu)
	{
		_font = font;
		_buttonTemplate = settingsButtonTemplate;
		var root = panel.transform;

		// Escape backs out of the open map-picker overlay first (same as its
		// own Cancel button), and only closes the whole panel once it is gone.
		var closer = panel.GetComponent<Recharge.ModApi.PanelEscapeCloser>();
		if (closer != null)
		{
			closer.ConsumeEscapeFirst = () =>
			{
				if (_showingMapPicker) { _showingMapPicker = false; return true; }
				return false;
			};
		}

		PanelWidgets.CreateDivider(root, new Vector2(-140, 188), 300);

		_connectDot = CreateConnectDot(root, new Vector2(300, 196), 16f);

		_hostButton = CloneButton(root, "Host", new Vector2(238, 150), new Vector2(150, 44), "Host");
		_hostButton.GetComponent<Button>().onClick.AddListener(OnHostButtonClicked);

		BuildListBox(root);
		BuildMapPickerSection(root);

		_inLobbyRow = PanelWidgets.CreateContainer(root, "InLobbyRow", Vector2.zero).gameObject;
		_inLobbyLabel = PanelWidgets.CreateLabel(_inLobbyRow.transform, _font, new Vector2(0, 160), new Vector2(560, 34), "");
		_playersLabel = PanelWidgets.CreateLabel(_inLobbyRow.transform, _font, new Vector2(0, 133), new Vector2(560, 24), "");
		_playersLabel.fontSize = 16;
		_playersLabel.enableWordWrapping = false;
		_playersLabel.overflowMode = TextOverflowModes.Ellipsis;
		_playersLabel.color = new Color(1f, 1f, 1f, 0.75f);

		BuildChatSection(_inLobbyRow.transform);
		var leaveGo = CloneButton(_inLobbyRow.transform, "Leave Lobby", new Vector2(-150, -160), new Vector2(270, 60));
		_leaveLabel = leaveGo.GetComponentInChildren<TMP_Text>();
		leaveGo.GetComponent<Button>().onClick.AddListener(OnLeaveClicked);

		MpNetworkManager.LatestInLobbyRow = _inLobbyRow;

		// Keep the panel's Back button drawn above the lobby content: raise its
		// top-level ancestor (the title bar) to the last sibling so the content
		// boxes added above never cover it.
		if (closer != null && closer.CloseButton != null)
		{
			var top = closer.CloseButton.transform;
			while (top.parent != null && top.parent != root) top = top.parent;
			if (top.parent == root) top.SetAsLastSibling();

			// Match the Host/Refresh buttons to the Back button's orange.
			var backLabel = closer.CloseButton.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
			if (backLabel != null)
			{
				Color c = backLabel.color;
				// A cloned button can report white in .color with the real
				// colour carried in faceColor instead.
				if (c.r > 0.95f && c.g > 0.95f && c.b > 0.95f) c = backLabel.faceColor;
				ApplyLabelColor(_hostButton, c);
				ApplyLabelColor(_refreshButton, c);
			}
		}
	}

	private static void ApplyLabelColor(GameObject buttonGo, Color color)
	{
		if (buttonGo == null) return;
		var tmp = buttonGo.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (tmp == null) return;
		tmp.enableVertexGradient = false;
		tmp.color = color;
		tmp.faceColor = color;
	}

	private void BuildChatSection(Transform parent)
	{
		_chatBox = PanelWidgets.CreateContainer(parent, "ChatBox", Vector2.zero).gameObject;
		var boxRt = (RectTransform)_chatBox.transform;
		boxRt.anchoredPosition = new Vector2(0, 15);
		boxRt.sizeDelta = new Vector2(600, 200);
		var boxImg = _chatBox.AddComponent<Image>();
		ApplyRoundedBoxStyle(boxImg, Color.white);
		_chatBox.AddComponent<RectMask2D>();

		var chatLogGo = PanelWidgets.CreateContainer(_chatBox.transform, "ChatLog", Vector2.zero).gameObject;
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
		_listBox = PanelWidgets.CreateContainer(root, "LobbyListBox", Vector2.zero).gameObject;
		var boxRt = (RectTransform)_listBox.transform;
		boxRt.anchoredPosition = new Vector2(0, -40);
		boxRt.sizeDelta = new Vector2(640, 320);
		var boxImg = _listBox.AddComponent<Image>();
		ApplyRoundedBoxStyle(boxImg, Color.white);

		var header = PanelWidgets.CreateLabel(_listBox.transform, _font, new Vector2(-160, 140), new Vector2(300, 26), "Open lobbies");
		header.fontSize = 20;
		header.color = new Color(1f, 1f, 1f, 0.65f);
		header.alignment = TextAlignmentOptions.MidlineLeft;

		var refreshGo = CloneButton(_listBox.transform, "Refresh", new Vector2(235, 140), new Vector2(130, 32), "Refresh");
		_refreshButton = refreshGo;
		var refreshLabel = refreshGo.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (refreshLabel != null) refreshLabel.fontSize = 18f;
		var refreshButton = refreshGo.GetComponent<Button>();
		refreshButton.navigation = new Navigation { mode = Navigation.Mode.None };
		refreshButton.onClick.AddListener(() => MpNetworkManager.GetOrCreate().RequestLobbyList());

		_listContent = PanelWidgets.CreateContainer(_listBox.transform, "LobbyListContent", Vector2.zero).gameObject;

		var prevGo = CloneButton(_listBox.transform, "PrevPage", new Vector2(-230, -140), new Vector2(100, 30), "< Prev");
		_prevPageButton = prevGo.GetComponent<Button>();
		_prevPageButton.navigation = new Navigation { mode = Navigation.Mode.None };
		_prevPageButton.onClick.AddListener(() => { _lobbyPageIndex--; RefreshLobbyList(MpNetworkManager.GetOrCreate().LastLobbyList); });
		var prevLabel = prevGo.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (prevLabel != null) prevLabel.fontSize = 16f;

		_pageLabel = PanelWidgets.CreateLabel(_listBox.transform, _font, new Vector2(0, -140), new Vector2(160, 28), "");
		_pageLabel.fontSize = 18;
		_pageLabel.color = new Color(1f, 1f, 1f, 0.6f);

		var nextGo = CloneButton(_listBox.transform, "NextPage", new Vector2(230, -140), new Vector2(100, 30), "Next >");
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

	// A small rounded square in a panel corner that reads as a status dot:
	// green when connected to the relay, red when not.
	private Image CreateConnectDot(Transform parent, Vector2 anchoredPos, float diameter)
	{
		var go = PanelWidgets.CreateContainer(parent, "ConnectDot", Vector2.zero).gameObject;
		var rt = (RectTransform)go.transform;
		rt.anchoredPosition = anchoredPos;
		rt.sizeDelta = new Vector2(diameter, diameter);
		var img = go.AddComponent<Image>();
		ApplyRoundedBoxStyle(img, new Color(0.86f, 0.28f, 0.28f));
		img.pixelsPerUnitMultiplier = 6f; // high radius so the tiny box looks round
		return img;
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

	private void BuildMapPickerSection(Transform root)
	{
		_mapPickerSection = PanelWidgets.CreateContainer(root, "MapPickerSection", Vector2.zero).gameObject;

		var header = PanelWidgets.CreateLabel(_mapPickerSection.transform, _font, new Vector2(0, 190), new Vector2(400, 34), "Choose a Map");
		header.alignment = TextAlignmentOptions.Center;
		header.fontSize = 22;

		_lobbyNameField = CreateInputField(_mapPickerSection.transform, new Vector2(0, 150), new Vector2(440, 44), "Lobby name");
		_lobbyNameField.characterLimit = 32;

		var cancelGo = CloneButton(_mapPickerSection.transform, "CancelMapPicker", new Vector2(0, -195), new Vector2(280, 60), "Cancel");
		cancelGo.GetComponent<Button>().onClick.AddListener(() => _showingMapPicker = false);

		_mapPickerSection.SetActive(false);
	}

	private void RefreshMapPickerRows()
	{
		foreach (var row in _mapPickerRows) Object.Destroy(row);
		_mapPickerRows.Clear();

		var entries = new List<(string Label, int MapIndex)> { ("Base Game", -1) };
		if (MpMapLibrary.HasBSide) entries.Add(("B-Side", -2));
		for (int i = 0; i < _hostableMaps.Count; i++) entries.Add((_hostableMaps[i].Name, i));

		float y = 90f;
		const float rowSpacing = 56f;
		for (int i = 0; i < entries.Count; i++)
		{
			if (i > 0) _mapPickerRows.Add(PanelWidgets.CreateDivider(_mapPickerSection.transform, new Vector2(0, y + rowSpacing / 2f), 400));
			_mapPickerRows.Add(CreateMapPickerRow(new Vector2(0, y), entries[i].Label, entries[i].MapIndex));
			y -= rowSpacing;
		}
	}

	private GameObject CreateMapPickerRow(Vector2 pos, string label, int mapIndex)
	{
		var go = CloneButton(_mapPickerSection.transform, "MapRow", pos, new Vector2(400, 48), label);
		var tmp = go.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (tmp != null) tmp.alignment = TextAlignmentOptions.MidlineLeft;
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

		// Connect in the background while the panel is open; if the connection
		// drops after having worked, arm one fresh attempt.
		if (gameObject.activeInHierarchy)
		{
			if (connected) _autoConnectTried = true;
			else
			{
				if (_wasConnected) _autoConnectTried = false;
				if (!_autoConnectTried)
				{
					_autoConnectTried = true;
					mgr.ConnectAsync("codecade.co.za", 443);
				}
			}
		}
		_wasConnected = connected;

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

		bool browseView = !inLobby && !_showingMapPicker;
		if (_connectDot != null)
			_connectDot.color = connected
				? new Color(0.27f, 0.80f, 0.35f)
				: new Color(0.86f, 0.28f, 0.28f);
		_hostButton.SetActive(browseView);
		_mapPickerSection.SetActive(_showingMapPicker);
		_listBox.SetActive(browseView);
		_inLobbyRow.SetActive(inLobby && !_showingMapPicker);

		if (!browseView)
		{
			if (inLobby && !_showingMapPicker)
			{
				_inLobbyLabel.text = "In lobby: " + mgr.CurrentLobbyName;
				RefreshPlayersLabel(mgr.LastSnapshotPlayers);
				RefreshChatLog(mgr.ChatLines);
			}
			return;
		}

		if (connected) RefreshLobbyList(mgr.LastLobbyList);
	}

	private void RefreshPlayersLabel(List<MpPlayerState> others)
	{
		var selfName = MpNetworkManager.SanitizeForRichText(MpNetworkManager.GetDisplayName());
		// The local self entry is built here (not over the wire), so the Recharge gradient can show as per-character <color> tags.
		var sb = new System.Text.StringBuilder("Players: ").Append(MpNetworkManager.BuildLocalNameMarkup(selfName));
		foreach (var p in others)
		{
			var safeName = MpNetworkManager.SanitizeForRichText(p.name);
			sb.Append(", ").Append(MpNetworkManager.BuildRemoteNameMarkup(safeName, p.nameColor, p.nameGradient));
			if (p.isPaused) sb.Append(" (paused)");
		}
		_playersLabel.text = sb.ToString();
	}

	private TMP_Text _chatMeasurer;

	private float MeasureChatLineHeight(string text, float width)
	{
		if (_chatMeasurer == null)
		{
			var go = PanelWidgets.CreateContainer(_chatBox.transform, "ChatMeasurer", Vector2.zero).gameObject;
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
			var rowGo = PanelWidgets.CreateContainer(_chatLogContainer, "ChatLine", Vector2.zero).gameObject;
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
			var emptyGo = PanelWidgets.CreateLabel(_listContent.transform, _font, new Vector2(0, 10), new Vector2(500, 30), "(no open lobbies yet)").gameObject;
			emptyGo.GetComponent<TMP_Text>().color = new Color(1f, 1f, 1f, 0.5f);
			_lobbyListRows.Add(emptyGo);
			return;
		}

		var start = _lobbyPageIndex * LobbyPageSize;
		var end = Mathf.Min(start + LobbyPageSize, lobbies.Count);
		float y = 45f;
		const float rowSpacing = 76f;
		for (int i = start; i < end; i++)
		{
			var lobby = lobbies[i];
			int capturedId = lobby.id;
			var rowGo = CreateLobbyRow(_listContent.transform, new Vector2(0, y), new Vector2(580, 60), lobby);
			rowGo.GetComponent<Button>().onClick.AddListener(() => MpNetworkManager.GetOrCreate().JoinLobby(capturedId));
			_lobbyListRows.Add(rowGo);

			if (i < end - 1)
				_lobbyListRows.Add(PanelWidgets.CreateDivider(_listContent.transform, new Vector2(0, y - rowSpacing / 2f), 580));

			y -= rowSpacing;
		}
	}


	private GameObject CreateLobbyRow(Transform parent, Vector2 anchoredPos, Vector2 size, MpLobbyInfo lobby)
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
		var accent = new Color(1f, 0.55f, 0.15f, 1f);
		var label = go.transform.Find("Text (TMP)");
		if (label != null)
		{
			var existingTmp = label.GetComponent<TMP_Text>();
			if (existingTmp != null) font = existingTmp.font;
			Object.Destroy(label.gameObject);
		}

		// Top line: the lobby name (no per-host colour — skins identify players now).
		var nameGo = PanelWidgets.CreateContainer(go.transform, "NameLabel", Vector2.zero).gameObject;
		var nameRt = (RectTransform)nameGo.transform;
		nameRt.anchorMin = new Vector2(0f, 0.46f);
		nameRt.anchorMax = Vector2.one;
		nameRt.offsetMin = new Vector2(20f, 0f);
		nameRt.offsetMax = new Vector2(-116f, 0f);
		var nameTmp = nameGo.AddComponent<TextMeshProUGUI>();
		nameTmp.font = font;
		nameTmp.richText = false;
		nameTmp.color = Color.white;
		nameTmp.enableAutoSizing = true;
		nameTmp.fontSizeMax = 22f;
		nameTmp.fontSizeMin = 12f;
		nameTmp.enableWordWrapping = false;
		nameTmp.overflowMode = TextOverflowModes.Ellipsis;
		nameTmp.alignment = TextAlignmentOptions.BottomLeft;
		nameTmp.text = string.IsNullOrWhiteSpace(lobby.name) ? "Lobby" : lobby.name;

		// Bottom line: the map being played and who is hosting.
		var sub = new List<string>();
		if (!string.IsNullOrWhiteSpace(lobby.mapName)) sub.Add(lobby.mapName);
		if (!string.IsNullOrWhiteSpace(lobby.hostName)) sub.Add("by " + lobby.hostName);
		if (lobby.hard) sub.Add("Hard");
		var subGo = PanelWidgets.CreateContainer(go.transform, "SubLabel", Vector2.zero).gameObject;
		var subRt = (RectTransform)subGo.transform;
		subRt.anchorMin = Vector2.zero;
		subRt.anchorMax = new Vector2(1f, 0.52f);
		subRt.offsetMin = new Vector2(20f, 0f);
		subRt.offsetMax = new Vector2(-116f, 0f);
		var subTmp = subGo.AddComponent<TextMeshProUGUI>();
		subTmp.font = font;
		subTmp.richText = false;
		subTmp.color = new Color(1f, 1f, 1f, 0.55f);
		subTmp.enableAutoSizing = true;
		subTmp.fontSizeMax = 15f;
		subTmp.fontSizeMin = 10f;
		subTmp.enableWordWrapping = false;
		subTmp.overflowMode = TextOverflowModes.Ellipsis;
		subTmp.alignment = TextAlignmentOptions.TopLeft;
		subTmp.text = sub.Count > 0 ? string.Join("   ·   ", sub) : "(no map set)";

		// Right: player count.
		var countGo = PanelWidgets.CreateContainer(go.transform, "CountLabel", Vector2.zero).gameObject;
		var countRt = (RectTransform)countGo.transform;
		countRt.anchorMin = Vector2.zero;
		countRt.anchorMax = Vector2.one;
		countRt.offsetMin = new Vector2(size.x - 108f, 0f);
		countRt.offsetMax = new Vector2(-16f, 0f);
		var countTmp = countGo.AddComponent<TextMeshProUGUI>();
		countTmp.font = font;
		countTmp.color = accent;
		countTmp.enableAutoSizing = true;
		countTmp.fontSizeMax = 20f;
		countTmp.fontSizeMin = 11f;
		countTmp.enableWordWrapping = false;
		countTmp.alignment = TextAlignmentOptions.MidlineRight;
		countTmp.text = $"{lobby.count} player{(lobby.count == 1 ? "" : "s")}";

		var highlightGo = PanelWidgets.CreateContainer(go.transform, "Highlight", Vector2.zero).gameObject;
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

	// Buttons are built with PanelWidgets so the DOTnet panel matches the other
	// new Mods-menu panels (Skinmod, Host Panel) instead of the game's own style.
	private GameObject CloneButton(Transform parent, string name, Vector2 anchoredPos, Vector2 size, string labelOverride = null)
	{
		var go = PanelWidgets.CreateButton(parent, _font, name, anchoredPos, size, labelOverride ?? name,
			22f, new Color(1f, 0.55f, 0.15f, 1f), TextAlignmentOptions.Center, false);
		var label = go.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
		if (label != null)
		{
			label.enableAutoSizing = false;
			label.enableWordWrapping = false;
			PanelWidgets.FitLabel(label);
		}
		return go;
	}

	private TMP_InputField CreateInputField(Transform parent, Vector2 anchoredPos, Vector2 size, string placeholder)
	{
		var input = PanelWidgets.CreateInputField(parent, _font, anchoredPos, size, placeholder, fontSize: 22f);
		ApplyRoundedBoxStyle(input.GetComponent<Image>(), Color.white);
		input.textViewport.offsetMin = new Vector2(16, 4);
		input.textViewport.offsetMax = new Vector2(-12, -4);
		return input;
	}
}

// Network.cs still dispatches the companion app's "open_colour_submenu"
// command to this panel. The appearance/name UI is gone, so this extension
// keeps that out-of-scope call site compiling as a no-op.
internal static class MpPanelUiCompat
{
	public static void TestOpenAppearance(this MpPanelUI panel) { }
}

internal static class MpMenuBuilder
{
	public static void Install(pauseMenuScript menu)
	{
		MpNetworkManager.GetOrCreate();
		if (PauseMenuHelper.MainBit(menu) == null || PauseMenuHelper.SettingsBit(menu) == null) return;

		var mpPanel = PauseMenuHelper.AddPanelRow(menu, "DOTnetPanel", "DOTnet");
		if (mpPanel == null) return;

		if (mpPanel.GetComponent<MpPanelUI>() == null)
		{
			var font = FindTitleFont(mpPanel);
			var ui = mpPanel.AddComponent<MpPanelUI>();
			ui.Build(mpPanel, font, settingsButtonTemplate: PauseMenuHelper.MainBit(menu).transform.Find("Settings").gameObject, menu);
		}

		MpNetworkManager.LatestMainBit = PauseMenuHelper.MainBit(menu);
		MpNetworkManager.LatestMpPanel = mpPanel;
	}

	// DOTnet now shows a "DOTnet" row in the in-game Mods menu (the rowName "DOTnetPanel" stays off the ModApi's IntegratedRows hide-list). Lobbies can also be managed in the Recharge app, and the in-lobby
	// controls (Ready, Host Panel, Leave, Colour) open with F4 from the pause menu (HostPanelController.Update).

	private static TMP_FontAsset FindTitleFont(GameObject panel)
	{
		var title = panel.transform.Find("Settings") ?? (panel.transform.childCount > 0 ? panel.transform.GetChild(0) : null);
		return title != null ? title.GetComponent<TMP_Text>()?.font : null;
	}
}

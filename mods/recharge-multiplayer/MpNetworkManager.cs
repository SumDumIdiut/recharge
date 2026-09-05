using System.Collections.Generic;
using System.IO;
using System.Threading;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Steamworks;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

internal class MpNetworkManager : MonoBehaviour
{
	public static MpNetworkManager Instance { get; private set; }

	public string StatusText = "Not connected";
	public int CurrentLobbyId;
	public string CurrentLobbyName;
	public List<MpLobbyInfo> LastLobbyList = new List<MpLobbyInfo>();
	public List<MpPlayerState> LastSnapshotPlayers = new List<MpPlayerState>();
	public readonly List<string> ChatLines = new List<string>();
	private const int MaxChatLines = 50;

	private readonly MpNetClient _net = new MpNetClient();
	private Movement _localPlayer;
	private List<SpriteRenderer> _localSpriteRenderers;
	private List<Color> _localSpriteOriginalColors;
	private string _lastAppliedDotColorHex;
	private int _frameCounter;
	// retried from Update() until the Controls row's InputActionReference resolves
	private bool _chatRowEnsured;

	// Test-only: mp-test.flag under persistentDataPath drives this without touching the real menu.
	// "<host>:<port>:<lobbyName>" connects then hosts; "open_panel"/"close_panel" toggle the panel directly.
	private static readonly string FlagPath = System.IO.Path.Combine(Application.persistentDataPath, "mp-test.flag");
	private float _flagCheckAccumulator;
	private string _pendingHostName;
	public static GameObject LatestMainBit;
	public static GameObject LatestMpPanel;
	public static GameObject LatestPage1;

	public bool IsConnected => _net.IsConnected;
	public bool InLobby => CurrentLobbyId != 0;
	public static Movement LocalPlayer => Instance != null ? Instance._localPlayer : null;

	public static MpNetworkManager GetOrCreate()
	{
		if (Instance != null) return Instance;
		var go = new GameObject("MpNetworkManager");
		Object.DontDestroyOnLoad(go);
		return go.AddComponent<MpNetworkManager>();
	}

	private void Awake()
	{
		if (Instance != null && Instance != this)
		{
			Object.Destroy(gameObject);
			return;
		}
		Instance = this;
		Object.DontDestroyOnLoad(gameObject);
		gameObject.AddComponent<MpInGameChatHud>();
		SceneManager.sceneLoaded += (scene, mode) => RebindPlayer();
		RebindPlayer();
	}

	private void RebindPlayer()
	{
		MpGhostManager.Clear();

		var playerGo = GameObject.FindGameObjectWithTag("Player");
		_localPlayer = playerGo != null ? playerGo.GetComponent<Movement>() : null;
		var sprite = _localPlayer != null ? _localPlayer.transform.Find("Sprite") : null;
		if (sprite != null) MpGhostManager.SetTemplate(sprite);

		_localSpriteRenderers = null;
		_localSpriteOriginalColors = null;
		_lastAppliedDotColorHex = null;

		_chatRowEnsured = false;
	}

	private void ApplyLocalDotColor()
	{
		if (_localPlayer == null) return;
		bool inLobby = CurrentLobbyId != 0;

		if (!inLobby)
		{
			if (_localSpriteRenderers != null)
			{
				for (int i = 0; i < _localSpriteRenderers.Count; i++)
					if (_localSpriteRenderers[i] != null) _localSpriteRenderers[i].color = _localSpriteOriginalColors[i];
				_localSpriteRenderers = null;
				_localSpriteOriginalColors = null;
				_lastAppliedDotColorHex = null;
			}
			return;
		}

		if (_localSpriteRenderers == null)
		{
			var sprite = _localPlayer.transform.Find("Sprite");
			_localSpriteRenderers = new List<SpriteRenderer>();
			_localSpriteOriginalColors = new List<Color>();
			if (sprite != null)
			{
				foreach (var sr in sprite.GetComponentsInChildren<SpriteRenderer>(true))
				{
					_localSpriteRenderers.Add(sr);
					_localSpriteOriginalColors.Add(sr.color);
				}
			}
		}

		var dotHex = GetDotColorHex();
		if (dotHex == _lastAppliedDotColorHex) return;
		_lastAppliedDotColorHex = dotHex;
		if (!ColorUtility.TryParseHtmlString(dotHex, out var c)) return;
		foreach (var sr in _localSpriteRenderers)
			if (sr != null) sr.color = c;
	}

	private static readonly System.Reflection.FieldInfo ActionField =
		typeof(KeybindSetterItemScript).GetField("action", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);

	private static string GetActionName(KeybindSetterItemScript item)
	{
		var actionRef = ActionField?.GetValue(item) as UnityEngine.InputSystem.InputActionReference;
		return actionRef != null && actionRef.action != null ? actionRef.action.name : null;
	}

	private static bool EnsureChatKeybindRow()
	{
		var items = Object.FindObjectsByType<KeybindSetterItemScript>(FindObjectsInactive.Include, FindObjectsSortMode.None);
		if (items.Length == 0) return false;
		var template = items[0];

		var container = template.transform.parent;
		if (container == null) return true;
		// the clone destroys its own KeybindSetterItemScript, so check the container children directly rather than re-scanning
		for (int i = 0; i < container.childCount; i++)
		{
			if (container.GetChild(i).GetComponent<MpChatKeybindRow>() != null) return true;
		}

		// rows are positioned by Transform, not layout-grouped, so anchor off the two known
		// bottom rows by action name rather than array order
		Transform quickRestartTf = null;
		Transform swapHudTf = null;
		foreach (var item in items)
		{
			var name = GetActionName(item);
			if (name == "QuickReset") quickRestartTf = item.transform;
			else if (name == "SwapCurrencyDisplay") swapHudTf = item.transform;
		}
		if (quickRestartTf == null) return false; // action refs not resolved yet - retry next frame
		float spacing = 60f;
		if (swapHudTf != null) spacing = swapHudTf.localPosition.y - quickRestartTf.localPosition.y;
		float newY = quickRestartTf.localPosition.y - spacing;
		template = quickRestartTf.GetComponent<KeybindSetterItemScript>();

		var clone = Object.Instantiate(template.gameObject, container, false);
		clone.name = "ChatKeybindItem";
		var clonePos = clone.transform.localPosition;
		clone.transform.localPosition = new Vector3(clonePos.x, newY, clonePos.z);
		Object.Destroy(clone.GetComponent<KeybindSetterItemScript>());

		var titleTf = clone.transform.Find("Title");
		var titleLoc = titleTf != null ? titleTf.GetComponent<UnityEngine.Localization.Components.LocalizeStringEvent>() : null;
		if (titleLoc != null) Object.Destroy(titleLoc);
		var title = titleTf != null ? titleTf.GetComponent<TMPro.TMP_Text>() : null;
		if (title != null) title.text = "Chat";

		var keyboardKeyTf = clone.transform.Find("KeyboardKey");
		var keyText = keyboardKeyTf != null ? keyboardKeyTf.Find("Text (TMP)")?.GetComponent<TMPro.TMP_Text>() : null;
		var keyButton = keyboardKeyTf != null ? keyboardKeyTf.GetComponent<Button>() : null;

		var controllerKeyTf = clone.transform.Find("ControllerKey");
		if (controllerKeyTf != null)
		{
			var ctrlText = controllerKeyTf.Find("Text (TMP)")?.GetComponent<TMPro.TMP_Text>();
			if (ctrlText != null) ctrlText.text = "NONE";
			var ctrlButton = controllerKeyTf.GetComponent<Button>();
			if (ctrlButton != null) ctrlButton.onClick = new Button.ButtonClickedEvent();
		}

		var waitingForInputTf = clone.transform.Find("WaitingForInput");
		if (waitingForInputTf != null) Object.Destroy(waitingForInputTf.gameObject);

		if (keyText != null && keyButton != null)
		{
			keyButton.onClick = new Button.ButtonClickedEvent();
			clone.AddComponent<MpChatKeybindRow>().Init(keyText, keyButton);
		}
		return true;
	}

	// SteamManager owns SteamAPI Init/Shutdown/RunCallbacks; this only reads from it
	internal static string GetDisplayName()
	{
		try
		{
			if (SteamManager.Initialized) return SteamFriends.GetPersonaName();
		}
		catch { /* Steam not available for some reason - fall through */ }
		return PlayerPrefs.GetString("MpDisplayName", "Player");
	}

	private const string NameColorPrefsKey = "MpNameColor";
	private const string DotColorPrefsKey = "MpDotColor";
	public const string DefaultNameColorHex = "#FFFFFF";
	public const string DefaultDotColorHex = "#3399FF";

	public static string GetNameColorHex() => PlayerPrefs.GetString(NameColorPrefsKey, DefaultNameColorHex);
	public static string GetDotColorHex() => PlayerPrefs.GetString(DotColorPrefsKey, DefaultDotColorHex);

	public static void SetNameColorHex(string hex)
	{
		PlayerPrefs.SetString(NameColorPrefsKey, hex);
		PlayerPrefs.Save();
	}

	public static void SetDotColorHex(string hex)
	{
		PlayerPrefs.SetString(DotColorPrefsKey, hex);
		PlayerPrefs.Save();
	}

	private void Update()
	{
		if (!_chatRowEnsured) _chatRowEnsured = EnsureChatKeybindRow();

		while (_net.TryDequeue(out var line)) HandleLine(line);

		MpGhostManager.Tick(Time.unscaledDeltaTime);

		_flagCheckAccumulator += Time.unscaledDeltaTime;
		if (_flagCheckAccumulator >= 1f)
		{
			_flagCheckAccumulator = 0f;
			CheckTestFlag();
		}

		if (!_net.IsConnected)
		{
			if (StatusText.StartsWith("Connected") || StatusText.StartsWith("In lobby"))
				StatusText = "Disconnected: " + (_net.LastError ?? "connection lost");
			return;
		}
		if (_pendingHostName != null && CurrentLobbyId == 0)
		{
			var lobbyName = _pendingHostName;
			_pendingHostName = null;
			HostLobby(lobbyName);
		}

		ApplyLocalDotColor();
		if (_localPlayer == null || CurrentLobbyId == 0) return;

		_frameCounter++;
		if (_frameCounter % 2 != 0) return;
		SendLocalState();
	}

	private void SendLocalState()
	{
		var pos = _localPlayer.transform.position;
		var anim = _localPlayer.animator;
		int animState = anim != null ? anim.GetInteger("Animation") : 0;
		float animSpeed = anim != null ? anim.speed : 1f;
		bool isPaused = (LatestMainBit != null && LatestMainBit.activeInHierarchy)
			|| (LatestMpPanel != null && LatestMpPanel.activeInHierarchy);

		var msg = new MpStateMsg
		{
			x = pos.x,
			y = pos.y,
			facingRight = _localPlayer.facingRight,
			animState = animState,
			animSpeed = animSpeed,
			isPaused = isPaused,
			name = GetDisplayName(),
			nameColor = GetNameColorHex(),
			dotColor = GetDotColorHex(),
		};
		_net.Send(JsonConvert.SerializeObject(msg));
	}

	private void HandleLine(string line)
	{
		JObject obj;
		try { obj = JObject.Parse(line); }
		catch { return; }

		var type = (string)obj["type"];
		switch (type)
		{
			case "welcome":
				StatusText = "Connected";
				break;
			case "snapshot":
			{
				var snap = obj.ToObject<MpSnapshotMsg>();
				LastSnapshotPlayers = snap?.players ?? new List<MpPlayerState>();
				MpGhostManager.ApplySnapshot(LastSnapshotPlayers);
				break;
			}
			case "hosted":
				CurrentLobbyId = (int)obj["lobbyId"];
				CurrentLobbyName = SanitizeForRichText((string)obj["name"]);
				StatusText = "Connected"; // MpPanelUI's dedicated in-lobby row already names the lobby
				ChatLines.Clear();
				break;
			case "joined":
			{
				CurrentLobbyId = (int)obj["lobbyId"];
				CurrentLobbyName = SanitizeForRichText((string)obj["name"]);
				StatusText = "Connected";
				ChatLines.Clear();
				// backfill whatever the lobby's members already said before this
				// client joined, instead of starting mid-conversation with nothing
				var history = obj["history"]?.ToObject<List<MpChatHistoryEntry>>();
				if (history != null)
					foreach (var h in history)
						ChatLines.Add(FormatChatLine(h.from, h.fromColor, h.text));
				break;
			}
			case "join_failed":
				StatusText = "Join failed: " + (string)obj["reason"];
				break;
			case "left":
				CurrentLobbyId = 0;
				CurrentLobbyName = null;
				MpGhostManager.Clear();
				LastSnapshotPlayers.Clear();
				StatusText = "Connected";
				break;
			case "lobby_list":
			{
				var msg = obj.ToObject<MpLobbyListMsg>();
				LastLobbyList = msg?.lobbies ?? new List<MpLobbyInfo>();
				foreach (var l in LastLobbyList) l.name = SanitizeForRichText(l.name);
				break;
			}
			case "chat":
				ChatLines.Add(FormatChatLine((string)obj["from"], (string)obj["fromColor"], (string)obj["text"]));
				while (ChatLines.Count > MaxChatLines) ChatLines.RemoveAt(0);
				break;
		}
	}

	private static string FormatChatLine(string from, string fromColor, string text)
	{
		var safeFrom = SanitizeForRichText(from ?? "?");
		var safeText = SanitizeForRichText(text ?? "");
		var isValidHex = !string.IsNullOrEmpty(fromColor) && fromColor.Length == 7 && fromColor[0] == '#';
		var namePart = isValidHex ? $"<color={fromColor}>{safeFrom}</color>" : safeFrom;
		return $"{namePart}: {safeText}";
	}

	// Chat text, lobby names, and display names are all player-controlled and
	// end up in TMP_Text components with rich text parsing on - replacing the
	// angle brackets (rather than wrapping in <noparse>) means the string can
	// never form a tag at all, even via a smuggled "</noparse>" trying to
	// break back out early.
	internal static string SanitizeForRichText(string s)
		=> string.IsNullOrEmpty(s) ? (s ?? "") : s.Replace('<', '＜').Replace('>', '＞');

	private void CheckTestFlag()
	{
		if (!File.Exists(FlagPath)) return;
		try
		{
			var content = File.ReadAllText(FlagPath).Trim();
			if (content == "leave_lobby")
			{
				LeaveLobby();
				return;
			}
			if (content == "open_panel")
			{
				if (LatestMainBit != null) LatestMainBit.SetActive(false);
				if (LatestMpPanel != null) LatestMpPanel.SetActive(true);
				return;
			}
			if (content == "show_page2")
			{
				if (LatestPage1 != null) LatestPage1.SetActive(false);
				if (LatestMainBit != null) LatestMainBit.SetActive(true);
				return;
			}
			if (content == "close_panel")
			{
				if (LatestMpPanel != null) LatestMpPanel.SetActive(false);
				if (LatestMainBit != null) LatestMainBit.SetActive(true);
				return;
			}
			if (content.StartsWith("chat:"))
			{
				SendChat(content.Substring(5));
				return;
			}
			if (content == "show_controls")
			{
				ShowControlsScreen();
				return;
			}
			if (content.StartsWith("set_dot_color:"))
			{
				SetDotColorHex(content.Substring("set_dot_color:".Length));
				return;
			}
			if (content == "open_colour_submenu")
			{
				LatestMpPanel?.GetComponent<MpPanelUI>()?.TestOpenAppearance();
				return;
			}
			if (content == "show_hud_chat" || content == "hide_hud_chat")
			{
				var hud = GetComponent<MpInGameChatHud>();
				if (hud != null) hud.ForceShow = content == "show_hud_chat";
				return;
			}

			var parts = content.Split(':');
			if (parts.Length >= 3 && int.TryParse(parts[1], out var port))
			{
				// reconnecting clears any stale lobby id from a previous session
				CurrentLobbyId = 0;
				_pendingHostName = parts[2];
				ConnectAsync(parts[0], port);
			}
		}
		finally
		{
			File.Delete(FlagPath);
		}
	}

	private volatile bool _connecting;

	public void ConnectAsync(string host, int port)
	{
		// MpNetClient.Connect() isn't safe to call concurrently (it mutates a
		// shared _ws field with no locking) - a stray double-click on Connect
		// while a slow attempt is still in flight would otherwise race two
		// threads through it at once.
		if (_connecting) return;
		_connecting = true;
		StatusText = "Connecting...";
		new Thread(() =>
		{
			try
			{
				_net.Connect(host, port);
				if (!_net.IsConnected) StatusText = "Failed: " + (_net.LastError ?? "unknown error");
			}
			finally { _connecting = false; }
		})
		{ IsBackground = true }.Start();
	}

	public void Disconnect()
	{
		_net.Disconnect();
		MpGhostManager.Clear();
		LastSnapshotPlayers.Clear();
		CurrentLobbyId = 0;
		CurrentLobbyName = null;
		StatusText = "Not connected";
	}

	public void HostLobby(string lobbyName)
	{
		_net.Send(JsonConvert.SerializeObject(new MpHostMsg { name = lobbyName, playerName = GetDisplayName() }));
	}

	public void RequestLobbyList()
	{
		_net.Send("{\"type\":\"list_lobbies\"}");
	}

	public void JoinLobby(int lobbyId)
	{
		_net.Send(JsonConvert.SerializeObject(new MpJoinLobbyMsg { lobbyId = lobbyId, playerName = GetDisplayName() }));
	}

	public void LeaveLobby()
	{
		_net.Send("{\"type\":\"leave_lobby\"}");
		CurrentLobbyId = 0;
		CurrentLobbyName = null;
		MpGhostManager.Clear();
		LastSnapshotPlayers.Clear();
		StatusText = "Connected";
	}

	public void SendChat(string text)
	{
		if (string.IsNullOrWhiteSpace(text) || CurrentLobbyId == 0) return;
		_net.Send(JsonConvert.SerializeObject(new MpChatMsg { text = text }));
	}

	private static void ShowControlsScreen()
	{
		var items = Object.FindObjectsByType<KeybindSetterItemScript>(FindObjectsInactive.Include, FindObjectsSortMode.None);
		if (items.Length == 0) return;
		var t = items[0].transform;
		while (t != null)
		{
			t.gameObject.SetActive(true);
			t = t.parent;
		}
	}

}

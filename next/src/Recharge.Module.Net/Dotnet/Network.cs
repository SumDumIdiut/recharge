using Recharge.ModApi;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using Recharge.Core.Json;
using Recharge.Net;
using Steamworks;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UI;
using Object = UnityEngine.Object;

// The game-side DOTnet manager. The protocol lives in Recharge.Net's NetClient; this class owns the Unity side
// (ghosts, local state, menus' data). NetClient raises its events on its receive thread, so every event is queued
// and applied in Update on the main thread.
public class MpNetworkManager : MonoBehaviour
{
	public static MpNetworkManager Instance { get; private set; }
	public static Recharge.ModApi.IRechargeHost Host;

	public string StatusText = "Not connected";
	public int CurrentLobbyId;
	public string CurrentLobbyName;
	public int LocalPlayerId;
	public bool IsHost;
	public event System.Action<int, JObject> OnGameMessage;
	/// <summary>Raised on the main thread when the lobby changes (id 0 = none); the app link reports it.</summary>
	public event System.Action<int, string, bool> LobbyChanged;
	public List<MpLobbyInfo> LastLobbyList = new List<MpLobbyInfo>();
	public List<MpPlayerState> LastSnapshotPlayers = new List<MpPlayerState>();
	public string PendingMapHubId;
	public string PendingMapName;
	public volatile bool MapDownloading;
	public string MapDownloadError;
	public string PendingLocalMapId;
	public bool? PendingBaseGameHard;
	public string PendingHostMapKind;
	public readonly List<string> ChatLines = new List<string>();
	private const int MaxChatLines = 50;

	private readonly NetClient _net = new NetClient();
	private readonly ConcurrentQueue<Action> _main = new ConcurrentQueue<Action>();
	private Movement _localPlayer;
	private List<SpriteRenderer> _localSpriteRenderers;
	private List<Color> _localSpriteOriginalColors;
	private string _lastAppliedDotColorHex;
	private float _stateSendAccumulator;
	private const float StateSendInterval = 1f / 60f;
	private bool _chatRowEnsured;
	private float _nextChatRowCheckTime;
	private float _lastStateLogTime = -999f;
	private int _sentDashes = -1, _sentJumps = -1;
	private float _indicatorResendAt;

	private static readonly string FlagPath = System.IO.Path.Combine(Application.persistentDataPath, "mp-test.flag");
	private float _flagCheckAccumulator;
	private string _pendingHostName;
	private volatile bool _connecting;
	private string _joinFailure;
	public static GameObject LatestMainBit;
	public static GameObject LatestMpPanel;
	public static GameObject LatestPage1;
	public static GameObject LatestInLobbyRow;

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
		SubscribeNet();
		SceneManager.sceneLoaded += (scene, mode) => RebindPlayer();
		RebindPlayer();
	}

	private void OnDestroy()
	{
		if (Instance == this) { try { _net.Dispose(); } catch { } }
	}

	/// <summary>Runs work on the main thread (next Update) and returns its result.</summary>
	public Task<T> OnMain<T>(Func<T> work)
	{
		var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
		_main.Enqueue(() =>
		{
			try { tcs.SetResult(work()); }
			catch (Exception e) { tcs.SetException(e); }
		});
		return tcs.Task;
	}

	public void RunOnMain(Action work) => _main.Enqueue(work);

	// ---- NetClient events (receive thread) -> main thread ----

	private void SubscribeNet()
	{
		_net.Welcome += id => RunOnMain(() =>
		{
			StatusText = "Connected";
			LocalPlayerId = id;
		});
		_net.Hosted += h => RunOnMain(() =>
		{
			SetLobby(h.LobbyId, h.Name);
			StatusText = "Connected";
			ChatLines.Clear();
		});
		_net.Joined += j => RunOnMain(() =>
		{
			SetLobby(j.LobbyId, j.Name);
			StatusText = "Connected";
			ChatLines.Clear();
			foreach (var e in j.History) ChatLines.Add(NetText.FormatChatLine(e.From, e.FromColor, e.Text));

			PendingMapHubId = null;
			PendingMapName = null;
			PendingLocalMapId = null;
			if (!string.IsNullOrEmpty(j.MapHubId))
			{
				if (MpMapLibrary.IsDownloaded(j.MapHubId)) { PendingLocalMapId = j.MapHubId; PendingMapName = j.MapName; }
				else { PendingMapHubId = j.MapHubId; PendingMapName = j.MapName; }
			}
		});
		_net.JoinFailed += reason => RunOnMain(() =>
		{
			_joinFailure = reason;
			StatusText = "Join failed: " + reason;
			SetLobby(0, null);
			MpGhostManager.Clear();
			LastSnapshotPlayers.Clear();
		});
		_net.Left += () => RunOnMain(() =>
		{
			SetLobby(0, null);
			MpGhostManager.Clear();
			LastSnapshotPlayers.Clear();
			StatusText = "Connected";
		});
		_net.Snapshot += players => RunOnMain(() =>
		{
			var list = new List<MpPlayerState>(players.Count);
			foreach (var p in players)
				list.Add(new MpPlayerState { id = p.Id, x = p.X, y = p.Y, facingRight = p.FacingRight, animState = p.AnimState, animSpeed = (float)p.AnimSpeed, isPaused = p.IsPaused, name = p.Name, nameColor = p.NameColor, dotColor = p.DotColor });
			LastSnapshotPlayers = list;
			MpGhostManager.ApplySnapshot(list);
		});
		_net.LobbyList += lobbies => RunOnMain(() =>
		{
			var list = new List<MpLobbyInfo>(lobbies.Count);
			foreach (var l in lobbies)
				list.Add(new MpLobbyInfo { id = l.Id, name = l.Name, hostName = l.HostName, hostColor = l.HostColor, count = l.Count, mapHubId = l.MapHubId, mapName = l.MapName, hard = l.Hard });
			LastLobbyList = list;
		});
		_net.Chat += c => RunOnMain(() =>
		{
			ChatLines.Add(NetText.FormatChatLine(c.From, c.FromColor, c.Text));
			while (ChatLines.Count > MaxChatLines) ChatLines.RemoveAt(0);
		});
		_net.GameMessage += (from, payload) => RunOnMain(() => HandleGameMessage(from, payload));
		_net.Disconnected += error => RunOnMain(() =>
		{
			StatusText = "Disconnected: " + (error ?? _net.LastError ?? "connection lost");
		});
	}

	private void SetLobby(int id, string name)
	{
		bool changed = CurrentLobbyId != id || CurrentLobbyName != name;
		CurrentLobbyId = id;
		CurrentLobbyName = name;
		if (id == 0) IsHost = false;
		if (changed) LobbyChanged?.Invoke(id, name, IsHost);
	}

	private void HandleGameMessage(int from, JsonObject payload)
	{
		var kind = payload.TryGetValue("k", out var k) && k is JsonString ks ? ks.Value : null;
		if (kind == "ind")
		{
			if (from != LocalPlayerId)
				MpGhostManager.SetIndicators(from, IntOf(payload, "d"), IntOf(payload, "j"));
			return;
		}
		Debug.Log($"[MpNet] recv game_msg from={from} k={kind} localId={LocalPlayerId} hasSubscriber={OnGameMessage != null}");
		JObject jo;
		try { jo = JObject.Parse(JsonWriter.Write(payload, 0)); }
		catch (Exception) { return; }
		OnGameMessage?.Invoke(from, jo);
	}

	private static int IntOf(JsonObject o, string key) => o.TryGetValue(key, out var v) && v is JsonNumber n ? (int)n.AsDouble() : 0;

	private void RebindPlayer()
	{
		MpGhostManager.Clear();

		var playerGo = GameObject.FindGameObjectWithTag("Player");
		_localPlayer = playerGo != null ? playerGo.GetComponent<Movement>() : null;
		var sprite = _localPlayer != null ? _localPlayer.transform.Find("Sprite") : null;
		if (sprite != null) MpGhostManager.SetTemplate(sprite, _localPlayer.transform.parent != null ? _localPlayer.transform.parent.Find("JumpIndicators") : null);

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

	private static readonly System.Reflection.FieldInfo ActionField = Reflect.FieldOf<KeybindSetterItemScript>("action");

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
		for (int i = 0; i < container.childCount; i++)
		{
			if (container.GetChild(i).GetComponent<MpChatKeybindRow>() != null) return true;
		}

		Transform quickRestartTf = null;
		Transform swapHudTf = null;
		foreach (var item in items)
		{
			var name = GetActionName(item);
			if (name == "QuickReset") quickRestartTf = item.transform;
			else if (name == "SwapCurrencyDisplay") swapHudTf = item.transform;
		}
		if (quickRestartTf == null) return false;
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
		ModLabel.Attach(titleTf != null ? titleTf.GetComponent<TMPro.TMP_Text>() : null, "Chat");

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

	internal static string GetDisplayName()
	{
		var custom = PlayerPrefs.GetString("MpDisplayName", "");
		if (!string.IsNullOrWhiteSpace(custom)) return custom;
		try
		{
			if (SteamManager.Initialized)
			{
				var steamName = SteamFriends.GetPersonaName();
				if (!string.IsNullOrWhiteSpace(steamName)) return steamName;
			}
		}
		catch { }
		return "Player";
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
		// FindObjectsByType<KeybindSetterItemScript> every frame is wasteful
		// while the menu isn't even open, and doing this plus the reflection
		// + Instantiate/Destroy work below in the same frame the keybinds
		// list first builds piles more allocation onto Unity's own already
		// reflection-heavy layout pass for that exact menu - throttling to
		// roughly twice a second keeps this responsive without adding to
		// that burst every single frame.
		if (!_chatRowEnsured && Time.unscaledTime >= _nextChatRowCheckTime)
		{
			_nextChatRowCheckTime = Time.unscaledTime + 0.5f;
			_chatRowEnsured = EnsureChatKeybindRow();
		}

		while (_main.TryDequeue(out var work))
		{
			try { work(); }
			catch (Exception e) { Debug.LogWarning("[MpNet] " + e); }
		}

		MpGhostManager.Tick(Time.unscaledDeltaTime);

		_flagCheckAccumulator += Time.unscaledDeltaTime;
		if (_flagCheckAccumulator >= 1f)
		{
			_flagCheckAccumulator = 0f;
			CheckTestFlag();
		}

		if (!_net.IsConnected)
		{
			// NetClient retries on its own every few seconds while auto-reconnect is on.
			if (_net.AutoReconnect && StatusText.StartsWith("Disconnected")) StatusText = "Reconnecting...";
			return;
		}
		if (_pendingHostName != null && CurrentLobbyId == 0)
		{
			var lobbyName = _pendingHostName;
			_pendingHostName = null;
			HostLobby(lobbyName, null, null, null, false);
		}

		ApplyLocalDotColor();
		if (_localPlayer == null || CurrentLobbyId == 0) return;

		_stateSendAccumulator += Time.unscaledDeltaTime;
		if (_stateSendAccumulator < StateSendInterval) return;
		_stateSendAccumulator = 0f;
		SendLocalState();
		SendIndicators();
	}

	private void SendLocalState()
	{
		MpOrigin.ToWorld(_localPlayer.transform.position, out var worldX, out var worldY);
		var anim = _localPlayer.animator;
		int animState = anim != null ? anim.GetInteger("Animation") : 0;
		float animSpeed = anim != null ? anim.speed : 1f;
		bool isPaused = Time.timeScale <= 0f;

		if (Time.unscaledTime - _lastStateLogTime > 2f)
		{
			_lastStateLogTime = Time.unscaledTime;
			Debug.Log($"[MpNet] send state localId={LocalPlayerId} world=({worldX:F1},{worldY:F1}) paused={isPaused} lobby={CurrentLobbyId}");
		}

		_net.SendState(worldX, worldY, _localPlayer.facingRight, animState, animSpeed, isPaused, GetDisplayName(), GetNameColorHex(), GetDotColorHex());
	}

	// Air dashes/jumps left go out through the relay's generic game_msg
	// channel (no relay change needed): on every change, plus once a second
	// so someone who joins mid-air still gets them.
	private void SendIndicators()
	{
		int dashes = _localPlayer.airDashesLeft, jumps = _localPlayer.airJumpsLeft;
		if (dashes == _sentDashes && jumps == _sentJumps && Time.unscaledTime < _indicatorResendAt) return;
		_sentDashes = dashes;
		_sentJumps = jumps;
		_indicatorResendAt = Time.unscaledTime + 1f;
		SendGameMessage(new JObject { ["k"] = "ind", ["d"] = dashes, ["j"] = jumps });
	}

	internal static string SanitizeForRichText(string s) => NetText.SanitizeForRichText(s);

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


	public void ConnectAsync(string host, int port)
	{
		if (_connecting) return;
		_connecting = true;
		StatusText = "Connecting...";
		_ = ConnectCoreAsync(host, port);
	}

	private async Task ConnectCoreAsync(string host, int port)
	{
		try { await _net.ConnectAsync(host, port).ConfigureAwait(false); }
		catch (Exception e)
		{
			var msg = _net.LastError ?? e.Message;
			RunOnMain(() => { if (!_net.IsConnected) StatusText = "Failed: " + msg; });
		}
		finally { _connecting = false; }
	}

	public void Disconnect()
	{
		_net.Disconnect();
		MpGhostManager.Clear();
		LastSnapshotPlayers.Clear();
		SetLobby(0, null);
		StatusText = "Not connected";
		IsHost = false;
	}

	public void HostLobby(string lobbyName, string mapLocalId, string mapHubId, string mapName, bool hard)
	{
		if (!string.IsNullOrEmpty(mapLocalId)) { PendingLocalMapId = mapLocalId; PendingMapName = mapName; }
		IsHost = true;
		var playerName = GetDisplayName();
		_ = RunNet(() => _net.HostAsync(lobbyName, playerName, mapHubId, mapName, hard), "host");
	}

	public void LoadPendingLocalMap()
	{
		if (string.IsNullOrEmpty(PendingLocalMapId)) return;
		var mapId = PendingLocalMapId;
		PendingLocalMapId = null;
		Host?.Events.Emit("recharge.maps.load_requested", mapId);
	}

	public void RequestLobbyList()
	{
		_ = RunNet(() => _net.ListLobbiesAsync(), "list");
	}

	public void JoinLobby(int lobbyId)
	{
		IsHost = false;
		var playerName = GetDisplayName();
		_ = RunNet(() => _net.JoinAsync(lobbyId, playerName), "join");
	}

	/// <summary>Join from the app (the lobby.join intent): connects to the relay if needed, joins, and throws the relay's reason when refused.</summary>
	public async Task JoinFromLinkAsync(int lobbyId, string host, int port)
	{
		if (!_net.IsConnected)
		{
			await OnMain(() => { StatusText = "Connecting..."; return 0; }).ConfigureAwait(false);
			await _net.ConnectAsync(host, port).ConfigureAwait(false);
		}
		var playerName = await OnMain(() => { _joinFailure = null; IsHost = false; return GetDisplayName(); }).ConfigureAwait(false);
		var joined = await _net.JoinAsync(lobbyId, playerName).ConfigureAwait(false);
		if (joined == null) throw new InvalidOperationException(_joinFailure ?? "the relay refused the join");
	}

	/// <summary>Host from the app (the lobby.host intent): connects to the relay if needed and opens the lobby the way the in-game host menu does; throws the relay's reason when refused.</summary>
	public async Task HostFromLinkAsync(string lobbyName, string mapLocalId, string mapHubId, string mapName, bool hard, string host, int port)
	{
		if (!_net.IsConnected)
		{
			await OnMain(() => { StatusText = "Connecting..."; return 0; }).ConfigureAwait(false);
			await _net.ConnectAsync(host, port).ConfigureAwait(false);
		}
		var playerName = await OnMain(() =>
		{
			_joinFailure = null;
			IsHost = true;
			if (!string.IsNullOrEmpty(mapLocalId)) { PendingLocalMapId = mapLocalId; PendingMapName = mapName; }
			else { PendingBaseGameHard = hard; PendingHostMapKind = hard ? "bside" : "base"; }
			return GetDisplayName();
		}).ConfigureAwait(false);
		var hosted = await _net.HostAsync(lobbyName, playerName, string.IsNullOrEmpty(mapLocalId) ? null : mapHubId, string.IsNullOrEmpty(mapLocalId) ? null : mapName, hard).ConfigureAwait(false);
		if (hosted == null) throw new InvalidOperationException(_joinFailure ?? "the relay refused the lobby");
	}

	private async Task RunNet<T>(Func<Task<T>> work, string what)
	{
		try { await work().ConfigureAwait(false); }
		catch (Exception e) { RunOnMain(() => Debug.LogWarning("[MpNet] " + what + " failed: " + e.Message)); }
	}

	public void SendGameMessage(JObject payload)
	{
		if (CurrentLobbyId == 0) return;
		JsonObject o;
		try { o = JsonReader.Parse(payload.ToString(Newtonsoft.Json.Formatting.None)) as JsonObject; }
		catch (Exception) { return; }
		if (o != null) _net.SendGameMessage(o);
	}

	public void LeaveLobby()
	{
		_ = RunNet(async () => { await _net.LeaveAsync().ConfigureAwait(false); return 0; }, "leave");
		SetLobby(0, null);
		MpGhostManager.Clear();
		LastSnapshotPlayers.Clear();
		StatusText = "Connected";
		PendingMapHubId = null;
		PendingMapName = null;
		PendingLocalMapId = null;
		PendingBaseGameHard = null;
		PendingHostMapKind = null;
		MapDownloadError = null;
	}

	public void DownloadPendingMap()
	{
		if (MapDownloading || string.IsNullOrEmpty(PendingMapHubId)) return;
		var hubId = PendingMapHubId;
		MapDownloading = true;
		MapDownloadError = null;
		new Thread(() =>
		{
			try
			{
				MpMapLibrary.DownloadAndExtract(hubId);
				PendingMapHubId = null;
				PendingMapName = null;
				Host?.Events.Emit("recharge.maps.load_requested", hubId);
			}
			catch (System.Exception e) { MapDownloadError = e.Message; }
			finally { MapDownloading = false; }
		})
		{ IsBackground = true }.Start();
	}

	public void SendChat(string text)
	{
		if (string.IsNullOrWhiteSpace(text) || CurrentLobbyId == 0) return;
		_net.SendChat(text);
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

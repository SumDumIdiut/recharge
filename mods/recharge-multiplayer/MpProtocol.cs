using System.Collections.Generic;

// newline-delimited JSON over TCP via Newtonsoft.Json - UnityEngine.JsonUtility silently drops List<T> here

internal class MpStateMsg
{
	public string type = "state";
	public float x;
	public float y;
	public bool facingRight;
	public int animState;
	public float animSpeed;
	public bool isPaused;
	public string name;
	public string nameColor;
	public string dotColor;
}

internal class MpPlayerState
{
	public int id;
	public float x;
	public float y;
	public bool facingRight;
	public int animState;
	public float animSpeed;
	public bool isPaused;
	public string name;
	public string nameColor;
	public string dotColor;
}

internal class MpSnapshotMsg
{
	public string type;
	public List<MpPlayerState> players;
}

internal class MpHostMsg
{
	public string type = "host";
	public string name;
	public string playerName;
}

internal class MpJoinLobbyMsg
{
	public string type = "join_lobby";
	public int lobbyId;
	public string playerName;
}

internal class MpLobbyInfo
{
	public int id;
	public string name;
	public string hostName;
	public string hostColor;
	public int count;
}

internal class MpLobbyListMsg
{
	public string type;
	public List<MpLobbyInfo> lobbies;
}

internal class MpChatMsg
{
	public string type = "chat";
	public string text;
}

internal class MpChatHistoryEntry
{
	public string from;
	public string fromColor;
	public string text;
}

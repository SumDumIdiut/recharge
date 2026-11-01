using System;
using System.Collections.Generic;
using Recharge.Core.Json;

namespace Recharge.Net
{
    /// <summary>JSON helpers: tolerant reads, compact writes.</summary>
    internal static class J
    {
        public static string Str(JsonObject o, string k, string def = "")
            => o.TryGetValue(k, out var v) && v is JsonString s ? s.Value : def;
        public static string? StrOrNull(JsonObject o, string k)
            => o.TryGetValue(k, out var v) && v is JsonString s ? s.Value : null;
        public static double Num(JsonObject o, string k, double def = 0)
            => o.TryGetValue(k, out var v) && v is JsonNumber n ? n.AsDouble() : def;
        public static int Int(JsonObject o, string k, int def = 0)
            => o.TryGetValue(k, out var v) && v is JsonNumber n ? (int)n.AsDouble() : def;
        public static bool Bool(JsonObject o, string k, bool def = false)
            => o.TryGetValue(k, out var v) && v is JsonBool b ? b.Value : def;
        public static JsonString S(string? v) => new JsonString(v ?? "");
        public static JsonNumber N(double v) => JsonNumber.From(v);
        public static JsonNumber N(int v) => JsonNumber.From((long)v);
        public static JsonBool B(bool v) => v ? JsonBool.True : JsonBool.False;
        public static string Compact(JsonNode n) => JsonWriter.Write(n, 0);
    }

    /// <summary>A protocol frame: a JSON object with a "type".</summary>
    public abstract class NetMessage
    {
        public abstract string Type { get; }
        public abstract JsonObject ToJson();
        public string Serialize() => J.Compact(ToJson());
        protected JsonObject Start()
        {
            var o = new JsonObject();
            o["type"] = J.S(Type);
            return o;
        }

        /// <summary>Parses a server frame into its typed message; null for unknown types or malformed JSON.</summary>
        public static NetMessage? Parse(string text)
        {
            JsonObject? o;
            try { o = JsonReader.Parse(text) as JsonObject; }
            catch (JsonParseException) { return null; }
            if (o == null) return null;
            switch (J.Str(o, "type"))
            {
                case "welcome": return WelcomeMsg.FromJson(o);
                case "hosted": return HostedMsg.FromJson(o);
                case "joined": return JoinedMsg.FromJson(o);
                case "left": return new LeftMsg();
                case "join_failed": return JoinFailedMsg.FromJson(o);
                case "snapshot": return SnapshotMsg.FromJson(o);
                case "lobby_list": return LobbyListMsg.FromJson(o);
                case "game_msg": return GameMsgIn.FromJson(o);
                case "chat": return ChatIn.FromJson(o);
                // Client frames too, so a relay or test can read what the client wrote.
                case "host": return HostMsg.FromJson(o);
                case "join_lobby": return JoinLobbyMsg.FromJson(o);
                case "list_lobbies": return new ListLobbiesMsg();
                case "leave_lobby": return new LeaveLobbyMsg();
                case "state": return StateMsg.FromJson(o);
                case "hello": return HelloMsg.FromJson(o);
                default: return null;
            }
        }
    }

    // ---- client -> server ----

    public sealed class HostMsg : NetMessage
    {
        public override string Type => "host";
        public string Name = "";
        public string PlayerName = "";
        public string? MapHubId;
        public string? MapName;
        public bool Hard;
        public string Token = "";

        public override JsonObject ToJson()
        {
            var o = Start();
            o["name"] = J.S(Name);
            o["playerName"] = J.S(PlayerName);
            if (MapHubId != null) o["mapHubId"] = J.S(MapHubId);
            if (MapName != null) o["mapName"] = J.S(MapName);
            o["hard"] = J.B(Hard);
            o["token"] = J.S(Token);
            return o;
        }
        public static HostMsg FromJson(JsonObject o) => new HostMsg
        {
            Name = J.Str(o, "name"), PlayerName = J.Str(o, "playerName"),
            MapHubId = J.StrOrNull(o, "mapHubId"), MapName = J.StrOrNull(o, "mapName"),
            Hard = J.Bool(o, "hard"), Token = J.Str(o, "token"),
        };
    }

    public sealed class JoinLobbyMsg : NetMessage
    {
        public override string Type => "join_lobby";
        public int LobbyId;
        public string PlayerName = "";
        public override JsonObject ToJson()
        {
            var o = Start();
            o["lobbyId"] = J.N(LobbyId);
            o["playerName"] = J.S(PlayerName);
            return o;
        }
        public static JoinLobbyMsg FromJson(JsonObject o) => new JoinLobbyMsg { LobbyId = J.Int(o, "lobbyId"), PlayerName = J.Str(o, "playerName") };
    }

    public sealed class ListLobbiesMsg : NetMessage
    {
        public override string Type => "list_lobbies";
        public override JsonObject ToJson() => Start();
    }

    public sealed class LeaveLobbyMsg : NetMessage
    {
        public override string Type => "leave_lobby";
        public override JsonObject ToJson() => Start();
    }

    public sealed class StateMsg : NetMessage
    {
        public override string Type => "state";
        public double X, Y;
        public bool FacingRight;
        public int AnimState;
        public double AnimSpeed = 1;
        public bool IsPaused;
        public string Name = "";
        public string NameColor = NetText.DefaultNameColor;
        public string DotColor = NetText.DefaultDotColor;

        public override JsonObject ToJson()
        {
            var o = Start();
            o["x"] = J.N(X);
            o["y"] = J.N(Y);
            o["facingRight"] = J.B(FacingRight);
            o["animState"] = J.N(AnimState);
            o["animSpeed"] = J.N(AnimSpeed);
            o["isPaused"] = J.B(IsPaused);
            o["name"] = J.S(Name);
            o["nameColor"] = J.S(NameColor);
            o["dotColor"] = J.S(DotColor);
            return o;
        }
        public static StateMsg FromJson(JsonObject o) => new StateMsg
        {
            X = J.Num(o, "x"), Y = J.Num(o, "y"), FacingRight = J.Bool(o, "facingRight"),
            AnimState = J.Int(o, "animState"), AnimSpeed = J.Num(o, "animSpeed", 1), IsPaused = J.Bool(o, "isPaused"),
            Name = J.Str(o, "name"), NameColor = J.Str(o, "nameColor", NetText.DefaultNameColor), DotColor = J.Str(o, "dotColor", NetText.DefaultDotColor),
        };
    }

    /// <summary>Client game_msg: {"type":"game_msg","payload":{...}}.</summary>
    public sealed class GameMsgOut : NetMessage
    {
        public override string Type => "game_msg";
        public JsonObject Payload = new JsonObject();
        public override JsonObject ToJson()
        {
            var o = Start();
            o["payload"] = Payload;
            return o;
        }
    }

    public sealed class ChatOut : NetMessage
    {
        public override string Type => "chat";
        public string Text = "";
        public override JsonObject ToJson()
        {
            var o = Start();
            o["text"] = J.S(Text);
            return o;
        }
    }

    // ---- server -> client ----

    public sealed class WelcomeMsg : NetMessage
    {
        public override string Type => "welcome";
        public int Id;
        public override JsonObject ToJson() { var o = Start(); o["id"] = J.N(Id); return o; }
        public static WelcomeMsg FromJson(JsonObject o) => new WelcomeMsg { Id = J.Int(o, "id") };
    }

    public sealed class HostedMsg : NetMessage
    {
        public override string Type => "hosted";
        public int LobbyId;
        public string Name = "";
        public string? MapHubId;
        public string? MapName;
        public bool Hard;
        public override JsonObject ToJson()
        {
            var o = Start();
            o["lobbyId"] = J.N(LobbyId);
            o["name"] = J.S(Name);
            if (MapHubId != null) o["mapHubId"] = J.S(MapHubId);
            if (MapName != null) o["mapName"] = J.S(MapName);
            o["hard"] = J.B(Hard);
            return o;
        }
        public static HostedMsg FromJson(JsonObject o) => new HostedMsg
        {
            LobbyId = J.Int(o, "lobbyId"), Name = J.Str(o, "name"),
            MapHubId = J.StrOrNull(o, "mapHubId"), MapName = J.StrOrNull(o, "mapName"), Hard = J.Bool(o, "hard"),
        };
    }

    public sealed class ChatHistoryEntry
    {
        public string From = "";
        public string FromColor = "";
        public string Text = "";
        public JsonObject ToJson()
        {
            var o = new JsonObject();
            o["from"] = J.S(From);
            o["fromColor"] = J.S(FromColor);
            o["text"] = J.S(Text);
            return o;
        }
        public static ChatHistoryEntry FromJson(JsonObject o) => new ChatHistoryEntry { From = J.Str(o, "from"), FromColor = J.Str(o, "fromColor"), Text = J.Str(o, "text") };
    }

    public sealed class JoinedMsg : NetMessage
    {
        public override string Type => "joined";
        public int LobbyId;
        public string Name = "";
        public List<ChatHistoryEntry> History = new List<ChatHistoryEntry>();
        public string? MapHubId;
        public string? MapName;
        public bool Hard;
        public override JsonObject ToJson()
        {
            var o = Start();
            o["lobbyId"] = J.N(LobbyId);
            o["name"] = J.S(Name);
            var h = new JsonArray();
            foreach (var e in History) h.Add(e.ToJson());
            o["history"] = h;
            if (MapHubId != null) o["mapHubId"] = J.S(MapHubId);
            if (MapName != null) o["mapName"] = J.S(MapName);
            o["hard"] = J.B(Hard);
            return o;
        }
        public static JoinedMsg FromJson(JsonObject o)
        {
            var m = new JoinedMsg
            {
                LobbyId = J.Int(o, "lobbyId"), Name = J.Str(o, "name"),
                MapHubId = J.StrOrNull(o, "mapHubId"), MapName = J.StrOrNull(o, "mapName"), Hard = J.Bool(o, "hard"),
            };
            if (o.TryGetValue("history", out var h) && h is JsonArray arr)
                foreach (var e in arr) if (e is JsonObject eo) m.History.Add(ChatHistoryEntry.FromJson(eo));
            return m;
        }
    }

    public sealed class LeftMsg : NetMessage
    {
        public override string Type => "left";
        public override JsonObject ToJson() => Start();
    }

    public sealed class JoinFailedMsg : NetMessage
    {
        public override string Type => "join_failed";
        public string Reason = "";
        public override JsonObject ToJson() { var o = Start(); o["reason"] = J.S(Reason); return o; }
        public static JoinFailedMsg FromJson(JsonObject o) => new JoinFailedMsg { Reason = J.Str(o, "reason") };
    }

    public sealed class PlayerState
    {
        public int Id;
        public string Name = "";
        public string NameColor = NetText.DefaultNameColor;
        public string DotColor = NetText.DefaultDotColor;
        public double X, Y;
        public bool FacingRight;
        public int AnimState;
        public double AnimSpeed = 1;
        public bool IsPaused;

        public JsonObject ToJson()
        {
            var o = new JsonObject();
            o["id"] = J.N(Id);
            o["name"] = J.S(Name);
            o["nameColor"] = J.S(NameColor);
            o["dotColor"] = J.S(DotColor);
            o["x"] = J.N(X);
            o["y"] = J.N(Y);
            o["facingRight"] = J.B(FacingRight);
            o["animState"] = J.N(AnimState);
            o["animSpeed"] = J.N(AnimSpeed);
            o["isPaused"] = J.B(IsPaused);
            return o;
        }
        public static PlayerState FromJson(JsonObject o) => new PlayerState
        {
            Id = J.Int(o, "id"), Name = J.Str(o, "name"),
            NameColor = J.Str(o, "nameColor", NetText.DefaultNameColor), DotColor = J.Str(o, "dotColor", NetText.DefaultDotColor),
            X = J.Num(o, "x"), Y = J.Num(o, "y"), FacingRight = J.Bool(o, "facingRight"),
            AnimState = J.Int(o, "animState"), AnimSpeed = J.Num(o, "animSpeed", 1), IsPaused = J.Bool(o, "isPaused"),
        };
    }

    public sealed class SnapshotMsg : NetMessage
    {
        public override string Type => "snapshot";
        public List<PlayerState> Players = new List<PlayerState>();
        public override JsonObject ToJson()
        {
            var o = Start();
            var a = new JsonArray();
            foreach (var p in Players) a.Add(p.ToJson());
            o["players"] = a;
            return o;
        }
        public static SnapshotMsg FromJson(JsonObject o)
        {
            var m = new SnapshotMsg();
            if (o.TryGetValue("players", out var a) && a is JsonArray arr)
                foreach (var e in arr) if (e is JsonObject eo) m.Players.Add(PlayerState.FromJson(eo));
            return m;
        }
    }

    public sealed class LobbyInfo
    {
        public int Id;
        public string Name = "";
        public string HostName = "";
        public string HostColor = NetText.DefaultNameColor;
        public int Count;
        public bool Hard;
        public string? MapHubId;
        public string? MapName;

        public JsonObject ToJson()
        {
            var o = new JsonObject();
            o["id"] = J.N(Id);
            o["name"] = J.S(Name);
            o["hostName"] = J.S(HostName);
            o["hostColor"] = J.S(HostColor);
            o["count"] = J.N(Count);
            o["hard"] = J.B(Hard);
            if (MapHubId != null) o["mapHubId"] = J.S(MapHubId);
            if (MapName != null) o["mapName"] = J.S(MapName);
            return o;
        }
        public static LobbyInfo FromJson(JsonObject o) => new LobbyInfo
        {
            Id = J.Int(o, "id"), Name = J.Str(o, "name"), HostName = J.Str(o, "hostName"),
            HostColor = J.Str(o, "hostColor", NetText.DefaultNameColor), Count = J.Int(o, "count"), Hard = J.Bool(o, "hard"),
            MapHubId = J.StrOrNull(o, "mapHubId"), MapName = J.StrOrNull(o, "mapName"),
        };
    }

    public sealed class LobbyListMsg : NetMessage
    {
        public override string Type => "lobby_list";
        public List<LobbyInfo> Lobbies = new List<LobbyInfo>();
        public override JsonObject ToJson()
        {
            var o = Start();
            var a = new JsonArray();
            foreach (var l in Lobbies) a.Add(l.ToJson());
            o["lobbies"] = a;
            return o;
        }
        public static LobbyListMsg FromJson(JsonObject o)
        {
            var m = new LobbyListMsg();
            if (o.TryGetValue("lobbies", out var a) && a is JsonArray arr)
                foreach (var e in arr) if (e is JsonObject eo) m.Lobbies.Add(LobbyInfo.FromJson(eo));
            return m;
        }
    }

    /// <summary>Fan-out game_msg: {"type":"game_msg","from":1,"payload":{...}}.</summary>
    public sealed class GameMsgIn : NetMessage
    {
        public override string Type => "game_msg";
        public int From;
        public JsonObject Payload = new JsonObject();
        public string Kind => J.Str(Payload, "k");
        public override JsonObject ToJson()
        {
            var o = Start();
            o["from"] = J.N(From);
            o["payload"] = Payload;
            return o;
        }
        public static GameMsgIn FromJson(JsonObject o) => new GameMsgIn
        {
            From = J.Int(o, "from"),
            Payload = o.TryGetValue("payload", out var p) && p is JsonObject po ? po : new JsonObject(),
        };
    }

    public sealed class ChatIn : NetMessage
    {
        public override string Type => "chat";
        public string From = "";
        public string FromColor = "";
        public string Text = "";
        public override JsonObject ToJson()
        {
            var o = Start();
            o["from"] = J.S(From);
            o["fromColor"] = J.S(FromColor);
            o["text"] = J.S(Text);
            return o;
        }
        public static ChatIn FromJson(JsonObject o) => new ChatIn { From = J.Str(o, "from"), FromColor = J.Str(o, "fromColor"), Text = J.Str(o, "text") };
    }

    // ---- v2 handshake preparation (types only; the relay does not speak v2 yet) ----

    public sealed class HelloMsg : NetMessage
    {
        public const int ProtocolVersion = 2;
        public override string Type => "hello";
        public int Protocol = ProtocolVersion;
        public string MapId = "";
        public int Revision;
        public string ManifestHash = "";
        public MapVersion Map => new MapVersion(MapId, Revision, ManifestHash);
        public override JsonObject ToJson()
        {
            var o = Start();
            o["protocol"] = J.N(Protocol);
            o["mapId"] = J.S(MapId);
            o["revision"] = J.N(Revision);
            o["manifestHash"] = J.S(ManifestHash);
            return o;
        }
        public static HelloMsg FromJson(JsonObject o) => new HelloMsg
        {
            Protocol = J.Int(o, "protocol", ProtocolVersion), MapId = J.Str(o, "mapId"),
            Revision = J.Int(o, "revision"), ManifestHash = J.Str(o, "manifestHash"),
        };
    }

    public enum MapMatch
    {
        /// <summary>Same map, revision and manifest.</summary>
        Same,
        /// <summary>Different map ids.</summary>
        DifferentMap,
        /// <summary>Same map, ours is older: we must update.</summary>
        LocalOlder,
        /// <summary>Same map, ours is newer: the peer must update.</summary>
        LocalNewer,
        /// <summary>Same revision number but different content.</summary>
        HashMismatch,
    }

    public readonly struct MapVersion : IEquatable<MapVersion>
    {
        public string MapId { get; }
        public int Revision { get; }
        public string ManifestHash { get; }
        public MapVersion(string mapId, int revision, string manifestHash)
        {
            MapId = mapId ?? ""; Revision = revision; ManifestHash = manifestHash ?? "";
        }

        public MapMatch Compare(MapVersion other)
        {
            if (!string.Equals(MapId, other.MapId, StringComparison.Ordinal)) return MapMatch.DifferentMap;
            if (Revision < other.Revision) return MapMatch.LocalOlder;
            if (Revision > other.Revision) return MapMatch.LocalNewer;
            return string.Equals(ManifestHash, other.ManifestHash, StringComparison.OrdinalIgnoreCase) ? MapMatch.Same : MapMatch.HashMismatch;
        }

        public bool Equals(MapVersion o) => Compare(o) == MapMatch.Same;
        public override bool Equals(object? obj) => obj is MapVersion m && Equals(m);
        public override int GetHashCode() => (MapId.GetHashCode() * 397) ^ Revision;
    }
}

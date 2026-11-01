using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Recharge.Server
{
    /// <summary>Extended profiles: stored as validated canonical JSON, served with the owner's privacy choices applied.</summary>
    public sealed partial class SocialService
    {
        private readonly RateLimiter _profileLimit;
        private const int MaxBatchNames = 50;
        private const int MaxFriendNames = 24;

        private JsonObject? StoredProfile(string key)
        {
            if (!_profiles.TryGet(key, out ProfileRec? rec) || rec.Version != ProfileSchema.Version) return null;   // a future schema version would be migrated here
            try { return JsonNode.Parse(rec.Json) as JsonObject; }
            catch (JsonException) { return null; }
        }

        private static JsonObject Pick(JsonObject source, params string[] names)
        {
            var result = new JsonObject();
            foreach (string n in names) if (source[n] is JsonNode v) result[n] = v.DeepClone();
            return result;
        }

        private static string PrivacyOf(JsonObject profile, string field) => ((JsonObject)profile["privacy"]!)[field]!.GetValue<string>();

        /// <summary>The part of a profile anybody may see: how the name and picture look, and the accent colour.</summary>
        private static JsonObject StyleOnly(JsonObject profile) => new JsonObject
        {
            ["v"] = ProfileSchema.Version,
            ["name"] = profile["name"]!.DeepClone(),
            ["avatar"] = profile["avatar"]!.DeepClone(),
            ["theme"] = Pick((JsonObject)profile["theme"]!, "accent"),
        };

        private void DropExpiredStatus(JsonObject profile)
        {
            var status = (JsonObject)((JsonObject)profile["content"]!)["status"]!;
            long expires = status["expires"]!.GetValue<long>();
            if (expires > 0 && expires <= _o.Clock().ToUnixTimeSeconds())
            {
                status["emoji"] = ""; status["text"] = ""; status["expires"] = 0;
            }
        }

        /// <summary>One profile as <paramref name="viewer"/> (null: signed out) may see it.</summary>
        public object GetProfile(string? viewerName, string targetName)
        {
            lock (_gate)
            {
                string t = Norm(targetName);
                string? v = viewerName is null ? null : Norm(viewerName);
                bool self = v == t;
                JsonObject? stored = StoredProfile(t);
                if (stored is null) return new { username = Display(t), profile = (object?)null, restricted = false };
                if (self) stored["privacy"]!["presence"] = SettingsOf(t).Invisible ? "nobody" : "friends";
                DropExpiredStatus(stored);
                bool friend = v is not null && AreFriends(v, t) && !IsBlocked(v, t);
                bool restricted = !self && PrivacyOf(stored, "profile") == "friends" && !friend;
                var reply = new JsonObject { ["username"] = Display(t), ["restricted"] = restricted };
                reply["profile"] = restricted ? StyleOnly(stored) : stored;
                if (!restricted)
                {
                    string who = PrivacyOf(stored, "friends");
                    if (self || who == "everyone" || (who == "friends" && friend))
                    {
                        List<string> friends = FriendsOf(t).Where(f => v is null || !IsBlocked(v, f)).OrderBy(f => Display(f), StringComparer.OrdinalIgnoreCase).Select(Display).ToList();
                        reply["friendCount"] = friends.Count;
                        var names = new JsonArray();
                        foreach (string f in friends.Take(MaxFriendNames)) names.Add(f);
                        reply["friends"] = names;
                    }
                }
                return reply;
            }
        }

        /// <summary>The look of many names at once (for name chips): only users with a profile are listed. Nothing private is in it.</summary>
        public object GetProfileStyles(IEnumerable<string> names)
        {
            lock (_gate)
            {
                var list = new JsonArray();
                foreach (string raw in names.Where(n => ValidName(n)).Select(Norm).Distinct().Take(MaxBatchNames))
                {
                    JsonObject? stored = StoredProfile(raw);
                    if (stored is null) continue;
                    JsonObject style = StyleOnly(stored);
                    style["username"] = Display(raw);
                    list.Add(style);
                }
                return new JsonObject { ["profiles"] = list };
            }
        }

        /// <summary>Styles that belong to one player (lower-case username): nobody else may save them (ui-src/profile/exclusive.ts).</summary>
        public static readonly IReadOnlyDictionary<string, string> ExclusiveFrames = new Dictionary<string, string> { ["x-flipped-signature"] = "flipped", ["x-flipped-frost"] = "flipped" };
        public static readonly IReadOnlyDictionary<string, string> ExclusiveAnims = new Dictionary<string, string> { ["signature"] = "flipped", ["frostfall"] = "flipped" };
        public static readonly IReadOnlyDictionary<string, string> ExclusivePresets = new Dictionary<string, string> { ["flipped-signature"] = "flipped", ["flipped-frost"] = "flipped" };

        public static void CheckExclusive(JsonObject canon, string meName)
        {
            string me = (meName ?? "").Trim().ToLowerInvariant();
            string? frame = (canon["avatar"] as JsonObject)?["frame"]?.GetValue<string>();
            string? anim = (canon["banner"] as JsonObject)?["anim"]?.GetValue<string>();
            string? preset = (canon["theme"] as JsonObject)?["preset"]?.GetValue<string>();
            if ((preset != null && ExclusivePresets.TryGetValue(preset, out string? po) && po != me) ||
                (frame != null && ExclusiveFrames.TryGetValue(frame, out string? fo) && fo != me) ||
                (anim != null && ExclusiveAnims.TryGetValue(anim, out string? ao) && ao != me))
                throw new SocialException(403, "That style belongs to another player.");
        }

        public object PutProfile(string meName, JsonElement body)
        {
            if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("profile", out JsonElement inner) && body.EnumerateObject().Count() == 1) body = inner;
            JsonObject canon = ProfileSchema.Validate(body);   // validate before taking the rate limit slot or the lock
            CheckExclusive(canon, meName);
            lock (_gate)
            {
                string me = Norm(meName);
                _profileLimit.Hit(me, "You are saving your profile too often.");
                _profiles.Put(me, new ProfileRec { Json = canon.ToJsonString(), Version = ProfileSchema.Version, Updated = _o.Clock().ToUnixTimeSeconds() });
                bool hide = PrivacyOf(canon, "presence") == "nobody";
                if (SettingsOf(me).Invisible != hide) PutSettings(meName, null, hide);
                return new JsonObject { ["username"] = Display(me), ["profile"] = canon, ["restricted"] = false };
            }
        }

        public object DeleteProfile(string meName)
        {
            lock (_gate)
            {
                _profiles.Remove(Norm(meName));
                return new { ok = true };
            }
        }
    }
}

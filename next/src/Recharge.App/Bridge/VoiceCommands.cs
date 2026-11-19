using System;
using System.Threading.Tasks;
using Recharge.App.Native;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>
    /// Native voice for hosts without WebRTC. State (connected, roster, speaking, errors) is delivered as
    /// voice.native.state frames on the social event feed, which the page already polls via social.events.
    /// </summary>
    public static class VoiceCommands
    {
        public static void Register(CommandRegistry registry) => Register(registry, () => NativeVoice.Instance);

        public static void Register(CommandRegistry registry, Func<NativeVoice> voice)
        {
            if (registry is null) throw new ArgumentNullException(nameof(registry));
            if (voice is null) throw new ArgumentNullException(nameof(voice));

            registry.Register("voice.native.join", async args =>
            {
                string conv = Text(args, "convId");
                if (string.IsNullOrEmpty(conv)) conv = Text(args, "channelId");
                await voice().JoinAsync(conv, Text(args, "kind"), Text(args, "username")).ConfigureAwait(false);
                return Ok();
            });
            registry.Register("voice.native.leave", args =>
            {
                voice().Leave();
                return Task.FromResult<JsonNode>(Ok());
            });
            registry.Register("voice.native.mute", args =>
            {
                voice().SetMute(Bool(args, "muted"));
                return Task.FromResult<JsonNode>(Ok());
            });
            registry.Register("voice.native.deafen", args =>
            {
                voice().SetDeafened(Bool(args, "deafened"));
                return Task.FromResult<JsonNode>(Ok());
            });
        }

        private static JsonObject Ok()
        {
            var result = new JsonObject();
            result["ok"] = JsonBool.True;
            return result;
        }

        private static string Text(JsonObject args, string key) =>
            args.TryGetValue(key, out JsonNode node) && node is JsonString s ? s.Value : string.Empty;

        private static bool Bool(JsonObject args, string key) =>
            args.TryGetValue(key, out JsonNode node) && node is JsonBool b && b.Value;
    }
}

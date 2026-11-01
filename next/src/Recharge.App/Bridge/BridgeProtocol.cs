using System;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>A parsed <c>{id, cmd, args}</c> bridge message.</summary>
    public sealed class BridgeRequest
    {
        public string IdJson { get; }
        public string Command { get; }
        public JsonObject Args { get; }

        private BridgeRequest(string idJson, string command, JsonObject args)
        {
            IdJson = idJson;
            Command = command;
            Args = args;
        }

        public static bool TryParse(string raw, out BridgeRequest? request, out string? error)
        {
            request = null;
            error = null;

            JsonNode root;
            try
            {
                root = JsonReader.Parse(raw);
            }
            catch (Exception ex)
            {
                error = "invalid JSON: " + ex.Message;
                return false;
            }

            if (root is not JsonObject obj)
            {
                error = "message must be a JSON object";
                return false;
            }

            if (!obj.TryGetValue("id", out JsonNode? idNode) ||
                (idNode is not JsonNumber && idNode is not JsonString))
            {
                error = "message id must be a number or string";
                return false;
            }

            if (!obj.TryGetValue("cmd", out JsonNode? cmdNode) || cmdNode is not JsonString cmd ||
                string.IsNullOrEmpty(cmd.Value))
            {
                error = "message cmd must be a non-empty string";
                return false;
            }

            JsonObject args;
            if (obj.TryGetValue("args", out JsonNode? argsNode))
            {
                if (argsNode is JsonNull)
                {
                    args = new JsonObject();
                }
                else if (argsNode is JsonObject argsObject)
                {
                    args = argsObject;
                }
                else
                {
                    error = "message args must be an object";
                    return false;
                }
            }
            else
            {
                args = new JsonObject();
            }

            request = new BridgeRequest(JsonWriter.Write(idNode, 0), cmd.Value, args);
            return true;
        }
    }

    /// <summary>The reply to send back to a page promise.</summary>
    public sealed class BridgeReply
    {
        public string IdJson { get; }
        public bool Ok { get; }
        public JsonNode Payload { get; }

        public BridgeReply(string idJson, bool ok, JsonNode payload)
        {
            IdJson = idJson;
            Ok = ok;
            Payload = payload;
        }

        public string ToScript()
        {
            string json = JsonWriter.Write(Payload, 0);
            return "window.__rechargeReply(" + IdJson + ", " + (Ok ? "true" : "false") +
                   ", " + JsLiteral.Quote(json) + ");";
        }
    }
}

using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    public delegate Task<JsonNode> CommandHandler(JsonObject args);

    /// <summary>A small registry so later tasks can add bridge commands.</summary>
    public sealed class CommandRegistry
    {
        private readonly Dictionary<string, CommandHandler> _handlers =
            new Dictionary<string, CommandHandler>(StringComparer.Ordinal);

        public CommandRegistry Register(string name, CommandHandler handler)
        {
            if (string.IsNullOrEmpty(name))
            {
                throw new ArgumentException("Command name is required.", nameof(name));
            }
            _handlers[name] = handler ?? throw new ArgumentNullException(nameof(handler));
            return this;
        }

        public bool TryGet(string name, out CommandHandler handler) =>
            _handlers.TryGetValue(name, out handler!);
    }

    /// <summary>Parses bridge messages and dispatches them to registered commands.</summary>
    public sealed class BridgeDispatcher
    {
        private readonly CommandRegistry _commands;

        public event Action? Ready;
        public event Action<string, string>? Log;

        public BridgeDispatcher(CommandRegistry commands)
        {
            _commands = commands ?? throw new ArgumentNullException(nameof(commands));
        }

        public async Task<BridgeReply?> DispatchAsync(string raw)
        {
            if (!BridgeRequest.TryParse(raw, out BridgeRequest? request, out _) || request is null)
            {
                return null;
            }

            if (request.Command == "__ready")
            {
                Ready?.Invoke();
                return null;
            }

            if (request.Command == "__log")
            {
                string level = ReadString(request.Args, "level") ?? "log";
                string message = ReadString(request.Args, "message") ?? string.Empty;
                Log?.Invoke(level, message);
                return null;
            }

            if (!_commands.TryGet(request.Command, out CommandHandler handler))
            {
                return new BridgeReply(request.IdJson, false, Error("unknown command"));
            }

            try
            {
                JsonNode payload = await handler(request.Args).ConfigureAwait(false);
                return new BridgeReply(request.IdJson, true, payload);
            }
            catch (Exception ex)
            {
                return new BridgeReply(request.IdJson, false, Error(ex.Message));
            }
        }

        internal static JsonObject Error(string message)
        {
            var obj = new JsonObject();
            obj["error"] = new JsonString(message);
            return obj;
        }

        private static string? ReadString(JsonObject args, string key) =>
            args.TryGetValue(key, out JsonNode node) && node is JsonString value ? value.Value : null;
    }
}

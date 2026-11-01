using System;
using System.IO;
using System.Threading.Tasks;
using Recharge.Core.Json;
using Recharge.Link;
using Recharge.Link.Game;

namespace Recharge.App.Game
{
    /// <summary>Starts the game process. The real one asks Steam; tests use a fake that connects a LinkClient in-process.</summary>
    public interface IGameLauncher
    {
        void Launch(string gameDir, string appId, string linkEnvironmentValue);
    }

    /// <summary>The app's side of one game run: owns the LinkServer, starts the game with RECHARGE_LINK, and delivers intents (queued until the game connects).</summary>
    public sealed class GameSession : IDisposable
    {
        public static readonly TimeSpan IntentTimeout = TimeSpan.FromSeconds(30);

        private readonly Func<string?> _findGame;
        private readonly IGameLauncher _launcher;
        private readonly LinkOptions? _options;
        private readonly Func<string, bool, string>? _switchBuild;
        private readonly object _gate = new object();
        private LinkServer? _server;
        private (string Kind, JsonNode? Args)? _pending;
        private bool _disposed;

        /// <param name="switchBuild">Deploys the vanilla (false) or modded (true) build in the game folder before a launch; returns a detail line.</param>
        public GameSession(Func<string?> findGame, IGameLauncher launcher, LinkOptions? options = null, Func<string, bool, string>? switchBuild = null)
        {
            _findGame = findGame;
            _launcher = launcher;
            _options = options;
            _switchBuild = switchBuild;
        }

        public LinkServer? Server { get { lock (_gate) return _server; } }

        public bool IsRunning { get { lock (_gate) return _server != null && _server.IsConnected; } }

        /// <summary>The latest state the game reported (lobby, map, ...) plus running (bool, true while connected).</summary>
        public JsonObject State()
        {
            var o = new JsonObject();
            LinkServer? s = Server;
            if (s != null) foreach (var kv in s.State) o[kv.Key] = kv.Value;
            // "running" is always a bool: true only while a game is connected to the app.
            o["running"] = IsRunning ? JsonBool.True : JsonBool.False;
            return o;
        }

        /// <summary>The Steam appid in the game folder's steam_appid.txt; null when missing or not a number.</summary>
        public static string? ReadAppId(string gameDir)
        {
            try
            {
                string text = File.ReadAllText(Path.Combine(gameDir, "steam_appid.txt")).Trim();
                return text.Length > 0 && text.Length <= 12 && IsDigits(text) ? text : null;
            }
            catch (Exception) { return null; }
        }

        private static bool IsDigits(string s)
        {
            foreach (char c in s) if (c < '0' || c > '9') return false;
            return true;
        }

        /// <summary>
        /// game.launch: when the game is already connected only the intent is sent; otherwise the build is switched when asked (modded or
        /// vanilla), the game is started, and the intent is sent as soon as it connects. Returns {launched, intent?, build?}.
        /// </summary>
        public async Task<JsonObject> LaunchAsync(string? intentKind, JsonNode? intentArgs, bool? modded = null)
        {
            LinkServer server;
            bool alreadyRunning;
            lock (_gate)
            {
                if (_disposed) throw new ObjectDisposedException(nameof(GameSession));
                if (_server == null)
                {
                    _server = new LinkServer(_options);
                    _server.Start();
                    _server.Connected += OnConnected;
                }
                server = _server;
                alreadyRunning = server.IsConnected;
                if (!alreadyRunning && intentKind != null) _pending = (intentKind, intentArgs);
            }

            var result = new JsonObject();
            if (alreadyRunning)
            {
                result["launched"] = JsonBool.False;
                if (intentKind != null) result["intent"] = AckJson(await server.SendIntentAsync(intentKind, intentArgs, IntentTimeout).ConfigureAwait(false));
                return result;
            }

            string game = _findGame() ?? throw new InvalidOperationException("io: IGTAP wasn't found");
            string appId = ReadAppId(game) ?? throw new InvalidOperationException("io: no steam_appid.txt in the game folder");
            if (modded != null && _switchBuild != null)
            {
                try { result["build"] = new JsonString(_switchBuild(game, modded.Value)); }
                catch
                {
                    lock (_gate) _pending = null;
                    throw;
                }
            }
            LinkLaunchFile.Write(game, server.EnvironmentValue);
            _launcher.Launch(game, appId, server.EnvironmentValue);
            result["launched"] = JsonBool.True;
            return result;
        }

        /// <summary>game.intent: sends to a connected game; throws when none is connected.</summary>
        public async Task<JsonObject> SendIntentAsync(string kind, JsonNode? args)
        {
            LinkServer? s = Server;
            if (s == null || !s.IsConnected) throw new InvalidOperationException("game: the game isn't running");
            return AckJson(await s.SendIntentAsync(kind, args, IntentTimeout).ConfigureAwait(false));
        }

        private void OnConnected()
        {
            (string Kind, JsonNode? Args)? pending;
            LinkServer? server;
            lock (_gate) { pending = _pending; _pending = null; server = _server; }
            if (pending == null || server == null) return;
            _ = server.SendIntentAsync(pending.Value.Kind, pending.Value.Args, IntentTimeout);
        }

        private static JsonObject AckJson(IntentAck ack)
        {
            var o = new JsonObject();
            o["ok"] = ack.Ok ? JsonBool.True : JsonBool.False;
            if (ack.Error != null) o["error"] = new JsonString(ack.Error);
            return o;
        }

        public void Dispose()
        {
            LinkServer? s;
            lock (_gate) { _disposed = true; s = _server; _server = null; }
            s?.Dispose();
        }
    }
}

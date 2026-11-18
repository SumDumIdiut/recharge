using System;
using System.Threading;
using System.Threading.Tasks;

namespace Recharge.Relay
{
    internal static class Program
    {
        private static async Task Main(string[] args)
        {
            var opts = new RelayOptions();
            var portEnv = Environment.GetEnvironmentVariable("PORT"); // the deployment convention; RELAY_PORT wins when both are set
            if (!string.IsNullOrEmpty(portEnv) && int.TryParse(portEnv, out var pPort)) opts.Port = pPort;
            opts.ApplyEnvironment();
            if (args.Length > 0 && int.TryParse(args[0], out var argPort)) opts.Port = argPort;
            var server = new RelayServer(opts);
            await server.StartAsync();
            Console.WriteLine($"IGTAP multiplayer relay (WebSocket) listening on :{server.Port} (members/lobby {opts.MaxLobbyMembers}, per-ip {opts.MaxConnectionsPerIp})");

            using var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (s, e) => { e.Cancel = true; cts.Cancel(); };
            try { await Task.Delay(Timeout.Infinite, cts.Token); }
            catch (TaskCanceledException) { }
            await server.StopAsync();
        }
    }
}
using System;
using System.Threading;
using System.Threading.Tasks;

namespace Recharge.Relay
{
    internal static class Program
    {
        private static async Task Main(string[] args)
        {
            var portEnv = Environment.GetEnvironmentVariable("PORT");
            var opts = new RelayOptions();
            if (!string.IsNullOrEmpty(portEnv) && int.TryParse(portEnv, out var p)) opts.Port = p;
            var server = new RelayServer(opts);
            await server.StartAsync();
            Console.WriteLine($"IGTAP multiplayer relay (WebSocket) listening on :{server.Port}");

            using var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (s, e) => { e.Cancel = true; cts.Cancel(); };
            try { await Task.Delay(Timeout.Infinite, cts.Token); }
            catch (TaskCanceledException) { }
            await server.StopAsync();
        }
    }
}
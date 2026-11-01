using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Recharge.Server
{
    internal static class Program
    {
        private static async Task<int> Main(string[] args)
        {
            if (args.Length >= 1 && args[0] == "--demo") return await Demo.Run(args).ConfigureAwait(false);

            var options = new SocialOptions
            {
                DataDir = Environment.GetEnvironmentVariable("RECHARGE_SOCIAL_DATA") ?? "data",
                Host = Environment.GetEnvironmentVariable("RECHARGE_SOCIAL_HOST") ?? "*",
            };
            if (int.TryParse(Environment.GetEnvironmentVariable("PORT"), out int port)) options.Port = port;
            string hubBase = Environment.GetEnvironmentVariable("RECHARGE_HUB_BASE") ?? "https://codecade.co.za/recharge";

            // Flags override the environment: --port N, --host H, --data DIR, --hub URL.
            bool exitOnStdinEof = false;
            for (int i = 0; i < args.Length; i += 2)
            {
                if (args[i] == "--exit-on-stdin-eof") { exitOnStdinEof = true; i--; continue; }   // set by the hub that supervises us
                if (i + 1 >= args.Length) { Console.Error.WriteLine("social: missing value for " + args[i]); return 2; }
                switch (args[i])
                {
                    case "--port" when int.TryParse(args[i + 1], out int p): options.Port = p; break;
                    case "--host": options.Host = args[i + 1]; break;
                    case "--data": options.DataDir = args[i + 1]; break;
                    case "--hub": hubBase = args[i + 1]; break;
                    default: Console.Error.WriteLine("social: unknown argument " + args[i]); return 2;
                }
            }

            // Private downloads: R2 (settings read from r2.env at the first download), unless a test key is set.
            IShareSigner signer = new R2ShareSigner(() => R2Config.Load());
            string? testKey = Environment.GetEnvironmentVariable("RECHARGE_SHARE_TEST_KEY");
            if (!string.IsNullOrEmpty(testKey))
            {
                signer = new TestShareSigner(testKey!);
                Console.Error.WriteLine("social: using the TEST share signer (links are not real downloads).");
            }

            var hub = new HttpHubDirectory(hubBase, options.AuthCache, options.Clock);
            using var server = new SocialServer(options, hub, signer);
            server.Start();
            Console.WriteLine("Recharge social server listening on :" + server.Port + " (hub " + hubBase + ", data " + Path.GetFullPath(options.DataDir) + ")");

            using var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (s, e) => { e.Cancel = true; cts.Cancel(); };
            AppDomain.CurrentDomain.ProcessExit += (s, e) => { try { cts.Cancel(); } catch (ObjectDisposedException) { } };
            if (exitOnStdinEof)
            {
                // The hub holds our stdin open; when it exits (however it dies) the pipe closes and so do we.
                _ = Task.Run(() => { try { while (Console.In.Read() >= 0) { } } catch (IOException) { } try { cts.Cancel(); } catch (ObjectDisposedException) { } });
            }
            try { await Task.Delay(Timeout.Infinite, cts.Token).ConfigureAwait(false); }
            catch (TaskCanceledException) { }
            return 0;
        }
    }
}

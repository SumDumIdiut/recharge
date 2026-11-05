using System;
using Recharge.App.Native;

namespace Recharge.App
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            AppOptions options;
            try
            {
                options = AppOptions.Parse(args);
            }
            catch (ArgumentException ex)
            {
                Console.Error.WriteLine(ex.Message);
                Console.Error.WriteLine(AppOptions.Usage);
                return 2;
            }

            if (options.Help)
            {
                Console.WriteLine(AppOptions.Usage);
                return 0;
            }

            Bridge.PerfConfig.Sequence = options.RouteSequence;

            // Updates: swap in a downloaded version, or roll back one that never confirmed a start, then restart into it.
            // Not for snapshot runs (tests) or when RECHARGE_NO_UPDATE is set.
            // Never for a development build (run from the project's bin/ folder): it must not replace its own build output.
            bool updates = !options.IsSnapshot && options.RouteSequence.Length == 0 && Environment.GetEnvironmentVariable("RECHARGE_NO_UPDATE") != "1" && !Updates.UpdateRules.IsDevBuild();
            if (updates)
            {
                try
                {
                    var start = Updates.Updater.Startup(Bridge.UpdateCommands.AppDir(), Settings.SettingsStore.DataDir());
                    if (start.Action != Updates.StartupAction.None)
                    {
                        Restart(start.Action == Updates.StartupAction.Applied ? start.Launch : "", args);
                        return 0;
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("update step skipped: " + ex.Message); // never block the app from starting
                }
            }

            if (OperatingSystem.IsWindows())
            {
                // Windows: a plain Win32 window hosting WebView2 (see Windows/WindowsShell.cs)
                try { return Windows.WindowsShell.Run(options, updates); }
                catch (Exception ex) { Console.Error.WriteLine("startup failed: " + ex); return 4; }
            }

            Gtk.gtk_init(IntPtr.Zero, IntPtr.Zero);

            AppShell shell;
            try
            {
                shell = AppShell.Create(options);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("startup failed: " + ex);
                return 4;
            }

            SnapshotController? snapshot = null;
            if (options.IsSnapshot)
            {
                snapshot = new SnapshotController(options.SnapshotPath!, options.TimeoutSeconds);
                shell.Bridge.Ready += snapshot.NotifyReady;
                snapshot.Start(shell.View);
            }

            string route = options.Route;
            if (route.Length > 0 && !route.StartsWith("#", StringComparison.Ordinal))
            {
                route = "#" + route;
            }
            if (updates)
            {
                // The UI came up: this version started fine, so it's kept (without this it's rolled back on the next start).
                shell.Bridge.Ready += () =>
                {
                    try { Updates.Updater.Confirm(Settings.SettingsStore.DataDir()); }
                    catch (Exception ex) { Console.Error.WriteLine("update confirm failed: " + ex.Message); }
                };
            }
            if (Bridge.PerfConfig.Enabled && options.EvalLog) Console.WriteLine("[console.log] [perf] load-uri t=" + Bridge.PerfConfig.UptimeMs());
            shell.Load("recharge://app/index.html" + route);

            Gtk.gtk_main();

            return snapshot?.ExitCode ?? 0;
        }

        /// <summary>Starts the app again (the given launch path inside the app folder, else this executable) with the same arguments.</summary>
        private static void Restart(string launch, string[] args)
        {
            string exe = !string.IsNullOrEmpty(launch) ? System.IO.Path.Combine(Bridge.UpdateCommands.AppDir(), launch)
                : Environment.ProcessPath ?? throw new InvalidOperationException("no executable path to restart");
            var info = new System.Diagnostics.ProcessStartInfo(exe) { UseShellExecute = false };
            foreach (string a in args) info.ArgumentList.Add(a);
            System.Diagnostics.Process.Start(info);
        }
    }
}

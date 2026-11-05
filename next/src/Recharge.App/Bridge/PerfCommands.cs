using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using Recharge.App.Native;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>
    /// Dev-only timing harness (RECHARGE_PERF=1, or --route-sequence): the page logs "[perf]" marks through the console relay, which
    /// stamps each with the process uptime; perf.done prints the memory of the app and its child processes and quits.
    /// </summary>
    public static class PerfConfig
    {
        public static string[] Sequence { get; set; } = Array.Empty<string>();
        public static bool Enabled => Environment.GetEnvironmentVariable("RECHARGE_PERF") == "1" || Sequence.Length > 0;

        /// <summary>Milliseconds since this process started.</summary>
        public static long UptimeMs()
        {
            try { return (long)(DateTime.Now - Process.GetCurrentProcess().StartTime).TotalMilliseconds; }
            catch (Exception) { return -1; }
        }
    }

    public static class PerfCommands
    {
        private static readonly GSourceFunc QuitCallback = OnQuit;

        public static void Register(CommandRegistry registry)
        {
            registry.Register("app.perf", args =>
            {
                var result = new JsonObject();
                result["enabled"] = PerfConfig.Enabled ? JsonBool.True : JsonBool.False;
                var seq = new JsonArray();
                foreach (string route in PerfConfig.Sequence) seq.Add(new JsonString(route));
                result["sequence"] = seq;
                return Task.FromResult<JsonNode>(result);
            });
            registry.Register("perf.done", args =>
            {
                if (!PerfConfig.Enabled) return Task.FromResult<JsonNode>(new JsonObject());
                Console.WriteLine("[perf-mem] t=" + PerfConfig.UptimeMs() + " " + MemoryReport());
                if (OperatingSystem.IsLinux()) GLib.g_idle_add(QuitCallback, IntPtr.Zero);
                else Environment.Exit(0);
                return Task.FromResult<JsonNode>(new JsonObject());
            });
        }

        private static int OnQuit(IntPtr data)
        {
            Gtk.gtk_main_quit();
            return 0;
        }

        /// <summary>"self=KB children=name:KB,..." from /proc (Linux); empty elsewhere.</summary>
        private static string MemoryReport()
        {
            if (!OperatingSystem.IsLinux()) return "unsupported";
            int self = Environment.ProcessId;
            var parts = new List<string> { "self=" + RssKb(self) };
            var all = new Dictionary<int, int>();
            foreach (string dir in Directory.GetDirectories("/proc"))
            {
                if (!int.TryParse(Path.GetFileName(dir), out int pid)) continue;
                try
                {
                    string stat = File.ReadAllText(Path.Combine(dir, "stat"));
                    int close = stat.LastIndexOf(')');
                    string[] rest = stat.Substring(close + 2).Split(' ');
                    all[pid] = int.Parse(rest[1]);
                }
                catch (Exception) { /* gone or unreadable */ }
            }
            var seen = new HashSet<int> { self };
            bool grew = true;
            while (grew)
            {
                grew = false;
                foreach (var kv in all) if (!seen.Contains(kv.Key) && seen.Contains(kv.Value)) { seen.Add(kv.Key); grew = true; }
            }
            seen.Remove(self);
            foreach (int pid in seen)
            {
                string name = "?";
                try { name = File.ReadAllText("/proc/" + pid + "/comm").Trim(); } catch (Exception) { }
                parts.Add(name + "=" + RssKb(pid));
            }
            return string.Join(" ", parts);
        }

        private static long RssKb(int pid)
        {
            try
            {
                foreach (string line in File.ReadLines("/proc/" + pid + "/status"))
                    if (line.StartsWith("VmRSS:", StringComparison.Ordinal))
                        return long.Parse(line.Substring(6).Trim().Split(' ')[0]);
            }
            catch (Exception) { /* gone */ }
            return -1;
        }
    }
}

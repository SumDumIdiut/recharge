using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Recharge.Core.Json;
using Recharge.Core.Models;

namespace Recharge.Loader.Core
{
    public static class ModDiscovery
    {
        public static readonly RechargeVersion DefaultLoaderVersion = RechargeVersion.Parse("1.0.0");

        public static IReadOnlyList<DiscoveredMod> Discover(string modsRoot)
        {
            return Discover(modsRoot, DefaultLoaderVersion, null, null);
        }

        public static IReadOnlyList<DiscoveredMod> Discover(string modsRoot, RechargeVersion loaderVersion)
        {
            return Discover(modsRoot, loaderVersion, null, null);
        }

        public static IReadOnlyList<DiscoveredMod> Discover(string modsRoot, RechargeVersion loaderVersion, IBuiltinModuleRegistry? builtins)
        {
            return Discover(modsRoot, loaderVersion, builtins, null);
        }

        public static IReadOnlyList<DiscoveredMod> Discover(string modsRoot, RechargeVersion loaderVersion, IBuiltinModuleRegistry? builtins, Action<string>? log)
        {
            if (loaderVersion == null) loaderVersion = DefaultLoaderVersion;
            var result = new List<DiscoveredMod>();
            var all = DiscoverAll(modsRoot, log);
            // Filter enabled + version + builtins + dependencies.
            var eligible = new Dictionary<string, DiscoveredMod>(StringComparer.Ordinal);
            foreach (var mod in all)
            {
                if (!mod.Enabled)
                {
                    Log(log, "[Recharge] Skipping disabled mod: " + mod.Id);
                    continue;
                }

                if (mod.MinLoaderVersion != null && mod.MinLoaderVersion > loaderVersion)
                {
                    Log(log, "[Recharge] Mod '" + mod.Id + "' needs loader " + mod.MinLoaderVersion + ", this is " + loaderVersion + " - skipped.");
                    continue;
                }

                if (builtins != null && builtins.HasBuiltInFor(mod.Id))
                {
                    Log(log, "[Recharge] Mod '" + mod.Id + "' is built-in now - skipped.");
                    continue;
                }

                eligible[mod.Id] = mod;
            }

            // Dependency ordering (Kahn).
            var inDegree = new Dictionary<string, int>(StringComparer.Ordinal);
            var dependents = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            var unmetReason = new Dictionary<string, string>(StringComparer.Ordinal);

            foreach (var id in eligible.Keys)
            {
                inDegree[id] = 0;
                if (!dependents.ContainsKey(id)) dependents[id] = new List<string>();
            }

            foreach (var kv in eligible)
            {
                var id = kv.Key;
                foreach (var dep in kv.Value.Dependencies)
                {
                    if (eligible.ContainsKey(dep))
                    {
                        dependents[dep].Add(id);
                        inDegree[id]++;
                    }
                    else
                    {
                        inDegree[id]++;
                        string why = all.Any(m => m.Id == dep) ? "is disabled or version-incompatible" : "is not installed";
                        unmetReason[id] = "requires '" + dep + "', which " + why;
                    }
                }
            }

            var queue = new Queue<string>(eligible.Keys.Where(id => inDegree[id] == 0).OrderBy(s => s, StringComparer.Ordinal));
            var order = new List<string>();
            while (queue.Count > 0)
            {
                var id = queue.Dequeue();
                order.Add(id);
                foreach (var dependent in dependents[id].OrderBy(s => s, StringComparer.Ordinal))
                {
                    if (--inDegree[dependent] == 0) queue.Enqueue(dependent);
                }
            }

            foreach (var id in eligible.Keys)
            {
                if (order.Contains(id)) continue;
                var reason = unmetReason.TryGetValue(id, out var direct)
                    ? direct
                    : "is part of a dependency cycle, or depends (directly or transitively) on something that is";
                Log(log, "[Recharge] Mod '" + id + "' not loaded: it " + reason + " - skipped.");
            }

            foreach (var id in order)
            {
                if (eligible.TryGetValue(id, out var mod)) result.Add(mod);
            }

            return result;
        }

        public static IReadOnlyList<DiscoveredMod> DiscoverAll(string modsRoot, Action<string>? log = null)
        {
            var result = new List<DiscoveredMod>();
            if (string.IsNullOrEmpty(modsRoot) || !Directory.Exists(modsRoot)) return result;

            foreach (var modDir in Directory.GetDirectories(modsRoot).OrderBy(d => d, StringComparer.Ordinal))
            {
                var manifestPath = Path.Combine(modDir, "mod.json");
                if (!File.Exists(manifestPath)) continue;

                try
                {
                    var text = File.ReadAllText(manifestPath);
                    var manifest = ModManifest.Load(text);

                    if (string.IsNullOrEmpty(manifest.Id) || string.IsNullOrEmpty(manifest.EntryAssembly))
                    {
                        Log(log, "[Recharge] mod.json in " + modDir + " is missing id or entryAssembly.");
                        continue;
                    }

                    // duplicate id check not needed for list; keep first by order.

                    var deps = ReadDependencies(manifest);
                    RechargeVersion? minVersion = null;
                    try
                    {
                        var minText = manifest.MinLoaderVersion;
                        if (!string.IsNullOrWhiteSpace(minText) && RechargeVersion.TryParse(minText, out var v))
                        {
                            minVersion = v;
                        }
                    }
                    catch { /* missing field */ }

                    bool enabled = true;
                    try { enabled = manifest.Enabled; } catch { enabled = true; }

                    result.Add(new DiscoveredMod(manifest.Id, modDir, manifest, manifest.EntryAssembly, deps, enabled, minVersion));
                }
                catch (Exception e)
                {
                    Log(log, "[Recharge] Malformed mod.json in " + modDir + ": " + e.Message);
                }
            }

            return result;
        }

        private static IReadOnlyList<string> ReadDependencies(ModManifest manifest)
        {
            var list = new List<string>();
            try
            {
                if (manifest.Root.TryGetValue("dependencies", out var node) && node is JsonArray arr)
                {
                    foreach (var item in arr)
                    {
                        if (item is JsonString s && !string.IsNullOrWhiteSpace(s.Value)) list.Add(s.Value);
                    }
                }
            }
            catch { }
            return list;
        }

        private static void Log(Action<string>? log, string message)
        {
            if (log != null) log(message);
            Console.WriteLine(message);
        }
    }

    // Instance wrapper alias.
    public class ModDiscoveryService
    {
        public RechargeVersion LoaderVersion { get; set; } = ModDiscovery.DefaultLoaderVersion;
        public IBuiltinModuleRegistry? Builtins { get; set; }
        public Action<string>? Log { get; set; }

        public IReadOnlyList<DiscoveredMod> Discover(string modsRoot) =>
            ModDiscovery.Discover(modsRoot, LoaderVersion, Builtins, Log);
    }

    public sealed class ModLoaderCore : ModDiscoveryService { }
    public sealed class ModDiscoveryEngine : ModDiscoveryService { }
}
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json;
using Recharge.ModApi;
using UnityEngine;
using UnityEngine.SceneManagement;

internal static class RechargeLoaderBootstrap
{
    public static readonly Version LoaderVersion = new Version(1, 0, 0);
    private static bool _initialized;

    private static EventBus _events;
    private static RechargeTicker _ticker;
    private static readonly Dictionary<string, IRechargeMod> ModRegistry = new Dictionary<string, IRechargeMod>();

    public static string ModsRoot =>
        Path.Combine(Path.GetDirectoryName(Application.dataPath) ?? ".", "Recharge", "Mods");

    public static void Init(pauseMenuScript menu)
    {
        if (_initialized) return;
        _initialized = true;

        _events = new EventBus();
        _ticker = RechargeTicker.Create();
        SceneManager.sceneLoaded += (scene, mode) =>
        {
            _playerSpawnFiredThisScene = false; // a fresh scene may have a fresh Player to detect
            _events.Emit(RechargeEvents.SceneLoaded, scene.name);
        };
        _ticker.Tick += PollForPlayerSpawn;

        var modsRoot = ModsRoot;
        if (!Directory.Exists(modsRoot))
        {
            Debug.Log("[Recharge] No Mods directory found at " + modsRoot);
            return;
        }

        var manifests = DiscoverManifests(modsRoot);
        var loadOrder = ResolveLoadOrder(manifests);

        foreach (var id in loadOrder)
        {
            var entry = manifests[id];
            // ResolveLoadOrder only knows what's in mod.json - a dependency
            // can still fail for a runtime reason it can't predict (missing
            // DLL, no IRechargeMod type, OnLoad threw). Re-check against who
            // actually made it into ModRegistry so "requires X" is honored
            // end-to-end, not just at the manifest level.
            var unmetDep = (entry.Manifest.dependencies ?? Array.Empty<string>())
                .FirstOrDefault(dep => !ModRegistry.ContainsKey(dep));
            if (unmetDep != null)
            {
                Debug.LogError("[Recharge] Mod '" + id + "' not loaded: its dependency '" + unmetDep + "' failed to load at runtime - skipped.");
                continue;
            }
            try { LoadMod(entry, menu); }
            catch (Exception e) { Debug.LogError("[Recharge] Failed to load mod at " + entry.ModDir + ": " + e); }
        }

        _events.Emit(RechargeEvents.ModsReady);
    }

    private class ModManifest
    {
        public string id;
        public string displayName;
        public string version;
        public string entryAssembly;
        public string minLoaderVersion;
        public bool enabled = true;
        public string[] dependencies = Array.Empty<string>();
    }

    private class ManifestEntry
    {
        public string ModDir;
        public ModManifest Manifest;
    }

    // Reads every mod.json under modsRoot up front (without loading any
    // assembly yet) so dependency order can be computed before anything
    // actually runs. Keyed by manifest id - a duplicate id silently keeps
    // whichever folder Directory.GetDirectories happens to enumerate first
    // and logs the collision, since ids are meant to be globally unique.
    private static Dictionary<string, ManifestEntry> DiscoverManifests(string modsRoot)
    {
        var result = new Dictionary<string, ManifestEntry>();
        foreach (var modDir in Directory.GetDirectories(modsRoot))
        {
            var manifestPath = Path.Combine(modDir, "mod.json");
            if (!File.Exists(manifestPath)) continue;

            ModManifest manifest;
            try { manifest = JsonConvert.DeserializeObject<ModManifest>(File.ReadAllText(manifestPath)); }
            catch (Exception e) { Debug.LogError("[Recharge] Malformed mod.json in " + modDir + ": " + e.Message); continue; }

            if (manifest == null || string.IsNullOrEmpty(manifest.id) || string.IsNullOrEmpty(manifest.entryAssembly))
            {
                Debug.LogError("[Recharge] mod.json in " + modDir + " is missing id or entryAssembly.");
                continue;
            }
            if (result.ContainsKey(manifest.id))
            {
                Debug.LogError("[Recharge] duplicate mod id '" + manifest.id + "' (" + modDir + ") - keeping the first one found, skipping this.");
                continue;
            }
            result[manifest.id] = new ManifestEntry { ModDir = modDir, Manifest = manifest };
        }
        return result;
    }

    // "dependencies" is a real REQUIRE, not just an ordering hint: a mod
    // whose dependency is missing, disabled, version-incompatible, or itself
    // excluded for any of these reasons does NOT load at all - and that
    // exclusion cascades to anything that in turn depends on it. Implemented
    // as Kahn's algorithm (BFS topological sort via in-degree counting),
    // which gets both cascading-exclusion and cycle detection for free: a
    // mod involved in (or downstream of) a cycle can never reach in-degree
    // zero, so it's left out of the final order exactly like a mod with a
    // genuinely missing dependency is.
    private static List<string> ResolveLoadOrder(Dictionary<string, ManifestEntry> manifests)
    {
        var eligible = new Dictionary<string, ManifestEntry>();
        foreach (var kv in manifests)
        {
            var manifest = kv.Value.Manifest;
            if (!manifest.enabled)
            {
                Debug.Log("[Recharge] Skipping disabled mod: " + manifest.id);
                continue;
            }
            if (!string.IsNullOrEmpty(manifest.minLoaderVersion)
                && Version.TryParse(manifest.minLoaderVersion, out var minVersion)
                && minVersion > LoaderVersion)
            {
                Debug.LogError($"[Recharge] Mod '{manifest.id}' needs loader {minVersion}, this is {LoaderVersion} - skipped.");
                continue;
            }
            eligible[kv.Key] = kv.Value;
        }

        var inDegree = new Dictionary<string, int>();
        var dependents = new Dictionary<string, List<string>>(); // depId -> ids that require it
        var unmetReason = new Dictionary<string, string>();
        foreach (var id in eligible.Keys)
        {
            inDegree[id] = 0;
            if (!dependents.ContainsKey(id)) dependents[id] = new List<string>();
        }
        foreach (var kv in eligible)
        {
            var id = kv.Key;
            foreach (var dep in kv.Value.Manifest.dependencies ?? Array.Empty<string>())
            {
                if (eligible.ContainsKey(dep))
                {
                    dependents[dep].Add(id);
                    inDegree[id]++;
                }
                else
                {
                    // Counted so this id can never reach in-degree zero (the
                    // phantom edge never gets "satisfied" by anything being
                    // processed), same mechanism a real cycle is caught by.
                    inDegree[id]++;
                    var why = manifests.ContainsKey(dep) ? "is disabled or version-incompatible" : "is not installed";
                    unmetReason[id] = "requires '" + dep + "', which " + why;
                }
            }
        }

        var queue = new Queue<string>(eligible.Keys.Where(id => inDegree[id] == 0));
        var order = new List<string>();
        while (queue.Count > 0)
        {
            var id = queue.Dequeue();
            order.Add(id);
            foreach (var dependent in dependents[id])
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
            Debug.LogError("[Recharge] Mod '" + id + "' not loaded: it " + reason + " - skipped.");
        }

        return order;
    }

    // enabled/minLoaderVersion/dependency eligibility are already resolved by
    // the time an id reaches here - see ResolveLoadOrder. This only has to
    // handle build-artifact problems (a manifest can be valid while its DLL
    // is missing/stale), which aren't knowable until we actually try.
    private static void LoadMod(ManifestEntry entry, pauseMenuScript menu)
    {
        var modDir = entry.ModDir;
        var manifest = entry.Manifest;

        var dllPath = Path.Combine(modDir, manifest.entryAssembly);
        if (!File.Exists(dllPath))
        {
            Debug.LogError("[Recharge] Mod entry assembly not found: " + dllPath);
            return;
        }

        var asm = Assembly.LoadFrom(dllPath);
        var modType = asm.GetTypes()
            .FirstOrDefault(t => typeof(IRechargeMod).IsAssignableFrom(t) && !t.IsInterface && !t.IsAbstract);
        if (modType == null)
        {
            Debug.LogError("[Recharge] No IRechargeMod implementation found in " + manifest.entryAssembly);
            return;
        }

        var mod = (IRechargeMod)Activator.CreateInstance(modType);
        // Registered before OnLoad runs, so a mod can find itself via
        // host.GetMod, and so a mod loading later in dependency order can
        // already see this one even mid-way through this same Init() call.
        ModRegistry[manifest.id] = mod;

        var host = new RechargeHost(menu, _events, _ticker, ModRegistry, manifest.id);
        mod.OnLoad(host);
        Debug.Log($"[Recharge] Loaded mod '{mod.DisplayName}' v{mod.Version}");
        _events.Emit(RechargeEvents.ModLoaded, manifest.id);
    }

    private static bool _playerSpawnFiredThisScene;

    private static void PollForPlayerSpawn()
    {
        if (_playerSpawnFiredThisScene) return;
        var playerGo = GameObject.FindGameObjectWithTag("Player");
        if (playerGo == null || playerGo.GetComponent<Movement>() == null) return;
        _playerSpawnFiredThisScene = true;
        _events.Emit(RechargeEvents.PlayerSpawned, playerGo);
    }
}

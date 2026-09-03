using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;
using Recharge.ModApi;
using UnityEngine;

/// <summary>
/// Concrete IRechargeHost. One instance is constructed per mod (so log lines
/// can be attributed - see <see cref="Log"/>), but every instance shares the
/// same session-wide EventBus/RechargeTicker/mod registry underneath, all
/// owned by RechargeLoaderBootstrap.
/// </summary>
internal class RechargeHost : IRechargeHost
{
    private readonly pauseMenuScript _menu;
    private readonly EventBus _events;
    private readonly RechargeTicker _ticker;
    private readonly IReadOnlyDictionary<string, IRechargeMod> _modRegistry;
    private readonly string _modId;

    public RechargeHost(pauseMenuScript menu, EventBus events, RechargeTicker ticker, IReadOnlyDictionary<string, IRechargeMod> modRegistry, string modId)
    {
        _menu = menu;
        _events = events;
        _ticker = ticker;
        _modRegistry = modRegistry;
        _modId = modId;
    }

    public pauseMenuScript PauseMenu => _menu;
    public IEventBus Events => _events;

    public event Action OnUpdate { add => _ticker.Tick += value; remove => _ticker.Tick -= value; }
    public event Action OnLateUpdate { add => _ticker.LateTick += value; remove => _ticker.LateTick -= value; }
    public event Action OnFixedUpdate { add => _ticker.FixedTick += value; remove => _ticker.FixedTick -= value; }

    public void Log(string message) => Debug.Log(Prefix() + message);
    public void LogWarning(string message) => Debug.LogWarning(Prefix() + message);
    public void LogError(string message) => Debug.LogError(Prefix() + message);
    private string Prefix() => "[Recharge:" + _modId + "] ";

    public string ModDataDir(string modId)
    {
        var dir = Path.Combine(RechargeLoaderBootstrap.ModsRoot, modId, "data");
        Directory.CreateDirectory(dir);
        return dir;
    }

    public IRechargeMod GetMod(string modId)
    {
        return _modRegistry.TryGetValue(modId, out var mod) ? mod : null;
    }

    public T GetModApi<T>(string modId) where T : class
    {
        return GetMod(modId) as T;
    }

    public T LoadConfig<T>(string modId, string fileName = "config.json") where T : new()
    {
        var path = Path.Combine(ModDataDir(modId), fileName);
        if (!File.Exists(path)) return new T();
        try
        {
            return JsonConvert.DeserializeObject<T>(File.ReadAllText(path)) ?? new T();
        }
        catch (Exception e)
        {
            LogWarning("config '" + fileName + "' failed to parse, using defaults: " + e.Message);
            return new T();
        }
    }

    public void SaveConfig<T>(string modId, T config, string fileName = "config.json")
    {
        var path = Path.Combine(ModDataDir(modId), fileName);
        File.WriteAllText(path, JsonConvert.SerializeObject(config, Formatting.Indented));
    }

    public Sprite LoadSprite(byte[] imageBytes, float pixelsPerUnit = 100f)
    {
        var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false);
        if (!ImageConversion.LoadImage(tex, imageBytes))
        {
            UnityEngine.Object.Destroy(tex);
            return null;
        }
        return Sprite.Create(tex, new Rect(0, 0, tex.width, tex.height), new Vector2(0.5f, 0.5f), pixelsPerUnit);
    }
}

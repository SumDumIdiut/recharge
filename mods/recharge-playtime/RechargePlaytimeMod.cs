using System;
using Recharge.ModApi;
using TMPro;
using UnityEngine;

// A small framework demo: a pause-menu sub-panel (AddPanelRow) showing total
// time played, persisted via LoadConfig/SaveConfig and updated live via
// OnUpdate while the panel is open. See mods/_template/ExampleMod.cs for the
// full annotated tour of IRechargeHost - this mod only exercises the config
// + panel + per-frame pieces of it.
public class RechargePlaytimeMod : IRechargeMod
{
    public string Id => "recharge.playtime";
    public string DisplayName => "Playtime Tracker";
    public Version Version => new Version(1, 0, 0);

    private class PlaytimeConfig
    {
        public double TotalSeconds;
    }

    private IRechargeHost _host;
    private PlaytimeConfig _config;
    private TMP_Text _label;
    private float _sessionStart;
    private float _lastSave;

    public void OnLoad(IRechargeHost host)
    {
        _host = host;
        _config = host.LoadConfig<PlaytimeConfig>(Id);
        _sessionStart = Time.realtimeSinceStartup;
        _lastSave = _sessionStart;

        BuildPanel(host.PauseMenu);
        // host.PauseMenu is a one-time snapshot from loader init - every
        // later scene load creates a fresh pauseMenuScript with an
        // undecorated menu, so rebuild against whatever instance is
        // actually live each time (see recharge-multiplayer's
        // RechargeMultiplayerMod.cs for the same pattern).
        host.Events.On(RechargeEvents.SceneLoaded, _ =>
        {
            var menu = UnityEngine.Object.FindFirstObjectByType<pauseMenuScript>();
            if (menu != null) BuildPanel(menu);
        });

        host.OnUpdate += Tick;
    }

    private double CurrentTotalSeconds => _config.TotalSeconds + (Time.realtimeSinceStartup - _sessionStart);

    private void Tick()
    {
        if (_label != null) _label.text = FormatTime(CurrentTotalSeconds);

        // OnUnload isn't actually called yet (a mod's OnLoad currently only
        // ever runs once per game session - see IRechargeMod.OnUnload's own
        // doc comment), so periodic autosave is the only way progress
        // survives a crash or force-quit rather than a clean exit.
        if (Time.realtimeSinceStartup - _lastSave > 30f) Save();
    }

    private void Save()
    {
        _lastSave = Time.realtimeSinceStartup;
        _config.TotalSeconds = CurrentTotalSeconds;
        _sessionStart = Time.realtimeSinceStartup; // fold the saved chunk in so CurrentTotalSeconds doesn't double-count it
        _host.SaveConfig(Id, _config);
    }

    private void BuildPanel(pauseMenuScript menu)
    {
        var panel = PauseMenuHelper.AddPanelRow(menu, "Playtime", DisplayName);
        if (panel == null) return;

        var labelGo = new GameObject("PlaytimeLabel", typeof(RectTransform));
        labelGo.transform.SetParent(panel.transform, false);
        var rt = (RectTransform)labelGo.transform;
        rt.anchorMin = rt.anchorMax = rt.pivot = new Vector2(0.5f, 0.5f);
        rt.anchoredPosition = Vector2.zero;
        rt.sizeDelta = new Vector2(420f, 120f);

        _label = labelGo.AddComponent<TextMeshProUGUI>();
        _label.alignment = TextAlignmentOptions.Center;
        _label.fontSize = 32f;
        _label.text = FormatTime(CurrentTotalSeconds);
    }

    private static string FormatTime(double seconds)
    {
        var span = TimeSpan.FromSeconds(seconds);
        return string.Format("Total playtime\n{0}h {1}m {2}s", (int)span.TotalHours, span.Minutes, span.Seconds);
    }

    public void OnUnload()
    {
    }
}

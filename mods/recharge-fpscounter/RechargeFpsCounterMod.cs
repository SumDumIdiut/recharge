using System;
using Recharge.ModApi;
using UnityEngine;

// A small framework demo: a row-only pause-menu entry (AddRow, no sub-panel)
// that toggles a persistent on-screen overlay. See mods/_template/ExampleMod.cs
// for the full annotated tour of IRechargeHost.
public class RechargeFpsCounterMod : IRechargeMod
{
    public string Id => "recharge.fpscounter";
    public string DisplayName => "FPS Counter";
    public Version Version => new Version(1, 0, 0);

    private class FpsConfig
    {
        public bool Visible = true;
    }

    private IRechargeHost _host;
    private FpsConfig _config;
    private FpsOverlay _overlay;
    private pauseMenuScript _menu;

    public void OnLoad(IRechargeHost host)
    {
        _host = host;
        _config = host.LoadConfig<FpsConfig>(Id);

        var overlayGo = new GameObject("RechargeFpsOverlay");
        UnityEngine.Object.DontDestroyOnLoad(overlayGo);
        _overlay = overlayGo.AddComponent<FpsOverlay>();
        _overlay.Visible = _config.Visible;

        InstallRow(host.PauseMenu);
        host.Events.On(RechargeEvents.SceneLoaded, _ =>
        {
            var menu = UnityEngine.Object.FindFirstObjectByType<pauseMenuScript>();
            if (menu != null) InstallRow(menu);
        });
    }

    private void InstallRow(pauseMenuScript menu)
    {
        _menu = menu;
        RefreshRow();
    }

    // Re-adds the row with an updated label/closure (Upsert-safe, see
    // PauseMenuHelper.AddRow's own doc) - used both for the initial install
    // and to relabel "Show FPS"/"Hide FPS" live after a click.
    private void RefreshRow()
    {
        if (_menu == null) return;
        var label = _config.Visible ? "Hide FPS" : "Show FPS";
        PauseMenuHelper.AddRow(_menu, "FpsToggle", label, () =>
        {
            _config.Visible = !_config.Visible;
            _overlay.Visible = _config.Visible;
            _host.SaveConfig(Id, _config);
            RefreshRow();
            _menu.mainBitPublic.SetActive(true); // a row-only click hides mainBit before running - bring it back since this action doesn't open anything of its own
        });
    }

    public void OnUnload()
    {
    }
}

internal class FpsOverlay : MonoBehaviour
{
    public bool Visible;

    private float _fps;
    private float _timer;
    private int _frames;
    private GUIStyle _style;

    private void Update()
    {
        _frames++;
        _timer += Time.unscaledDeltaTime;
        if (_timer < 0.5f) return;
        _fps = _frames / _timer;
        _frames = 0;
        _timer = 0f;
    }

    private void OnGUI()
    {
        if (!Visible) return;
        if (_style == null) _style = new GUIStyle(GUI.skin.label) { fontSize = 20, normal = { textColor = Color.green } };
        GUI.Label(new Rect(10, 10, 200, 30), string.Format("{0:0.0} FPS", _fps), _style);
    }
}

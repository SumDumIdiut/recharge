using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using Recharge.ModApi;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Recharge.Module.Maps;

/// <summary>
/// The new Recharge-styled in-game Settings panel: a tabbed section framework
/// (Game / Audio / Gameplay / Controls) wired to the game's real backend
/// (docs/settings-backend.md). The game's own Settings button now opens this
/// panel instead of the vanilla settings; a "Settings (New)" Mods row is kept
/// as a safety net.
/// </summary>
internal static class RechargeSettingsPanel
{
    public static void Install(pauseMenuScript menu)
    {
        if (PauseMenuHelper.MainBit(menu) == null || PauseMenuHelper.SettingsBit(menu) == null) return;

        // A blank Recharge-styled panel (title + Back button), with NO Mods-menu row:
        // the game's own Settings button (hooked below) is the only way in, so the
        // panel fully replaces the vanilla settings screen.
        var panel = PauseMenuHelper.GetOrCreatePanel(menu, "RechargeSettingsPanel", "Settings");
        if (panel == null) return;

        if (panel.GetComponent<RechargeSettingsPanelUI>() == null)
        {
            var font = FindTitleFont(panel);
            panel.AddComponent<RechargeSettingsPanelUI>().Build(panel, font);
        }

        // Replace the vanilla Settings button so it opens this panel. Mirrors the
        // Mods-row action (panel.SetActive(true)) plus hiding MainBit/settingsBit
        // like the vanilla Settings button. Back/Escape returns via the panel's
        // existing Back button (backTarget defaults to MainBit) - unchanged.
        var main = PauseMenuHelper.MainBit(menu);
        var settingsBit = PauseMenuHelper.SettingsBit(menu);
        var settingsBtn = main != null
            ? main.transform.Find("Settings")?.GetComponent<Button>()
            : null;
        if (settingsBtn != null)
        {
            settingsBtn.onClick = new Button.ButtonClickedEvent();
            settingsBtn.onClick.AddListener(() =>
            {
                if (settingsBit != null) settingsBit.SetActive(false);
                if (main != null) main.SetActive(false);
                panel.SetActive(true);
            });
        }
    }

    private static TMP_FontAsset FindTitleFont(GameObject panel)
    {
        var title = panel.transform.Find("Settings") ?? (panel.transform.childCount > 0 ? panel.transform.GetChild(0) : null);
        return title != null ? title.GetComponent<TMP_Text>()?.font : null;
    }
}

internal class RechargeSettingsPanelUI : MonoBehaviour
{
    private TMP_FontAsset _font;
    private Transform _content;
    private readonly List<TMP_Text> _tabLabels = new List<TMP_Text>();
    private GameObject _fpsDropdown;
    private int _controlsPage;

    // Same orange as the panel's Back button. Every text button is orange and
    // borderless; dropdowns/sliders/toggles keep their own styling.
    private static readonly Color ButtonOrange = new Color(1f, 0.55f, 0.15f, 1f);
    private static readonly Color TabActive = ButtonOrange;
    private static readonly Color TabInactive = new Color(1f, 0.55f, 0.15f, 0.55f);
    private static readonly Color RowDim = new Color(1f, 1f, 1f, 0.7f);
    private static readonly Color BindingColor = new Color(1f, 0.78f, 0.35f, 1f);

    private static readonly string[] Sections = { "Game", "Audio", "Gameplay", "Controls" };
    private const int ControlsPageSize = 6;

    public void Build(GameObject panel, TMP_FontAsset font)
    {
        _font = font;
        var root = panel.transform;

        // Tab row across the top: four tabs evenly centred on the panel.
        const float startX = -180f, step = 120f;
        for (int i = 0; i < Sections.Length; i++)
        {
            int idx = i;
            var go = CreateTextButton(root, "Tab" + Sections[i],
                new Vector2(startX + step * i, 155f), new Vector2(112f, 40f), Sections[i], 20f);
            go.GetComponent<Button>().onClick.AddListener(() => ShowSection(idx));
            _tabLabels.Add(go.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>());
        }

        PanelWidgets.CreateDivider(root, new Vector2(0f, 133f), 640f);

        // The active section builds its widgets in here; cleared on each switch.
        _content = PanelWidgets.CreateContainer(root, "SettingsContent", new Vector2(0f, -30f), new Vector2(680f, 320f));

        ShowSection(0);
    }

    private void ShowSection(int index)
    {
        if (index < 0 || index >= Sections.Length) return;
        for (int i = 0; i < _tabLabels.Count; i++)
            if (_tabLabels[i] != null) _tabLabels[i].color = i == index ? TabActive : TabInactive;

        ClearContent();

        switch (Sections[index])
        {
            case "Game": BuildGameSection(); break;
            case "Audio": BuildAudioSection(); break;
            case "Gameplay": BuildGameplaySection(); break;
            case "Controls": BuildControlsSection(); break;
        }
    }

    private void ClearContent()
    {
        if (_content == null) return;
        for (int i = _content.childCount - 1; i >= 0; i--) Destroy(_content.GetChild(i).gameObject);
    }

    /// <summary>Flat orange text button, with no box behind it (including on hover).</summary>
    private GameObject CreateTextButton(Transform parent, string name, Vector2 pos, Vector2 size, string label, float fontSize = 13f) =>
        PanelWidgets.CreateButton(parent, _font, name, pos, size, label, fontSize,
            ButtonOrange, TextAlignmentOptions.Center, showBackground: false, hoverBackgroundColor: Color.clear);

    // ---------------- Sections (all wired to the game's real backend) ----------------

    private void BuildGameSection()
    {
        SectionTitle("Game");
        var fullscreenOptions = RechargeSettingsBackend.FullscreenOptions();
        LabeledDropdown(70f, "Window size", fullscreenOptions,
            RechargeSettingsBackend.ReadFullscreenIndex(fullscreenOptions),
            index => RechargeSettingsBackend.ApplyFullscreen(index, fullscreenOptions));

        var fpsOptions = RechargeSettingsBackend.FpsOptions();
        _fpsDropdown = LabeledDropdown(10f, "FPS limit", fpsOptions,
            RechargeSettingsBackend.ReadFpsIndex(fpsOptions),
            index => RechargeSettingsBackend.ApplyFps(index, fpsOptions));

        bool vsync = RechargeSettingsBackend.ReadVsync();
        LabeledToggle(-50f, "V-sync", vsync, on =>
        {
            RechargeSettingsBackend.ApplyVsync(on);
            if (_fpsDropdown != null) _fpsDropdown.SetActive(!on);
        });
        if (vsync && _fpsDropdown != null) _fpsDropdown.SetActive(false);

        var languageOptions = RechargeSettingsBackend.LanguageOptions();
        LabeledDropdown(-110f, "Language", languageOptions,
            RechargeSettingsBackend.ReadLanguageIndex(languageOptions),
            index => RechargeSettingsBackend.ApplyLanguage(index, languageOptions));
    }

    private void BuildAudioSection()
    {
        SectionTitle("Audio");
        // Both values travel together: the game's updateLevels() writes both mixers/keys.
        float sfx = RechargeSettingsBackend.ReadSfxVolume();
        float music = RechargeSettingsBackend.ReadMusicVolume();
        LabeledSlider(70f, "SFX volume", 0f, 1f, sfx,
            value => { sfx = value; RechargeSettingsBackend.ApplyVolumes(sfx, music); },
            value => Mathf.RoundToInt(value * 100f) + "%");
        LabeledSlider(10f, "Music volume", 0f, 1f, music,
            value => { music = value; RechargeSettingsBackend.ApplyVolumes(sfx, music); },
            value => Mathf.RoundToInt(value * 100f) + "%");
    }

    private void BuildGameplaySection()
    {
        SectionTitle("Gameplay");
        LabeledToggle(70f, "Visualise inputs", RechargeSettingsBackend.ReadInputVis(),
            RechargeSettingsBackend.ApplyInputVis);
        // The stored scalar is slider.value / 3; show that scalar, always with a leading zero.
        LabeledSlider(10f, "Clone hide radius", 0f, 3f, RechargeSettingsBackend.ReadCloneSliderValue(),
            RechargeSettingsBackend.ApplyCloneRadius, CloneRadiusText);
    }

    private void BuildControlsSection()
    {
        var rows = RechargeSettingsBackend.GetKeybindRows();
        int pages = Mathf.Max(1, Mathf.CeilToInt(rows.Count / (float)ControlsPageSize));
        _controlsPage = Mathf.Clamp(_controlsPage, 0, pages - 1);
        RenderControlsPage(rows, pages);
    }

    private void RenderControlsPage(List<RechargeSettingsBackend.KeybindRow> rows, int pages)
    {
        ClearContent();
        SectionTitle("Controls");

        // Two explicitly labelled binding columns, so keyboard and gamepad never
        // get confused with each other (or with one shared "Rebind" button).
        PanelWidgets.CreateLabel(_content, _font, new Vector2(-240f, 105f), new Vector2(170f, 24f),
            "Action", 13f, RowDim, TextAlignmentOptions.MidlineLeft);
        PanelWidgets.CreateLabel(_content, _font, new Vector2(-5f, 105f), new Vector2(160f, 24f),
            "Keyboard", 13f, ButtonOrange);
        PanelWidgets.CreateLabel(_content, _font, new Vector2(225f, 105f), new Vector2(160f, 24f),
            "Controller", 13f, ButtonOrange);

        if (rows.Count == 0)
        {
            PanelWidgets.CreateLabel(_content, _font, new Vector2(0f, 30f), new Vector2(620f, 60f),
                "No keybind rows found in the pause menu.", 18f, RowDim);
            return;
        }

        int start = _controlsPage * ControlsPageSize;
        int end = Mathf.Min(start + ControlsPageSize, rows.Count);
        for (int i = start; i < end; i++)
        {
            var row = rows[i];
            float y = 78f - (i - start) * 30f;
            PanelWidgets.CreateLabel(_content, _font, new Vector2(-240f, y), new Vector2(170f, 26f),
                row.Label, 14f, Color.white, TextAlignmentOptions.MidlineLeft);

            var keyboardDisplay = PanelWidgets.CreateLabel(_content, _font, new Vector2(-70f, y), new Vector2(95f, 26f),
                RechargeSettingsBackend.BindingDisplay(row, false), 14f, BindingColor, TextAlignmentOptions.MidlineLeft);
            var keyboardButton = CreateTextButton(_content, "KbRebind" + i, new Vector2(60f, y), new Vector2(86f, 26f), "Rebind");
            if (row.IsChat)
            {
                keyboardButton.GetComponent<Button>().onClick.AddListener(() => BeginChatRebind(keyboardDisplay));
            }
            else
            {
                var captured = row;
                keyboardButton.GetComponent<Button>().onClick.AddListener(() =>
                {
                    bool started = RechargeSettingsBackend.BeginKeyboardRebind(captured,
                        () => keyboardDisplay.text = RechargeSettingsBackend.BindingDisplay(captured, false));
                    if (started) keyboardDisplay.text = "...";
                });
            }

            var controllerDisplay = PanelWidgets.CreateLabel(_content, _font, new Vector2(160f, y), new Vector2(95f, 26f),
                RechargeSettingsBackend.BindingDisplay(row, true), 14f, BindingColor, TextAlignmentOptions.MidlineLeft);
            var controllerButton = CreateTextButton(_content, "PadRebind" + i, new Vector2(290f, y), new Vector2(86f, 26f), "Rebind");
            if (row.IsChat)
            {
                // The chat key is a keyboard-only PlayerPrefs key, not an InputAction.
                controllerButton.GetComponent<Button>().interactable = false;
            }
            else
            {
                var captured = row;
                controllerButton.GetComponent<Button>().onClick.AddListener(() =>
                {
                    bool started = RechargeSettingsBackend.BeginControllerRebind(captured,
                        () => controllerDisplay.text = RechargeSettingsBackend.BindingDisplay(captured, true));
                    if (started) controllerDisplay.text = "...";
                });
            }
        }

        if (pages <= 1) return;
        var prev = CreateTextButton(_content, "PrevControlsPage", new Vector2(-170f, -112f), new Vector2(100f, 28f), "< Prev", 15f);
        prev.GetComponent<Button>().interactable = _controlsPage > 0;
        prev.GetComponent<Button>().onClick.AddListener(() => { _controlsPage--; BuildControlsSection(); });
        PanelWidgets.CreateLabel(_content, _font, new Vector2(0f, -112f), new Vector2(120f, 26f),
            (_controlsPage + 1) + "/" + pages, 15f, RowDim);
        var next = CreateTextButton(_content, "NextControlsPage", new Vector2(170f, -112f), new Vector2(100f, 28f), "Next >", 15f);
        next.GetComponent<Button>().interactable = _controlsPage < pages - 1;
        next.GetComponent<Button>().onClick.AddListener(() => { _controlsPage++; BuildControlsSection(); });
    }

    /// <summary>The chat rebind is handled by MpInGameChatHud's own Update loop, so poll its flag
    /// until the key is captured and then refresh the row without a panel-wide Update.</summary>
    private void BeginChatRebind(TMP_Text label)
    {
        RechargeSettingsBackend.BeginChatRebind();
        label.text = "...";
        StartCoroutine(RefreshChatLabelAfterRebind(label));
    }

    private IEnumerator RefreshChatLabelAfterRebind(TMP_Text label)
    {
        yield return null; // let MpInGameChatHud set IsRebinding before we look at it
        for (int frames = 0; RechargeSettingsBackend.IsChatRebinding() && frames < 600; frames++)
            yield return null;
        if (label != null) label.text = RechargeSettingsBackend.ChatKeyDisplay();
    }

    // ---------------- Reusable layout helpers for sections ----------------

    private void SectionTitle(string text) =>
        PanelWidgets.CreateLabel(_content, _font, new Vector2(0f, 130f), new Vector2(620f, 34f), text, 24f);

    /// <summary>The stored clone radius is slider.value / 3; always render it as 0.00 with a leading zero.</summary>
    private static string CloneRadiusText(float sliderValue)
    {
        float scalar = sliderValue / 3f;
        if (float.IsNaN(scalar) || float.IsInfinity(scalar)) scalar = 0f;
        return scalar.ToString("0.00", CultureInfo.InvariantCulture);
    }

    /// <summary>A left-aligned label with a slider on the right. The value number is placed
    /// in the clear gap past the track, inside the 680-wide content area.</summary>
    private Slider LabeledSlider(float y, string label, float min, float max, float value, Action<float> onChanged, Func<float, string> format = null)
    {
        PanelWidgets.CreateLabel(_content, _font, new Vector2(-180f, y), new Vector2(240f, 30f), label, 18f, Color.white, TextAlignmentOptions.MidlineLeft);
        const float trackWidth = 150f;
        var slider = PanelWidgets.CreateSlider(_content, _font, new Vector2(150f, y), new Vector2(trackWidth, 24f), min, max, value, onChanged, out var valueLabel);
        if (valueLabel != null)
        {
            var valueRect = (RectTransform)valueLabel.rectTransform;
            valueRect.anchorMin = valueRect.anchorMax = new Vector2(0f, 0.5f);
            valueRect.pivot = new Vector2(0f, 0.5f);
            // Row container is zero-width at x=150: track ends at 150+75=225, and even
            // a 24px handle inset 8px from the end stops by ~229. This label starts at
            // 150+75+40=265 (36px clear of the handle) and ends at 265+64=329,
            // safely inside the 680-wide content area (edge at 340).
            valueRect.anchoredPosition = new Vector2(trackWidth / 2f + 40f, 0f);
            valueRect.sizeDelta = new Vector2(64f, 24f);
        }
        if (format != null && valueLabel != null)
        {
            UnityEngine.Events.UnityAction<float> refresh = v => valueLabel.text = format(v);
            slider.onValueChanged.AddListener(refresh);
            refresh(slider.value);
        }
        return slider;
    }

    /// <summary>A left-aligned label with the checkbox on the right, like the dropdown/slider rows.</summary>
    private Toggle LabeledToggle(float y, string label, bool value, Action<bool> onChanged)
    {
        var toggle = PanelWidgets.CreateToggle(_content, _font, new Vector2(-20f, y), label, value, onChanged);
        var row = (RectTransform)toggle.transform;
        row.sizeDelta = new Vector2(600f, 30f);

        // PanelWidgets builds box-left/label-right; flip just this row's children so
        // the label starts with the other row labels and the box sits at the right end.
        var box = row.Find("Background") as RectTransform;
        if (box != null)
        {
            box.anchorMin = box.anchorMax = new Vector2(1f, 0.5f);
            box.pivot = new Vector2(1f, 0.5f);
            box.anchoredPosition = new Vector2(-8f, 0f);
        }
        var labelRect = row.Find("Label") as RectTransform;
        if (labelRect != null)
        {
            labelRect.anchorMin = labelRect.anchorMax = new Vector2(0f, 0.5f);
            labelRect.pivot = new Vector2(0f, 0.5f);
            labelRect.anchoredPosition = new Vector2(10f, 0f);
            labelRect.sizeDelta = new Vector2(260f, 28f);
        }
        return toggle;
    }

    /// <summary>A left-aligned label with a dropdown on the right.</summary>
    private GameObject LabeledDropdown(float y, string label, IList<string> options, int index, Action<int> onChanged)
    {
        PanelWidgets.CreateLabel(_content, _font, new Vector2(-180f, y), new Vector2(240f, 30f), label, 18f, Color.white, TextAlignmentOptions.MidlineLeft);
        return PanelWidgets.CreateDropdown(_content, _font, new Vector2(150f, y), new Vector2(220f, 36f), options, index, onChanged);
    }
}

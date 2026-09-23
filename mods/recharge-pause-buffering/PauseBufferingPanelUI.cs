using System;
using TMPro;
using UnityEngine;
using Recharge.ModApi;

// Minimal single-page settings panel - a toggle to disable/enable input
// buffering across the pause menu. Previously this mod had no menu entry at
// all, so there was no way to turn it off without disabling the whole mod.
internal class PauseBufferingPanelUI : MonoBehaviour
{
    public void Build(GameObject panel, TMP_FontAsset font, bool initialEnabled, Action<bool> onChanged)
    {
        var layout = PanelLayout.Apply(panel, new Vector2(480f, 220f));
        float titleY = layout.Size.y / 2f - 35f;
        PauseMenuHelper.NormalizePanelLayout(panel, titleY, -titleY);
        var root = panel.transform;

        PanelWidgets.CreateToggle(root, font, layout.PositionOf(PanelAnchor.Center, new Vector2(-90, 20)), "Enable pause buffering", initialEnabled, onChanged);

        PanelWidgets.CreateLabel(root, font, layout.PositionOf(PanelAnchor.Center, new Vector2(0, -35)), new Vector2(400, 90),
            "Remembers a jump/dash press made while the pause menu is open and replays it the instant you unpause, instead of it being silently lost.",
            fontSize: 13f, color: new Color(1f, 1f, 1f, 0.6f));
    }
}

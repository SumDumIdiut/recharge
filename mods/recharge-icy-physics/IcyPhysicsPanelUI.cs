using System;
using TMPro;
using UnityEngine;
using Recharge.ModApi;

// Minimal single-page settings panel - a toggle to disable/enable the icy
// physics effect from the pause menu. Previously the only control was the
// in-game F9 shortcut, with no persisted on/off state and no menu entry at
// all.
internal class IcyPhysicsPanelUI : MonoBehaviour
{
    public void Build(GameObject panel, TMP_FontAsset font, bool initialEnabled, Action<bool> onChanged)
    {
        var layout = PanelLayout.Apply(panel, new Vector2(480f, 220f));
        float titleY = layout.Size.y / 2f - 35f;
        PauseMenuHelper.NormalizePanelLayout(panel, titleY, -titleY);
        var root = panel.transform;

        PanelWidgets.CreateToggle(root, font, layout.PositionOf(PanelAnchor.Center, new Vector2(-90, 20)), "Enable icy physics", initialEnabled, onChanged);

        PanelWidgets.CreateLabel(root, font, layout.PositionOf(PanelAnchor.Center, new Vector2(0, -35)), new Vector2(400, 90),
            "Gradual acceleration and deceleration instead of the base game's near-instant stop/start - you keep sliding a little after releasing input, and take a moment to get going. Also toggleable in-game with F9.",
            fontSize: 13f, color: new Color(1f, 1f, 1f, 0.6f));
    }
}

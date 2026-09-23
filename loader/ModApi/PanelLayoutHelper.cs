using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Recharge.ModApi
{
    internal static class PanelLayoutHelper
    {
        public static void NormalizePanelLayout(GameObject panel, float titleY, float closeY)
        {
            var root = panel.transform;

            // The panel is a clone of the vanilla Settings screen (see
            // MenuPanelRegistry.BuildBlankPanel) and inherits whatever
            // localScale that template carries - measured at ~1.2 on this
            // panel and its title in practice. Any caller that sizes the
            // panel from canvas-rect math (PanelLayout.Apply) is reasoning
            // in unscaled units, so a leftover 1.2x here silently renders
            // ~20% larger than intended and clips both the top and bottom
            // edge of the screen by a small, easy-to-miss margin. Reset it
            // to 1 on both the panel and its title so sizeDelta always maps
            // 1:1 to on-screen size.
            if (root is RectTransform panelRt) panelRt.localScale = Vector3.one;

            // Still-dormant vanilla controls (a dropdown's own option-list
            // Content, for instance - see PanelWidgets.CreateDropdown) can
            // legitimately need their own LayoutGroup/ContentSizeFitter to
            // ever populate correctly once cloned. This blanket cleanup is
            // only meant to fix the top-level settings-row group that
            // fights direct title/Close positioning, so anything living
            // inside a TMP_Dropdown is left alone.
            foreach (var lg in root.GetComponentsInChildren<LayoutGroup>(true))
            {
                if (lg.GetComponentInParent<TMP_Dropdown>(true) != null) continue;
                Object.Destroy(lg);
            }
            foreach (var fitter in root.GetComponentsInChildren<ContentSizeFitter>(true))
            {
                if (fitter.GetComponentInParent<TMP_Dropdown>(true) != null) continue;
                Object.Destroy(fitter);
            }

            var titleT = root.Find("Settings");
            if (titleT == null) return;
            IgnoreLayout(titleT.gameObject);
            if (titleT is RectTransform titleRt)
            {
                titleRt.localScale = Vector3.one;
                titleRt.anchoredPosition = new Vector2(0f, titleY);
            }

            var closeT = titleT.Find("Close");
            if (closeT == null) return;
            // Reparent so its position is panel-relative, not relative to
            // the title (which may itself be scaled/offset by the vanilla
            // template) - see AddPanelRow docs for how this was found.
            closeT.SetParent(root, false);
            IgnoreLayout(closeT.gameObject);
            if (closeT is RectTransform closeRt) closeRt.anchoredPosition = new Vector2(0f, closeY);
        }

        public static void IgnoreLayout(GameObject go)
        {
            var le = go.GetComponent<LayoutElement>();
            if (le == null) le = go.AddComponent<LayoutElement>();
            le.ignoreLayout = true;
        }
    }
}

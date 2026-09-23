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

            // The panel is a clone of the vanilla Settings screen and
            // inherits its ~1.2x localScale - left in place, PanelLayout's
            // unscaled sizeDelta math would render ~20% too large.
            if (root is RectTransform panelRt) panelRt.localScale = Vector3.one;

            // Skip anything under a TMP_Dropdown - its own option-list
            // Content can legitimately need a LayoutGroup/ContentSizeFitter
            // to populate; this cleanup only targets the top-level
            // settings-row group that fights direct title/Close positioning.
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
            // the (possibly scaled/offset) title.
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

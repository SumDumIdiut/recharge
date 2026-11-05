using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Recharge.ModApi
{
    internal static class MenuUiUtil
    {
        private static Transform FindLabelTransform(GameObject buttonGo) => buttonGo.transform.Find("Text (TMP)");
        private static TMP_Text FindLabel(GameObject buttonGo)
        {
            var t = FindLabelTransform(buttonGo);
            return t != null ? t.GetComponent<TMP_Text>() : null;
        }

        public static void SetButtonLabel(GameObject buttonGo, string text)
        {
            var labelT = FindLabelTransform(buttonGo);
            bool firstTakeover = labelT != null && labelT.GetComponent<ModLabel>() == null;
            var label = ModLabel.ForButton(buttonGo, text);
            if (label == null || !firstTakeover) return;
            // Defaults only on first takeover, so styling a mod applies afterwards
            // (wrapping, overflow) survives relabeling it every frame.
            var tmp = label.GetComponent<TMP_Text>();
            tmp.textWrappingMode = TextWrappingModes.NoWrap;
            tmp.overflowMode = TextOverflowModes.Ellipsis;
            FitLabel(tmp);
        }

        /// <summary>
        /// A long mod name shrinks to fit its row instead of being cut off: auto-size from the label's current size down to
        /// <see cref="MinFitFraction"/> of it (never below <see cref="MinFitSize"/>). Only a name too long even at that size is still cut with an ellipsis.
        /// </summary>
        internal static void FitLabel(TMP_Text tmp)
        {
            if (tmp == null) return;
            float max = tmp.enableAutoSizing && tmp.fontSizeMax > 0f ? tmp.fontSizeMax : tmp.fontSize;
            if (max <= 0f) return;
            tmp.enableAutoSizing = true;
            tmp.fontSizeMax = max;
            tmp.fontSizeMin = Mathf.Min(max, Mathf.Max(MinFitSize, max * MinFitFraction));
        }

        internal const float MinFitFraction = 0.4f;
        internal const float MinFitSize = 10f;

        // A cloned button's TMP `.color` reads as opaque white even when the
        // source renders visibly colored - real color comes from faceColor.
        public static void CopyButtonTextColor(GameObject sourceButtonGo, GameObject targetButtonGo)
        {
            var sourceTmp = FindLabel(sourceButtonGo);
            if (sourceTmp == null) return;
            SetButtonTextColor(targetButtonGo, sourceTmp.color);
        }

        public static void ScaleButtonFontSize(GameObject buttonGo, float multiplier)
        {
            var tmp = FindLabel(buttonGo);
            if (tmp == null) return;
            tmp.enableAutoSizing = false;
            tmp.fontSize *= multiplier;
        }

        public static void SetButtonTextColor(GameObject buttonGo, Color color)
        {
            var tmp = FindLabel(buttonGo);
            if (tmp == null) return;
            tmp.enableVertexGradient = false;
            tmp.color = color;
            tmp.faceColor = color;
        }
    }
}

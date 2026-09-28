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
            tmp.enableWordWrapping = false;
            tmp.overflowMode = TextOverflowModes.Ellipsis;
        }

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

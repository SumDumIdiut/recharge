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
            if (labelT == null) return;
            var loc = labelT.GetComponent<UnityEngine.Localization.Components.LocalizeStringEvent>();
            if (loc != null) Object.DestroyImmediate(loc);
            var tmp = labelT.GetComponent<TMP_Text>();
            if (tmp == null) return;
            tmp.text = text;
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

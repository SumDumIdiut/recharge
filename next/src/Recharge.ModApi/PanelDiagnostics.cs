using System.Text;
using UnityEngine;
using UnityEngine.UI;

namespace Recharge.ModApi
{
    /// <summary>Runtime ground-truth for panel layout debugging - logs real screen size, the Canvas ancestor chain, and a measured RectTransform tree instead of guessing at fixed pixel values.</summary>
    public static class PanelDiagnostics
    {
        public static Vector2 ScreenSize() => new Vector2(Screen.width, Screen.height);

        /// <summary>Logs Screen size, every ancestor Canvas, and a RectTransform tree dump three levels deep (enough for a panel's own rows/columns without flooding the log with widget internals).</summary>
        public static void LogPanelTree(IRechargeHost host, GameObject panel, string label = null)
        {
            var sb = new StringBuilder();
            sb.AppendLine($"[PanelDiagnostics] {label ?? panel.name}");
            sb.AppendLine($"  Screen: {Screen.width}x{Screen.height} (Display.main: system={Display.main.systemWidth}x{Display.main.systemHeight} rendering={Display.main.renderingWidth}x{Display.main.renderingHeight})");

            Canvas rootCanvas = null;
            foreach (var canvas in panel.GetComponentsInParent<Canvas>(true))
            {
                var canvasRt = canvas.transform as RectTransform;
                var scaler = canvas.GetComponent<CanvasScaler>();
                var cam = canvas.worldCamera;
                sb.AppendLine($"  Canvas '{canvas.name}' isRootCanvas={canvas.isRootCanvas} renderMode={canvas.renderMode} scaleFactor={canvas.scaleFactor} rect={canvasRt?.rect} pixelRect={canvas.pixelRect}");
                sb.AppendLine($"    worldCamera={(cam != null ? cam.name : "null")} pixelWidth={(cam != null ? cam.pixelWidth : -1)} pixelHeight={(cam != null ? cam.pixelHeight : -1)} viewportRect={(cam != null ? cam.rect.ToString() : "n/a")}");
                if (scaler != null)
                    sb.AppendLine($"    CanvasScaler uiScaleMode={scaler.uiScaleMode} referenceResolution={scaler.referenceResolution} matchWidthOrHeight={scaler.matchWidthOrHeight} screenMatchMode={scaler.screenMatchMode}");
                if (canvas.isRootCanvas) rootCanvas = canvas;
            }

            var renderCam = rootCanvas != null ? rootCanvas.worldCamera : null;
            if (panel.transform is RectTransform panelRt) DumpTree(sb, panelRt, 0, renderCam);
            host.Log(sb.ToString());
        }

        private static void DumpTree(StringBuilder sb, RectTransform rt, int depth, Camera renderCam)
        {
            DumpRect(sb, rt, depth, renderCam);
            if (depth >= 3) return; // don't flood the log with deep widget internals (button text, toggle checkmarks, ...)
            foreach (Transform childT in rt)
            {
                if (childT is RectTransform childRt) DumpTree(sb, childRt, depth + 1, renderCam);
            }
        }

        private static void DumpRect(StringBuilder sb, RectTransform rt, int depth, Camera renderCam)
        {
            var corners = new Vector3[4];
            rt.GetWorldCorners(corners);
            var indent = new string(' ', depth * 2);
            var blPx = RectTransformUtility.WorldToScreenPoint(renderCam, corners[0]);
            var trPx = RectTransformUtility.WorldToScreenPoint(renderCam, corners[2]);
            sb.AppendLine($"{indent}{rt.name} active={rt.gameObject.activeSelf} anchoredPos={rt.anchoredPosition} sizeDelta={rt.sizeDelta} pivot={rt.pivot} anchorMin={rt.anchorMin} anchorMax={rt.anchorMax} localScale={rt.localScale} lossyScale={rt.lossyScale} screenPx=[BL({blPx.x:0.0},{blPx.y:0.0}) TR({trPx.x:0.0},{trPx.y:0.0})]");
        }
    }
}

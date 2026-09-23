using UnityEngine;

namespace Recharge.ModApi
{
    /// <summary>Named anchor points within a PanelLayout's declared size.</summary>
    public enum PanelAnchor
    {
        TopLeft, TopCenter, TopRight,
        CenterLeft, Center, CenterRight,
        BottomLeft, BottomCenter, BottomRight,
    }

    /// <summary>
    /// Declares a panel's width/height once, then positions elements as an
    /// offset from a named anchor point (TopLeft, Center, BottomRight, ...)
    /// instead of hand-computing raw coordinates from the center every
    /// time - like CSS's top/left insets.
    ///
    /// <code>
    /// var layout = PanelLayout.Apply(panel, new Vector2(700, 640));
    /// layout.Place(closeButton, PanelAnchor.TopRight, new Vector2(-25, -25));
    /// layout.Place(footerLabel, PanelAnchor.BottomCenter, new Vector2(0, 20));
    /// </code>
    /// </summary>
    public readonly struct PanelLayout
    {
        public Vector2 Size { get; }

        public PanelLayout(Vector2 size) => Size = size;

        /// <summary>Sets panel's RectTransform.sizeDelta and returns a PanelLayout for it.</summary>
        public static PanelLayout Apply(GameObject panel, Vector2 size)
        {
            if (panel.TryGetComponent<RectTransform>(out var rt)) rt.sizeDelta = size;
            return new PanelLayout(size);
        }

        /// <summary>The raw position of a named anchor, relative to the panel's center.</summary>
        public Vector2 AnchorPoint(PanelAnchor anchor)
        {
            float halfW = Size.x / 2f;
            float halfH = Size.y / 2f;
            float x = anchor switch
            {
                PanelAnchor.TopLeft or PanelAnchor.CenterLeft or PanelAnchor.BottomLeft => -halfW,
                PanelAnchor.TopRight or PanelAnchor.CenterRight or PanelAnchor.BottomRight => halfW,
                _ => 0f,
            };
            float y = anchor switch
            {
                PanelAnchor.TopLeft or PanelAnchor.TopCenter or PanelAnchor.TopRight => halfH,
                PanelAnchor.BottomLeft or PanelAnchor.BottomCenter or PanelAnchor.BottomRight => -halfH,
                _ => 0f,
            };
            return new Vector2(x, y);
        }

        /// <summary>anchor's point plus offset - what you'd hand to a RectTransform's anchoredPosition.</summary>
        public Vector2 PositionOf(PanelAnchor anchor, Vector2 offset) => AnchorPoint(anchor) + offset;

        /// <summary>Centers the RectTransform's anchors/pivot and moves it to anchor + offset.</summary>
        public void Place(RectTransform rt, PanelAnchor anchor, Vector2 offset)
        {
            rt.anchorMin = new Vector2(0.5f, 0.5f);
            rt.anchorMax = new Vector2(0.5f, 0.5f);
            rt.pivot = new Vector2(0.5f, 0.5f);
            rt.anchoredPosition = PositionOf(anchor, offset);
        }

        public void Place(GameObject go, PanelAnchor anchor, Vector2 offset) => Place((RectTransform)go.transform, anchor, offset);
    }
}

using System;
using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

// A real Toggle, a real Slider, an expandable choice list (a hand-built
// alternative to TMP_Dropdown, which needs a fairly involved template
// hierarchy to work at all), and a ScrollRect-backed scrolling log.
internal static class AdvancedWidgets
{
    public static Toggle CreateToggle(Transform parent, TMP_FontAsset font, Vector2 pos, string label, bool initial, Action<bool> onChanged)
    {
        var go = new GameObject("Toggle", typeof(RectTransform));
        go.transform.SetParent(parent, false);
        var rt = (RectTransform)go.transform;
        rt.anchoredPosition = pos;
        rt.sizeDelta = new Vector2(320, 30);

        var bgGo = new GameObject("Background", typeof(RectTransform), typeof(Image));
        bgGo.transform.SetParent(go.transform, false);
        var bgRt = (RectTransform)bgGo.transform;
        bgRt.anchorMin = new Vector2(0, 0.5f);
        bgRt.anchorMax = new Vector2(0, 0.5f);
        bgRt.pivot = new Vector2(0, 0.5f);
        bgRt.sizeDelta = new Vector2(26, 26);
        var bgImg = bgGo.GetComponent<Image>();
        bgImg.color = new Color(1f, 1f, 1f, 0.12f);

        var checkGo = new GameObject("Checkmark", typeof(RectTransform), typeof(Image));
        checkGo.transform.SetParent(bgGo.transform, false);
        var checkRt = (RectTransform)checkGo.transform;
        checkRt.anchorMin = new Vector2(0.15f, 0.15f);
        checkRt.anchorMax = new Vector2(0.85f, 0.85f);
        checkRt.offsetMin = Vector2.zero;
        checkRt.offsetMax = Vector2.zero;
        var checkImg = checkGo.GetComponent<Image>();
        checkImg.color = new Color(0.5f, 1f, 0.6f, 1f);

        var toggle = go.AddComponent<Toggle>();
        toggle.targetGraphic = bgImg;
        toggle.graphic = checkImg;
        toggle.isOn = initial;
        toggle.onValueChanged.AddListener(v => onChanged?.Invoke(v));

        var labelTmp = CreateFloatingLabel(go.transform, font, new Vector2(38, 0), new Vector2(260, 28), label, TextAlignmentOptions.MidlineLeft);
        labelTmp.fontSize = 17;

        return toggle;
    }

    public static Slider CreateSlider(Transform parent, TMP_FontAsset font, Vector2 pos, Vector2 size, float min, float max, float initial, Action<float> onChanged, out TMP_Text valueLabel)
    {
        var container = new GameObject("SliderRow", typeof(RectTransform));
        container.transform.SetParent(parent, false);
        ((RectTransform)container.transform).anchoredPosition = pos;

        var sliderGo = new GameObject("Slider", typeof(RectTransform));
        sliderGo.transform.SetParent(container.transform, false);
        var sliderRt = (RectTransform)sliderGo.transform;
        sliderRt.anchoredPosition = Vector2.zero;
        sliderRt.sizeDelta = size;

        var bg = new GameObject("Background", typeof(RectTransform), typeof(Image));
        bg.transform.SetParent(sliderGo.transform, false);
        var bgRt = (RectTransform)bg.transform;
        bgRt.anchorMin = new Vector2(0, 0.3f);
        bgRt.anchorMax = new Vector2(1, 0.7f);
        bgRt.offsetMin = Vector2.zero;
        bgRt.offsetMax = Vector2.zero;
        bg.GetComponent<Image>().color = new Color(1f, 1f, 1f, 0.12f);

        var fillArea = new GameObject("Fill Area", typeof(RectTransform));
        fillArea.transform.SetParent(sliderGo.transform, false);
        var fillAreaRt = (RectTransform)fillArea.transform;
        fillAreaRt.anchorMin = new Vector2(0, 0.3f);
        fillAreaRt.anchorMax = new Vector2(1, 0.7f);
        fillAreaRt.offsetMin = new Vector2(4, 0);
        fillAreaRt.offsetMax = new Vector2(-4, 0);

        var fill = new GameObject("Fill", typeof(RectTransform), typeof(Image));
        fill.transform.SetParent(fillArea.transform, false);
        var fillRt = (RectTransform)fill.transform;
        fillRt.anchorMin = Vector2.zero;
        fillRt.anchorMax = new Vector2(0, 1);
        fillRt.sizeDelta = new Vector2(10, 0);
        fill.GetComponent<Image>().color = new Color(0.5f, 0.8f, 1f, 1f);

        var handleArea = new GameObject("Handle Slide Area", typeof(RectTransform));
        handleArea.transform.SetParent(sliderGo.transform, false);
        var handleAreaRt = (RectTransform)handleArea.transform;
        handleAreaRt.anchorMin = Vector2.zero;
        handleAreaRt.anchorMax = Vector2.one;
        handleAreaRt.offsetMin = new Vector2(8, 0);
        handleAreaRt.offsetMax = new Vector2(-8, 0);

        var handle = new GameObject("Handle", typeof(RectTransform), typeof(Image));
        handle.transform.SetParent(handleArea.transform, false);
        var handleRt = (RectTransform)handle.transform;
        handleRt.sizeDelta = new Vector2(16, 16);
        handle.GetComponent<Image>().color = Color.white;

        var slider = sliderGo.AddComponent<Slider>();
        slider.fillRect = fillRt;
        slider.handleRect = handleRt;
        slider.targetGraphic = handle.GetComponent<Image>();
        slider.direction = Slider.Direction.LeftToRight;
        slider.minValue = min;
        slider.maxValue = max;
        slider.value = initial;

        var label = CreateFloatingLabel(container.transform, font, new Vector2(size.x / 2f + 42, 0), new Vector2(70, size.y), Mathf.RoundToInt(initial).ToString(), TextAlignmentOptions.MidlineLeft);
        label.fontSize = 16;

        slider.onValueChanged.AddListener(v =>
        {
            label.text = Mathf.RoundToInt(v).ToString();
            onChanged?.Invoke(v);
        });

        valueLabel = label;
        return slider;
    }

    public static GameObject CreateFlatButton(Transform parent, TMP_FontAsset font, string name, Vector2 pos, Vector2 size, string label, float fontSize = 16f, TextAlignmentOptions align = TextAlignmentOptions.Center)
    {
        var go = new GameObject(name, typeof(RectTransform));
        go.transform.SetParent(parent, false);
        var rt = (RectTransform)go.transform;
        rt.anchoredPosition = pos;
        rt.sizeDelta = size;

        var img = go.AddComponent<Image>();
        var baseColor = new Color(1f, 1f, 1f, 0.1f);
        img.color = baseColor;
        var btn = go.AddComponent<Button>();
        btn.targetGraphic = img;

        var textGo = new GameObject("Text (TMP)", typeof(RectTransform));
        textGo.transform.SetParent(go.transform, false);
        var textRt = (RectTransform)textGo.transform;
        textRt.anchorMin = Vector2.zero;
        textRt.anchorMax = Vector2.one;
        textRt.offsetMin = align == TextAlignmentOptions.MidlineLeft ? new Vector2(10, 0) : Vector2.zero;
        textRt.offsetMax = Vector2.zero;
        var tmp = textGo.AddComponent<TextMeshProUGUI>();
        tmp.font = font;
        tmp.fontSize = fontSize;
        tmp.color = Color.white;
        tmp.alignment = align;
        tmp.text = label;
        tmp.enableWordWrapping = false;
        tmp.overflowMode = TextOverflowModes.Ellipsis;

        return go;
    }

    public static GameObject CreateExpandableChoiceList(Transform parent, TMP_FontAsset font, Vector2 pos, Vector2 size, IList<string> options, int initialIndex, Action<int> onSelected)
    {
        var root = new GameObject("ChoiceList", typeof(RectTransform));
        root.transform.SetParent(parent, false);
        var rootRt = (RectTransform)root.transform;
        rootRt.anchoredPosition = pos;
        rootRt.sizeDelta = size;

        var headerGo = CreateFlatButton(root.transform, font, "Header", Vector2.zero, size, options[initialIndex] + "  ▾", 16f, TextAlignmentOptions.MidlineLeft);
        var headerText = headerGo.transform.Find("Text (TMP)").GetComponent<TMP_Text>();

        const float rowHeight = 28f;
        var listGo = new GameObject("List", typeof(RectTransform), typeof(Image));
        listGo.transform.SetParent(root.transform, false);
        var listRt = (RectTransform)listGo.transform;
        listRt.anchorMin = new Vector2(0, 1);
        listRt.anchorMax = new Vector2(1, 1);
        listRt.pivot = new Vector2(0.5f, 1f);
        listRt.anchoredPosition = new Vector2(0, -size.y - 2f);
        listRt.sizeDelta = new Vector2(size.x, rowHeight * options.Count);
        listGo.GetComponent<Image>().color = new Color(0f, 0f, 0f, 0.9f);
        listGo.SetActive(false);

        for (int i = 0; i < options.Count; i++)
        {
            var index = i;
            var rowGo = CreateFlatButton(listGo.transform, font, "Row" + i, new Vector2(0, -i * rowHeight), new Vector2(size.x, rowHeight), options[i], 15f, TextAlignmentOptions.MidlineLeft);
            var rowRt = (RectTransform)rowGo.transform;
            rowRt.anchorMin = new Vector2(0, 1);
            rowRt.anchorMax = new Vector2(1, 1);
            rowRt.pivot = new Vector2(0.5f, 1f);
            rowGo.GetComponent<Button>().onClick.AddListener(() =>
            {
                headerText.text = options[index] + "  ▾";
                listGo.SetActive(false);
                onSelected?.Invoke(index);
            });
        }

        headerGo.GetComponent<Button>().onClick.AddListener(() => listGo.SetActive(!listGo.activeSelf));
        return root;
    }

    public static Action<string> CreateScrollableLog(Transform parent, TMP_FontAsset font, Vector2 pos, Vector2 size, out GameObject root, int maxLines = 30)
    {
        var rootGo = new GameObject("ScrollLog", typeof(RectTransform), typeof(Image));
        rootGo.transform.SetParent(parent, false);
        var rootRt = (RectTransform)rootGo.transform;
        rootRt.anchoredPosition = pos;
        rootRt.sizeDelta = size;
        rootGo.GetComponent<Image>().color = new Color(0f, 0f, 0f, 0.35f);

        var viewport = new GameObject("Viewport", typeof(RectTransform), typeof(Image), typeof(Mask));
        viewport.transform.SetParent(rootGo.transform, false);
        var viewportRt = (RectTransform)viewport.transform;
        viewportRt.anchorMin = Vector2.zero;
        viewportRt.anchorMax = Vector2.one;
        viewportRt.offsetMin = new Vector2(4, 4);
        viewportRt.offsetMax = new Vector2(-4, -4);
        viewport.GetComponent<Image>().color = Color.white;
        viewport.GetComponent<Mask>().showMaskGraphic = false;

        var content = new GameObject("Content", typeof(RectTransform), typeof(VerticalLayoutGroup), typeof(ContentSizeFitter));
        content.transform.SetParent(viewport.transform, false);
        var contentRt = (RectTransform)content.transform;
        contentRt.anchorMin = new Vector2(0, 1);
        contentRt.anchorMax = new Vector2(1, 1);
        contentRt.pivot = new Vector2(0.5f, 1f);
        contentRt.anchoredPosition = Vector2.zero;

        var vlg = content.GetComponent<VerticalLayoutGroup>();
        vlg.childForceExpandWidth = true;
        vlg.childForceExpandHeight = false;
        vlg.childControlHeight = true;
        vlg.childControlWidth = true;
        vlg.spacing = 2f;
        vlg.padding = new RectOffset(4, 4, 4, 4);

        content.GetComponent<ContentSizeFitter>().verticalFit = ContentSizeFitter.FitMode.PreferredSize;

        var scroll = rootGo.AddComponent<ScrollRect>();
        scroll.viewport = viewportRt;
        scroll.content = contentRt;
        scroll.horizontal = false;
        scroll.vertical = true;
        scroll.movementType = ScrollRect.MovementType.Clamped;
        scroll.scrollSensitivity = 18f;

        var lines = new List<GameObject>();
        void AppendLine(string text)
        {
            var rowGo = new GameObject("LogLine", typeof(RectTransform));
            rowGo.transform.SetParent(content.transform, false);
            var tmp = rowGo.AddComponent<TextMeshProUGUI>();
            tmp.font = font;
            tmp.fontSize = 14;
            tmp.color = new Color(1f, 1f, 1f, 0.85f);
            tmp.text = text;
            tmp.enableWordWrapping = true;
            rowGo.AddComponent<LayoutElement>().minHeight = 18f;
            lines.Add(rowGo);

            if (lines.Count > maxLines)
            {
                UnityEngine.Object.Destroy(lines[0]);
                lines.RemoveAt(0);
            }

            Canvas.ForceUpdateCanvases();
            scroll.verticalNormalizedPosition = 0f;
        }

        root = rootGo;
        return AppendLine;
    }

    private static TMP_Text CreateFloatingLabel(Transform parent, TMP_FontAsset font, Vector2 pos, Vector2 size, string text, TextAlignmentOptions align)
    {
        var go = new GameObject("Label", typeof(RectTransform));
        go.transform.SetParent(parent, false);
        var rt = (RectTransform)go.transform;
        rt.anchorMin = new Vector2(0, 0.5f);
        rt.anchorMax = new Vector2(0, 0.5f);
        rt.pivot = new Vector2(0, 0.5f);
        rt.anchoredPosition = pos;
        rt.sizeDelta = size;
        var tmp = go.AddComponent<TextMeshProUGUI>();
        tmp.font = font;
        tmp.color = Color.white;
        tmp.alignment = align;
        tmp.text = text;
        tmp.enableWordWrapping = false;
        return tmp;
    }
}

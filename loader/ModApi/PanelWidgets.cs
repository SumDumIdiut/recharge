using System;
using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace Recharge.ModApi
{
    /// <summary>
    /// Shared UI element builders for pause-menu panel content. Every mod
    /// was independently reimplementing its own CreateButton/CreateLabel/
    /// CreateDivider/etc. with small variations - use these instead so a
    /// fix or a new capability lands for every mod at once instead of
    /// drifting copies. Combine with PanelLayout for positioning.
    /// </summary>
    public static class PanelWidgets
    {
        public static readonly Color DefaultDividerColor = new Color(1f, 1f, 1f, 0.15f);
        public static readonly Color DefaultButtonBackground = new Color(1f, 1f, 1f, 0.08f);
        public static readonly Color DefaultButtonHoverBackground = new Color(1f, 1f, 1f, 0.16f);
        public static readonly Color DefaultAccentColor = new Color(1f, 0.85f, 0.4f); // the amber used for headings/highlights throughout these panels

        private static bool IsLeftAligned(TextAlignmentOptions a) =>
            a == TextAlignmentOptions.Left || a == TextAlignmentOptions.MidlineLeft ||
            a == TextAlignmentOptions.TopLeft || a == TextAlignmentOptions.BottomLeft;

        private static bool IsRightAligned(TextAlignmentOptions a) =>
            a == TextAlignmentOptions.Right || a == TextAlignmentOptions.MidlineRight ||
            a == TextAlignmentOptions.TopRight || a == TextAlignmentOptions.BottomRight;

        /// <summary>
        /// A clickable rectangle with a hover highlight and centered (or
        /// aligned) text. Pass showBackground:false for an invisible hit
        /// area - e.g. a full-width row where only the text itself should
        /// read as a button.
        /// </summary>
        public static GameObject CreateButton(
            Transform parent, TMP_FontAsset font, string name, Vector2 pos, Vector2 size, string label,
            float fontSize = 16f, Color? textColor = null, TextAlignmentOptions align = TextAlignmentOptions.Center,
            bool showBackground = true, Color? backgroundColor = null, Color? hoverBackgroundColor = null)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = pos;
            rt.sizeDelta = size;

            var img = go.AddComponent<Image>();
            var baseColor = showBackground ? (backgroundColor ?? DefaultButtonBackground) : new Color(0f, 0f, 0f, 0f);
            var hoverColor = hoverBackgroundColor ?? DefaultButtonHoverBackground;
            img.color = baseColor;

            var btn = go.AddComponent<Button>();
            btn.targetGraphic = img;

            var trigger = go.AddComponent<EventTrigger>();
            var enter = new EventTrigger.Entry { eventID = EventTriggerType.PointerEnter };
            enter.callback.AddListener(_ => img.color = hoverColor);
            trigger.triggers.Add(enter);
            var exit = new EventTrigger.Entry { eventID = EventTriggerType.PointerExit };
            exit.callback.AddListener(_ => img.color = baseColor);
            trigger.triggers.Add(exit);

            var textGo = new GameObject("Text (TMP)", typeof(RectTransform));
            textGo.transform.SetParent(go.transform, false);
            var textRt = (RectTransform)textGo.transform;
            textRt.anchorMin = Vector2.zero;
            textRt.anchorMax = Vector2.one;
            textRt.offsetMin = IsLeftAligned(align) ? new Vector2(10, 0) : Vector2.zero;
            textRt.offsetMax = IsRightAligned(align) ? new Vector2(-10, 0) : Vector2.zero;
            var tmp = textGo.AddComponent<TextMeshProUGUI>();
            tmp.font = font;
            tmp.fontSize = fontSize;
            tmp.color = textColor ?? Color.white;
            tmp.alignment = align;
            tmp.text = label;
            tmp.enableWordWrapping = false;
            tmp.overflowMode = TextOverflowModes.Ellipsis;

            return go;
        }

        public static TMP_Text CreateLabel(
            Transform parent, TMP_FontAsset font, Vector2 pos, Vector2 size, string text,
            float fontSize = 24f, Color? color = null, TextAlignmentOptions align = TextAlignmentOptions.Center)
        {
            var go = new GameObject("Label", typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = pos;
            rt.sizeDelta = size;
            var tmp = go.AddComponent<TextMeshProUGUI>();
            tmp.font = font;
            tmp.fontSize = fontSize;
            tmp.alignment = align;
            tmp.color = color ?? Color.white;
            tmp.text = text;
            return tmp;
        }

        public static GameObject CreateDivider(Transform parent, Vector2 pos, float width, Color? color = null)
        {
            var go = new GameObject("Divider", typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = pos;
            rt.sizeDelta = new Vector2(width, 2);
            go.AddComponent<Image>().color = color ?? DefaultDividerColor;
            return go;
        }

        /// <summary>The panel's own rounded-corner background sprite, found by walking up to the nearest ancestor Image that has one. For small controls use <see cref="FindDropdownSprites"/> instead - they use a different, tighter-bordered sprite.</summary>
        public static Sprite FindPanelSprite(Transform anyDescendant, out Image.Type imageType)
        {
            for (var t = anyDescendant; t != null; t = t.parent)
            {
                var img = t.GetComponent<Image>();
                if (img != null && img.sprite != null)
                {
                    imageType = img.type;
                    return img.sprite;
                }
            }
            imageType = Image.Type.Simple;
            return null;
        }

        /// <summary>The body/arrow sprites of a real vanilla TMP_Dropdown still sitting somewhere in this panel, read directly off it. Both null if none is found.</summary>
        public static void FindDropdownSprites(Transform anyDescendant, out Sprite bodySprite, out Sprite arrowSprite)
        {
            bodySprite = null;
            arrowSprite = null;
            for (var t = anyDescendant; t != null; t = t.parent)
            {
                var dropdown = t.GetComponentInChildren<TMP_Dropdown>(true);
                if (dropdown == null) continue;
                var bodyImg = dropdown.GetComponent<Image>();
                bodySprite = bodyImg != null ? bodyImg.sprite : null;
                var arrowImg = dropdown.transform.Find("Arrow")?.GetComponent<Image>();
                arrowSprite = arrowImg != null ? arrowImg.sprite : null;
                return;
            }
        }

        /// <summary>
        /// A decorative, non-interactive panel background - draws sprite
        /// (with the given Image.Type/pixelsPerUnitMultiplier) if given,
        /// else a plain dark translucent fill.
        /// </summary>
        public static Image CreateBox(Transform parent, Vector2 pos, Vector2 size, Sprite sprite = null, Image.Type imageType = Image.Type.Simple, float pixelsPerUnitMultiplier = 1f)
        {
            var go = new GameObject("Box", typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = pos;
            rt.sizeDelta = size;
            var img = go.AddComponent<Image>();
            if (sprite != null)
            {
                img.sprite = sprite;
                img.type = imageType;
                img.pixelsPerUnitMultiplier = pixelsPerUnitMultiplier;
                img.color = Color.white; // no tint - crushes a sprite's own border/shading detail otherwise
            }
            else
            {
                img.color = new Color(0f, 0f, 0f, 0.25f);
            }
            img.raycastTarget = false;
            return img;
        }

        public static Image CreateImage(Transform parent, Vector2 pos, Vector2 size)
        {
            var go = new GameObject("Image", typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = pos;
            rt.sizeDelta = size;
            var img = go.AddComponent<Image>();
            img.preserveAspect = true;
            return img;
        }

        public static TMP_InputField CreateInputField(Transform parent, TMP_FontAsset font, Vector2 pos, Vector2 size, string placeholder)
        {
            var go = new GameObject("InputField", typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = pos;
            rt.sizeDelta = size;
            go.AddComponent<Image>().color = new Color(1f, 1f, 1f, 0.08f);

            var textArea = new GameObject("Text Area", typeof(RectTransform));
            textArea.transform.SetParent(go.transform, false);
            var textAreaRt = (RectTransform)textArea.transform;
            textAreaRt.anchorMin = Vector2.zero;
            textAreaRt.anchorMax = Vector2.one;
            textAreaRt.offsetMin = new Vector2(12, 2);
            textAreaRt.offsetMax = new Vector2(-12, -2);
            textArea.AddComponent<RectMask2D>();

            var textGo = new GameObject("Text", typeof(RectTransform));
            textGo.transform.SetParent(textArea.transform, false);
            var textRt = (RectTransform)textGo.transform;
            textRt.anchorMin = Vector2.zero;
            textRt.anchorMax = Vector2.one;
            textRt.offsetMin = Vector2.zero;
            textRt.offsetMax = Vector2.zero;
            var text = textGo.AddComponent<TextMeshProUGUI>();
            text.font = font;
            text.fontSize = 18;
            text.color = Color.white;
            text.alignment = TextAlignmentOptions.MidlineLeft;
            text.enableWordWrapping = false;

            var placeholderGo = new GameObject("Placeholder", typeof(RectTransform));
            placeholderGo.transform.SetParent(textArea.transform, false);
            var placeholderRt = (RectTransform)placeholderGo.transform;
            placeholderRt.anchorMin = Vector2.zero;
            placeholderRt.anchorMax = Vector2.one;
            placeholderRt.offsetMin = Vector2.zero;
            placeholderRt.offsetMax = Vector2.zero;
            var placeholderText = placeholderGo.AddComponent<TextMeshProUGUI>();
            placeholderText.font = font;
            placeholderText.fontSize = 18;
            placeholderText.color = new Color(1f, 1f, 1f, 0.4f);
            placeholderText.text = placeholder;
            placeholderText.fontStyle = FontStyles.Italic;
            placeholderText.alignment = TextAlignmentOptions.MidlineLeft;

            var input = go.AddComponent<TMP_InputField>();
            input.textViewport = textAreaRt;
            input.textComponent = text;
            input.placeholder = placeholderText;
            input.text = "";
            return input;
        }

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

        /// <summary>
        /// A self-contained dropdown (click header to expand a list, click a row to pick it), themed like the
        /// vanilla Settings screen's own dropdown. Pass <paramref name="onOpenChanged"/> to hide another control
        /// the expanded list would otherwise cover, e.g. <c>onOpenChanged: open => otherButton.SetActive(!open)</c>.
        /// </summary>
        private static readonly Color DropdownBodyColor = new Color(0.93f, 0.93f, 0.93f, 1f);
        private static readonly Color DropdownHoverColor = new Color(0.83f, 0.83f, 0.83f, 1f);
        private static readonly Color DropdownTextColor = new Color(0.12f, 0.12f, 0.12f, 1f);
        private static readonly Color DropdownSelectedColor = new Color(0.22f, 0.72f, 0.32f, 1f);

        private static void ApplyRoundedSprite(Image img, Sprite sprite)
        {
            if (sprite == null) return;
            img.sprite = sprite;
            img.type = Image.Type.Sliced;
        }

        public static GameObject CreateDropdown(Transform parent, TMP_FontAsset font, Vector2 pos, Vector2 size, IList<string> options, int initialIndex, Action<int> onChanged, Action<bool> onOpenChanged = null)
        {
            int selected = Mathf.Clamp(initialIndex, 0, options.Count - 1);

            var root = new GameObject("Dropdown", typeof(RectTransform));
            root.transform.SetParent(parent, false);
            var rootRt = (RectTransform)root.transform;
            rootRt.anchoredPosition = pos;
            rootRt.sizeDelta = size;

            FindDropdownSprites(parent, out var bodySprite, out var arrowSprite);

            var headerGo = CreateButton(root.transform, font, "Header", Vector2.zero, size, options[selected], 16f, DropdownTextColor, TextAlignmentOptions.MidlineLeft,
                backgroundColor: DropdownBodyColor, hoverBackgroundColor: DropdownHoverColor);
            ApplyRoundedSprite(headerGo.GetComponent<Image>(), bodySprite);
            var headerText = headerGo.transform.Find("Text (TMP)").GetComponent<TMP_Text>();
            var headerTextRt = (RectTransform)headerText.transform;
            headerTextRt.offsetMax = new Vector2(-22f, headerTextRt.offsetMax.y); // leave room for the arrow

            GameObject arrowGo;
            if (arrowSprite != null)
            {
                arrowGo = new GameObject("Arrow", typeof(RectTransform), typeof(Image));
                arrowGo.transform.SetParent(headerGo.transform, false);
                var arrowImg = arrowGo.GetComponent<Image>();
                arrowImg.sprite = arrowSprite;
                arrowImg.color = DropdownTextColor;
                arrowImg.raycastTarget = false;
                ((RectTransform)arrowGo.transform).sizeDelta = new Vector2(14f, 14f);
            }
            else
            {
                arrowGo = CreateLabel(headerGo.transform, font, Vector2.zero, new Vector2(18f, size.y), "v", fontSize: 13f, color: DropdownTextColor).gameObject;
            }
            var arrowRt = (RectTransform)arrowGo.transform;
            arrowRt.anchorMin = new Vector2(1f, 0.5f);
            arrowRt.anchorMax = new Vector2(1f, 0.5f);
            arrowRt.pivot = new Vector2(1f, 0.5f);
            arrowRt.anchoredPosition = new Vector2(-14f, -1f);

            const int maxVisibleRows = 4;
            const float scrollbarWidth = 14f;
            float rowHeight = Mathf.Max(24f, size.y * 0.68f);
            int visibleRows = Mathf.Min(options.Count, maxVisibleRows);
            bool scrollable = options.Count > maxVisibleRows;
            float availableRowWidth = size.x - (scrollable ? scrollbarWidth + 8f : 0f);

            var listGo = new GameObject("List", typeof(RectTransform), typeof(Image), typeof(Canvas), typeof(GraphicRaycaster));
            listGo.transform.SetParent(root.transform, false);
            var listRt = (RectTransform)listGo.transform;
            listRt.anchorMin = new Vector2(0.5f, 1f);
            listRt.anchorMax = new Vector2(0.5f, 1f);
            listRt.pivot = new Vector2(0.5f, 1f);
            listRt.anchoredPosition = new Vector2(0, -size.y - 3f);
            listRt.sizeDelta = new Vector2(size.x, rowHeight * visibleRows + 10f);
            listGo.GetComponent<Image>().color = DropdownBodyColor;
            ApplyRoundedSprite(listGo.GetComponent<Image>(), bodySprite);
            var listCanvas = listGo.GetComponent<Canvas>();
            listCanvas.overrideSorting = true;
            listCanvas.sortingOrder = 500;
            listGo.SetActive(false);

            CreateDivider(listGo.transform, new Vector2(0, -1f), size.x - 8f, new Color(0f, 0f, 0f, 0.15f));

            var rowParent = listGo.transform;
            ScrollRect scrollRect = null;
            if (scrollable)
            {
                var viewportGo = new GameObject("Viewport", typeof(RectTransform), typeof(Image), typeof(Mask));
                viewportGo.transform.SetParent(listGo.transform, false);
                var viewportRt = (RectTransform)viewportGo.transform;
                viewportRt.anchorMin = Vector2.zero;
                viewportRt.anchorMax = Vector2.one;
                viewportRt.offsetMin = new Vector2(2f, 2f);
                viewportRt.offsetMax = new Vector2(-(scrollbarWidth + 4f), -6f);
                viewportGo.GetComponent<Image>().color = Color.white;
                viewportGo.GetComponent<Mask>().showMaskGraphic = false;

                var contentGo = new GameObject("Content", typeof(RectTransform));
                contentGo.transform.SetParent(viewportGo.transform, false);
                var contentRt = (RectTransform)contentGo.transform;
                contentRt.anchorMin = new Vector2(0f, 1f);
                contentRt.anchorMax = new Vector2(1f, 1f);
                contentRt.pivot = new Vector2(0.5f, 1f);
                contentRt.anchoredPosition = Vector2.zero;
                contentRt.sizeDelta = new Vector2(0f, rowHeight * options.Count + 4f);
                rowParent = contentRt;

                var scrollbarGo = new GameObject("Scrollbar", typeof(RectTransform), typeof(Image), typeof(Scrollbar));
                scrollbarGo.transform.SetParent(listGo.transform, false);
                var scrollbarRt = (RectTransform)scrollbarGo.transform;
                scrollbarRt.anchorMin = new Vector2(1f, 0f);
                scrollbarRt.anchorMax = new Vector2(1f, 1f);
                scrollbarRt.pivot = new Vector2(1f, 1f);
                scrollbarRt.anchoredPosition = new Vector2(-3f, -6f);
                scrollbarRt.sizeDelta = new Vector2(scrollbarWidth, -12f);
                scrollbarGo.GetComponent<Image>().color = new Color(0f, 0f, 0f, 0.06f);
                var scrollbar = scrollbarGo.GetComponent<Scrollbar>();
                scrollbar.direction = Scrollbar.Direction.BottomToTop;
                scrollbar.transition = Selectable.Transition.None;

                var handleAreaGo = new GameObject("Sliding Area", typeof(RectTransform));
                handleAreaGo.transform.SetParent(scrollbarGo.transform, false);
                var handleAreaRt = (RectTransform)handleAreaGo.transform;
                handleAreaRt.anchorMin = Vector2.zero;
                handleAreaRt.anchorMax = Vector2.one;
                handleAreaRt.offsetMin = new Vector2(1f, 1f);
                handleAreaRt.offsetMax = new Vector2(-1f, -1f);

                var handleGo = new GameObject("Handle", typeof(RectTransform), typeof(Image));
                handleGo.transform.SetParent(handleAreaGo.transform, false);
                var handleRt = (RectTransform)handleGo.transform;
                handleRt.anchorMin = Vector2.zero;
                handleRt.anchorMax = Vector2.one;
                handleRt.offsetMin = Vector2.zero;
                handleRt.offsetMax = Vector2.zero;
                var handleImg = handleGo.GetComponent<Image>();
                handleImg.color = DropdownSelectedColor;
                ApplyRoundedSprite(handleImg, bodySprite);
                scrollbar.handleRect = handleRt;
                scrollbar.targetGraphic = handleImg;

                scrollRect = listGo.AddComponent<ScrollRect>();
                scrollRect.content = contentRt;
                scrollRect.viewport = viewportRt;
                scrollRect.horizontal = false;
                scrollRect.vertical = true;
                scrollRect.verticalScrollbar = scrollbar;
                scrollRect.verticalScrollbarVisibility = ScrollRect.ScrollbarVisibility.Permanent;
                scrollRect.movementType = ScrollRect.MovementType.Clamped;
                scrollRect.scrollSensitivity = 18f;
                // Defaults to 0 (scrolled to the bottom) otherwise.
                scrollRect.verticalNormalizedPosition = 1f;
            }

            var rowImages = new List<Image>();
            var rowTexts = new List<TMP_Text>();
            var rowBaseColors = new List<Color>();
            for (int i = 0; i < options.Count; i++)
            {
                var index = i;
                bool isSelected = index == selected;
                var baseColor = isSelected ? DropdownSelectedColor : DropdownBodyColor;
                var rowGo = CreateButton(rowParent, font, "Row" + i, new Vector2(0, -6f - i * rowHeight), new Vector2(availableRowWidth, rowHeight), options[i], 15f,
                    isSelected ? Color.white : DropdownTextColor, TextAlignmentOptions.MidlineLeft,
                    backgroundColor: baseColor, hoverBackgroundColor: DropdownHoverColor);
                var rowRt = (RectTransform)rowGo.transform;
                // Top-center, not a (0,1)-(1,1) stretch: a stretch anchor
                // would add sizeDelta.x on top of the already-stretched
                // parent width instead of just setting it.
                rowRt.anchorMin = new Vector2(0.5f, 1f);
                rowRt.anchorMax = new Vector2(0.5f, 1f);
                rowRt.pivot = new Vector2(0.5f, 1f);
                var rowImage = rowGo.GetComponent<Image>();
                rowImages.Add(rowImage);
                rowTexts.Add(rowGo.transform.Find("Text (TMP)").GetComponent<TMP_Text>());
                rowBaseColors.Add(baseColor);

                var rowTrigger = rowGo.GetComponent<EventTrigger>();
                rowTrigger.triggers.Clear();
                var rowExit = new EventTrigger.Entry { eventID = EventTriggerType.PointerExit };
                rowExit.callback.AddListener(_ => rowImage.color = rowBaseColors[index]);
                rowTrigger.triggers.Add(rowExit);
                var rowEnter = new EventTrigger.Entry { eventID = EventTriggerType.PointerEnter };
                rowEnter.callback.AddListener(_ => rowImage.color = DropdownHoverColor);
                rowTrigger.triggers.Add(rowEnter);

                rowGo.GetComponent<Button>().onClick.AddListener(() =>
                {
                    selected = index;
                    headerText.text = options[index];
                    for (int r = 0; r < rowTexts.Count; r++)
                    {
                        bool nowSelected = r == index;
                        rowBaseColors[r] = nowSelected ? DropdownSelectedColor : DropdownBodyColor;
                        rowImages[r].color = rowBaseColors[r];
                        rowTexts[r].color = nowSelected ? Color.white : DropdownTextColor;
                    }
                    listGo.SetActive(false);
                    arrowGo.transform.localEulerAngles = Vector3.zero;
                    onChanged?.Invoke(index);
                    onOpenChanged?.Invoke(false);
                });
            }

            headerGo.GetComponent<Button>().onClick.AddListener(() =>
            {
                bool opening = !listGo.activeSelf;
                listGo.SetActive(opening);
                if (opening && scrollRect != null) scrollRect.verticalNormalizedPosition = 1f;
                arrowGo.transform.localEulerAngles = opening ? new Vector3(0, 0, 180f) : Vector3.zero;
                onOpenChanged?.Invoke(opening);
            });

            return root;
        }

        /// <summary>A ScrollRect-backed scrolling text log. Returns a function that appends one line (oldest lines drop off past maxLines).</summary>
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
}

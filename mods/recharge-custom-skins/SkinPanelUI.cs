using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace RechargeCustomSkins
{
    internal class SkinPanelUI : MonoBehaviour
    {
        private SkinController _controller;
        private TMP_FontAsset _font;

        private readonly List<GameObject> _skinRows = new List<GameObject>();
        private TMP_Text _pathLabel;
        private TMP_Text _statusLabel;
        private TMP_Text _pageLabel;
        private Transform _root;

        private const int PageSize = 4;
        private int _page;

        private Color _orange = new Color(1f, 0.5f, 0f, 1f);
        private static readonly Color Green = new Color(0.6f, 1f, 0.6f, 1f);

        public void Build(GameObject panel, TMP_FontAsset font, SkinController controller)
        {
            _root = panel.transform;
            _font = font;
            _controller = controller;

            foreach (var group in panel.GetComponentsInChildren<CanvasGroup>(true)) group.alpha = 1f;
            foreach (var anim in panel.GetComponentsInChildren<Animator>(true)) Object.Destroy(anim);

            var panelRt = panel.GetComponent<RectTransform>();
            if (panelRt != null) panelRt.sizeDelta = new Vector2(620f, 500f);

            var panelImg = panel.GetComponent<Image>();
            if (panelImg != null && panelImg.sprite != null)
            {
                _boxSprite = panelImg.sprite;
                _boxImageType = panelImg.type;
            }

            // Close/Back button is never touched - any change to it (position
            // included) makes it stop rendering.
            var titleGo = _root.Find("Settings")?.gameObject;
            var titleRt = titleGo != null ? titleGo.GetComponent<RectTransform>() : null;
            if (titleRt != null) titleRt.anchoredPosition += new Vector2(15f, 5f);

            CreateDivider(_root, new Vector2(0, 195), 600);

            var header = CreateLabel(_root, "SkinsHeader", new Vector2(0, 150), new Vector2(560, 26), "Choose a skin");
            header.fontSize = 20;
            header.color = new Color(1f, 1f, 1f, 0.65f);
            header.alignment = TextAlignmentOptions.MidlineLeft;

            CreateBox(_root, "SkinsBox", new Vector2(0, 65), new Vector2(580, 190), 2.5f);

            for (int i = 0; i < PageSize; i++)
            {
                int slot = i;
                var row = CreateButton(_root, "SkinRow" + i, new Vector2(0, 128 - slot * 38), new Vector2(540, 32), "", 18f, Color.white, TextAlignmentOptions.Center, false);
                row.GetComponent<Button>().onClick.AddListener(() => OnSkinRowClicked(slot));
                _skinRows.Add(row);
            }

            var prevGo = CreateButton(_root, "SkinsPrev", new Vector2(-90, -45), new Vector2(80, 28), "< Prev", 16f, _orange, TextAlignmentOptions.Right, false);
            prevGo.GetComponent<Button>().onClick.AddListener(() => ChangePage(-1));
            var nextGo = CreateButton(_root, "SkinsNext", new Vector2(90, -45), new Vector2(80, 28), "Next >", 16f, _orange, TextAlignmentOptions.Left, false);
            nextGo.GetComponent<Button>().onClick.AddListener(() => ChangePage(1));
            _pageLabel = CreateLabel(_root, "SkinsPage", new Vector2(0, -45), new Vector2(70, 26), "1/1");
            _pageLabel.fontSize = 15;

            var exportHeader = CreateLabel(_root, "ExportHeader", new Vector2(0, -82), new Vector2(560, 26), "Export skin template");
            exportHeader.fontSize = 20;
            exportHeader.color = new Color(1f, 1f, 1f, 0.65f);
            exportHeader.alignment = TextAlignmentOptions.MidlineLeft;

            CreateBox(_root, "ExportBox", new Vector2(0, -112), new Vector2(580, 34), 10f);
            _pathLabel = CreateLabel(_root, "ExportPath", new Vector2(0, -112), new Vector2(560, 26), "");
            _pathLabel.fontSize = 15;
            _pathLabel.alignment = TextAlignmentOptions.MidlineLeft;
            _pathLabel.enableWordWrapping = false;
            _pathLabel.overflowMode = TextOverflowModes.Ellipsis;
            _pathLabel.color = new Color(0.85f, 0.85f, 0.85f, 1f);

            var browseGo = CreateButton(_root, "Browse", new Vector2(-150, -155), new Vector2(180, 30), "Browse...", 17f, _orange, TextAlignmentOptions.Center, false);
            browseGo.GetComponent<Button>().onClick.AddListener(OnBrowseClicked);
            var exportGo = CreateButton(_root, "ExportNow", new Vector2(150, -155), new Vector2(180, 30), "Export", 17f, _orange, TextAlignmentOptions.Center, false);
            exportGo.GetComponent<Button>().onClick.AddListener(OnExportClicked);

            _statusLabel = CreateLabel(_root, "ExportStatus", new Vector2(0, -188), new Vector2(400, 24), "");
            _statusLabel.fontSize = 14;
            _statusLabel.enableWordWrapping = false;
            _statusLabel.overflowMode = TextOverflowModes.Ellipsis;
            _statusLabel.color = Green;

            Refresh();
        }

        private void OnEnable() => Refresh();

        private const float RowSpacing = 38f;
        private const float BoxCenterY = 65f;

        private void Refresh()
        {
            var names = _controller.SkinDisplayNames;
            int totalPages = Mathf.Max(1, Mathf.CeilToInt(names.Count / (float)PageSize));
            if (_page >= totalPages) _page = totalPages - 1;
            if (_page < 0) _page = 0;
            _pageLabel.text = (_page + 1) + "/" + totalPages;

            int startIdx = _page * PageSize;
            int count = Mathf.Clamp(names.Count - startIdx, 0, PageSize);
            float blockTopY = BoxCenterY + (count - 1) * RowSpacing / 2f;

            for (int i = 0; i < PageSize; i++)
            {
                var row = _skinRows[i];
                if (i >= count)
                {
                    row.SetActive(false);
                    continue;
                }
                row.SetActive(true);
                var rt = (RectTransform)row.transform;
                rt.anchoredPosition = new Vector2(rt.anchoredPosition.x, blockTopY - i * RowSpacing);

                int displayIndex = startIdx + i;
                bool isCurrent = displayIndex == _controller.CurrentIndex + 1;
                var label = row.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
                if (label != null)
                {
                    label.text = (isCurrent ? "> " : "") + names[displayIndex];
                    label.color = isCurrent ? Green : Color.white;
                }
            }

            _pathLabel.text = _controller.ExportDir;
        }

        private void OnSkinRowClicked(int slot)
        {
            int displayIndex = _page * PageSize + slot;
            if (displayIndex >= _controller.SkinDisplayNames.Count) return;
            _controller.SelectDisplayIndex(displayIndex);
            _statusLabel.text = "";
            Refresh();
        }

        private void ChangePage(int delta)
        {
            _page += delta;
            Refresh();
        }

        private void OnBrowseClicked()
        {
            var picked = NativeFolderPicker.PickFolder("Choose where to save the skin template");
            if (!string.IsNullOrEmpty(picked))
            {
                _controller.ExportDir = picked;
                Refresh();
            }
        }

        private void OnExportClicked()
        {
            bool ok = _controller.ExportTemplate(out var message);
            _statusLabel.text = message;
            _statusLabel.color = ok ? Green : new Color(1f, 0.6f, 0.6f, 1f);
        }

        private GameObject CreateButton(Transform parent, string name, Vector2 anchoredPos, Vector2 size, string label, float fontSize, Color color, TextAlignmentOptions align, bool showBox)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = anchoredPos;
            rt.sizeDelta = size;

            var img = go.AddComponent<Image>();
            var baseColor = showBox ? new Color(1f, 1f, 1f, 0.05f) : new Color(0f, 0f, 0f, 0f);
            img.color = baseColor;

            var btn = go.AddComponent<Button>();
            btn.targetGraphic = img;

            var trigger = go.AddComponent<EventTrigger>();
            var enterEntry = new EventTrigger.Entry { eventID = EventTriggerType.PointerEnter };
            enterEntry.callback.AddListener(_ => img.color = new Color(1f, 1f, 1f, 0.15f));
            trigger.triggers.Add(enterEntry);
            var exitEntry = new EventTrigger.Entry { eventID = EventTriggerType.PointerExit };
            exitEntry.callback.AddListener(_ => img.color = baseColor);
            trigger.triggers.Add(exitEntry);

            var textGo = new GameObject("Text (TMP)", typeof(RectTransform));
            textGo.transform.SetParent(go.transform, false);
            var textRt = (RectTransform)textGo.transform;
            textRt.anchorMin = Vector2.zero;
            textRt.anchorMax = Vector2.one;
            textRt.offsetMin = align == TextAlignmentOptions.Left ? new Vector2(10, 0) : Vector2.zero;
            textRt.offsetMax = align == TextAlignmentOptions.Right ? new Vector2(-10, 0) : Vector2.zero;
            var tmp = textGo.AddComponent<TextMeshProUGUI>();
            tmp.font = _font;
            tmp.fontSize = fontSize;
            tmp.alignment = align;
            tmp.color = color;
            tmp.text = label;
            tmp.enableWordWrapping = false;
            tmp.overflowMode = TextOverflowModes.Ellipsis;

            return go;
        }

        private Sprite _boxSprite;
        private Image.Type _boxImageType;

        private GameObject CreateBox(Transform parent, string name, Vector2 anchoredPos, Vector2 size, float pixelsPerUnitMultiplier)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = anchoredPos;
            rt.sizeDelta = size;
            var img = go.AddComponent<Image>();
            if (_boxSprite != null)
            {
                img.sprite = _boxSprite;
                img.type = _boxImageType;
                img.pixelsPerUnitMultiplier = pixelsPerUnitMultiplier;
                img.color = Color.white; // no tint - crushes the sprite's border detail otherwise
            }
            else
            {
                img.color = new Color(0f, 0f, 0f, 0.25f);
            }
            img.raycastTarget = false;
            return go;
        }

        private TMP_Text CreateLabel(Transform parent, string name, Vector2 anchoredPos, Vector2 size, string text)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = anchoredPos;
            rt.sizeDelta = size;
            var tmp = go.AddComponent<TextMeshProUGUI>();
            tmp.font = _font;
            tmp.fontSize = 24;
            tmp.alignment = TextAlignmentOptions.Center;
            tmp.color = Color.white;
            tmp.text = text;
            return tmp;
        }

        private GameObject CreateDivider(Transform parent, Vector2 anchoredPos, float width)
        {
            var go = new GameObject("Divider", typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = anchoredPos;
            rt.sizeDelta = new Vector2(width, 2);
            var img = go.AddComponent<Image>();
            img.color = new Color(1f, 1f, 1f, 0.15f);
            return go;
        }
    }
}

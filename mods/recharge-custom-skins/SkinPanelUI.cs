using System.Collections.Generic;
using Recharge.ModApi;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace RechargeCustomSkins
{
    internal class SkinPanelUI : MonoBehaviour
    {
        private SkinController _controller;
        private GameObject _buttonTemplate;
        private TMP_FontAsset _font;

        private readonly List<GameObject> _skinRows = new List<GameObject>();
        private TMP_Text _pathLabel;
        private TMP_Text _statusLabel;
        private TMP_Text _pageLabel;
        private Transform _root;

        private const int PageSize = 4;
        private int _page;

        public void Build(GameObject panel, TMP_FontAsset font, GameObject buttonTemplate, SkinController controller)
        {
            _root = panel.transform;
            _font = font;
            _buttonTemplate = buttonTemplate;
            _controller = controller;

            foreach (var group in panel.GetComponentsInChildren<CanvasGroup>(true)) group.alpha = 1f;
            foreach (var anim in panel.GetComponentsInChildren<Animator>(true)) Object.Destroy(anim);

            CreateLabel(_root, "SkinsHeader", new Vector2(0, 170), new Vector2(420, 30), "Choose a skin", 23, TextAlignmentOptions.Center);

            for (int i = 0; i < PageSize; i++)
            {
                int slot = i;
                var row = CloneButton(_root, "SkinRow" + i, new Vector2(0, 116 - slot * 50), new Vector2(400, 42), null, 22f);
                var button = row.GetComponent<Button>();
                button.onClick.AddListener(() => OnSkinRowClicked(slot));
                _skinRows.Add(row);
            }

            var prevGo = CloneButton(_root, "SkinsPrev", new Vector2(-155, -70), new Vector2(60, 38), "<", 21f);
            prevGo.GetComponent<Button>().onClick.AddListener(() => ChangePage(-1));
            var nextGo = CloneButton(_root, "SkinsNext", new Vector2(155, -70), new Vector2(60, 38), ">", 21f);
            nextGo.GetComponent<Button>().onClick.AddListener(() => ChangePage(1));
            _pageLabel = CreateLabel(_root, "SkinsPage", new Vector2(0, -70), new Vector2(160, 30), "1/1", 19, TextAlignmentOptions.Center);

            CreateDivider(_root, new Vector2(0, -100), 440);

            CreateLabel(_root, "ExportHeader", new Vector2(0, -126), new Vector2(420, 26), "Export skin template", 21, TextAlignmentOptions.Center);

            _pathLabel = CreateLabel(_root, "ExportPath", new Vector2(0, -154), new Vector2(430, 24), "", 15, TextAlignmentOptions.Center);
            _pathLabel.enableWordWrapping = false;
            _pathLabel.overflowMode = TextOverflowModes.Ellipsis;
            _pathLabel.color = new Color(0.85f, 0.85f, 0.85f, 1f);

            var browseGo = CloneButton(_root, "Browse", new Vector2(-110, -188), new Vector2(200, 44), "Browse...", 20f);
            browseGo.GetComponent<Button>().onClick.AddListener(OnBrowseClicked);
            var exportGo = CloneButton(_root, "ExportNow", new Vector2(110, -188), new Vector2(200, 44), "Export Template", 20f);
            exportGo.GetComponent<Button>().onClick.AddListener(OnExportClicked);

            _statusLabel = CreateLabel(_root, "ExportStatus", new Vector2(35, -222), new Vector2(300, 24), "", 15, TextAlignmentOptions.Center);
            _statusLabel.enableWordWrapping = false;
            _statusLabel.overflowMode = TextOverflowModes.Ellipsis;
            _statusLabel.color = new Color(0.6f, 1f, 0.6f, 1f);

            var backGo = _root.Find("Settings")?.Find("Close")?.gameObject;
            if (backGo != null)
            {
                var backRt = (RectTransform)backGo.transform;
                backRt.anchoredPosition = new Vector2(-175, -222);
                backRt.sizeDelta = new Vector2(100, 36);
                var backTmp = backGo.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
                if (backTmp != null) { backTmp.enableAutoSizing = false; backTmp.fontSize = 19f; }
            }

            Refresh();
        }

        private void OnEnable() => Refresh();

        private void Refresh()
        {
            var names = _controller.SkinDisplayNames;
            int totalPages = Mathf.Max(1, Mathf.CeilToInt(names.Count / (float)PageSize));
            if (_page >= totalPages) _page = totalPages - 1;
            if (_page < 0) _page = 0;
            _pageLabel.text = (_page + 1) + "/" + totalPages;

            for (int i = 0; i < PageSize; i++)
            {
                int displayIndex = _page * PageSize + i;
                var row = _skinRows[i];
                if (displayIndex >= names.Count)
                {
                    row.SetActive(false);
                    continue;
                }
                row.SetActive(true);
                bool isCurrent = displayIndex == _controller.CurrentIndex + 1;
                var label = row.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>();
                if (label != null)
                {
                    label.text = (isCurrent ? "> " : "") + names[displayIndex];
                    label.color = isCurrent ? new Color(0.6f, 1f, 0.6f, 1f) : Color.white;
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
            _statusLabel.color = ok ? new Color(0.6f, 1f, 0.6f, 1f) : new Color(1f, 0.6f, 0.6f, 1f);
        }

        private GameObject CloneButton(Transform parent, string name, Vector2 anchoredPos, Vector2 size, string labelOverride = null, float fontSize = 20f)
        {
            var go = Object.Instantiate(_buttonTemplate, parent);
            go.name = name;
            go.SetActive(true);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = anchoredPos;
            rt.sizeDelta = size;

            foreach (var loc in go.GetComponentsInChildren<UnityEngine.Localization.Components.LocalizeStringEvent>(true))
                Object.DestroyImmediate(loc);

            var label = go.transform.Find("Text (TMP)");
            if (label != null)
            {
                var tmp = label.GetComponent<TMP_Text>();
                if (tmp != null)
                {
                    tmp.text = labelOverride ?? name;
                    tmp.enableAutoSizing = false;
                    tmp.fontSize = fontSize;
                    tmp.enableWordWrapping = false;
                    tmp.overflowMode = TextOverflowModes.Ellipsis;
                }
            }

            PauseMenuHelper.CopyButtonTextColor(_buttonTemplate, go);

            var button = go.GetComponent<Button>();
            button.onClick = new Button.ButtonClickedEvent();
            return go;
        }

        private TMP_Text CreateLabel(Transform parent, string name, Vector2 anchoredPos, Vector2 size, string text, float fontSize, TextAlignmentOptions align)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var rt = (RectTransform)go.transform;
            rt.anchoredPosition = anchoredPos;
            rt.sizeDelta = size;
            var tmp = go.AddComponent<TextMeshProUGUI>();
            tmp.font = _font;
            tmp.fontSize = fontSize;
            tmp.alignment = align;
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

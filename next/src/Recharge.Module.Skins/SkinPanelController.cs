using System;
using System.Collections.Generic;
using Recharge.ModApi;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Recharge.Module.Skins
{
    /// <summary>
    /// The in-game Skinmod picker. Mirrors Recharge.Module.Net's HostPanelController:
    /// a MonoBehaviour owned by SkinsModule that registers one row in Juke's Mods
    /// menu and builds a panel from Recharge.ModApi.PanelWidgets. The skins
    /// themselves come from SkinController's own data folder (via SkinFiles);
    /// nothing is duplicated here except the presentation.
    /// </summary>
    internal sealed class SkinPanelController : MonoBehaviour
    {
        // Not "CustomSkins": the ModApi hides that row name because the built-in
        // module replaced the old hub mod, which used to register it.
        private const string RowName = "SkinmodPanel";
        private const string VanillaLabel = "Default (vanilla)";

        private const int PageSize = 6;
        private const float RowSpacing = 36f;
        private const float RowWidth = 410f;
        private const float RowHeight = 30f;
        private const float FirstRowY = 100f;
        private const float PagerY = -165f;

        private IRechargeHost _host;
        private SkinController _controller;
        private GameObject _panel;
        private TMP_FontAsset _font;
        private bool _built;
        private bool _wasOpen;
        private int _page;
        private string _lastKey;

        private readonly List<GameObject> _rows = new List<GameObject>();
        private readonly List<TMP_Text> _rowLabels = new List<TMP_Text>();
        private TMP_Text _pageLabel;
        private Button _prevButton;
        private Button _nextButton;
        private Image _highlight;

        public void Init(IRechargeHost host, SkinController controller)
        {
            _host = host;
            _controller = controller;
        }

        /// <summary>Called on every scene load, just like the DOTnet module's row.</summary>
        public void InstallMenuRow(pauseMenuScript menu)
        {
            if (menu == null) return;
            try
            {
                var panel = PauseMenuHelper.AddPanelRow(menu, RowName, "Skinmod");
                if (panel == null) return;
                _panel = panel;

                if (!_built)
                {
                    _font = FindFont(panel);
                    _built = Build(panel);
                }
                Refresh();
            }
            catch (Exception e)
            {
                _host?.LogWarning("[CustomSkins] couldn't install the in-game skin picker: " + e.Message);
            }
        }

        private void Update()
        {
            if (_panel == null || !_panel.activeInHierarchy)
            {
                _wasOpen = false;
                return;
            }

            if (!_wasOpen)
            {
                _wasOpen = true;
                // Skins downloaded or dropped in while the game was open.
                try { _controller?.Rescan(); } catch (Exception e) { _host?.LogWarning("[CustomSkins] rescan failed: " + e.Message); }
                Refresh();
                return;
            }

            string key = (_controller == null ? "?" : _controller.CurrentIndex.ToString()) + "/" + _page;
            if (key != _lastKey) Refresh();
        }

        private bool Build(GameObject panel)
        {
            var root = panel.transform;
            // Pull the title/close in to match this smaller panel (the default
            // places them at +/-300, i.e. for a ~600-tall panel, which left the
            // title floating above and a big empty band under it).
            PauseMenuHelper.NormalizePanelLayout(panel, 210f, -210f);
            var panelRt = panel.GetComponent<RectTransform>();
            if (panelRt != null) panelRt.sizeDelta = new Vector2(480f, 500f);

            // The native panel title already reads "Skinmod", so a hint and a
            // single divider sit just under it, above the list.
            AddLabel(root, "SkinPanel_Hint", new Vector2(0, 170), new Vector2(440, 24), "Pick a skin to wear it in game",
                15f, new Color(1f, 1f, 1f, 0.7f), TextAlignmentOptions.Center);
            PanelWidgets.CreateDivider(root, new Vector2(0, 150), 440);

            var boxSprite = PanelWidgets.FindPanelSprite(root, out var boxType);
            PanelWidgets.CreateBox(root, new Vector2(0, -5), new Vector2(440, 270), boxSprite, boxType, 2.2f);

            // A persistent amber highlight sits behind the current skin's row
            // (created before the rows so the row text stays on top).
            _highlight = PanelWidgets.CreateSwatch(root, new Vector2(0, FirstRowY), new Vector2(RowWidth + 10f, RowSpacing - 2f),
                new Color(PanelWidgets.DefaultAccentColor.r, PanelWidgets.DefaultAccentColor.g, PanelWidgets.DefaultAccentColor.b, 0.22f));
            _highlight.raycastTarget = false;
            _highlight.gameObject.name = "SkinHighlight";
            _highlight.gameObject.SetActive(false);

            for (int i = 0; i < PageSize; i++)
            {
                int slot = i;
                var go = AddButton(root, "SkinRow" + i, new Vector2(0, FirstRowY - i * RowSpacing),
                    new Vector2(RowWidth, RowHeight), "", 18f, Color.white, TextAlignmentOptions.Center,
                    () => OnSkinRowClicked(slot));
                _rows.Add(go);
                _rowLabels.Add(LabelOf(go));
            }

            _prevButton = AddButton(root, "SkinsPrev", new Vector2(-100, PagerY), new Vector2(100, 34),
                "< Prev", 17f, PanelWidgets.DefaultAccentColor, TextAlignmentOptions.Right, () => ChangePage(-1)).GetComponent<Button>();
            _nextButton = AddButton(root, "SkinsNext", new Vector2(100, PagerY), new Vector2(100, 34),
                "Next >", 17f, PanelWidgets.DefaultAccentColor, TextAlignmentOptions.Left, () => ChangePage(1)).GetComponent<Button>();
            _pageLabel = AddLabel(root, "SkinsPage", new Vector2(0, PagerY), new Vector2(80, 28), "1/1",
                16f, new Color(1f, 1f, 1f, 0.75f), TextAlignmentOptions.Center);

            PanelWidgets.CreateDivider(root, new Vector2(0, -190), 440);
            return true;
        }

        private void Refresh()
        {
            if (!_built || _controller == null) return;
            var names = _controller.SkinDisplayNames;
            int count = names == null ? 0 : names.Count;
            int totalPages = Mathf.Max(1, Mathf.CeilToInt(count / (float)PageSize));
            _page = Mathf.Clamp(_page, 0, totalPages - 1);

            if (_pageLabel != null)
            {
                _pageLabel.text = (totalPages > 1 ? (_page + 1) + "/" + totalPages : "1/1");
                PanelWidgets.FitLabel(_pageLabel);
            }
            if (_prevButton != null) _prevButton.interactable = _page > 0;
            if (_nextButton != null) _nextButton.interactable = _page < totalPages - 1;

            int current = _controller.CurrentIndex + 1; // display index; 0 = vanilla
            bool currentOnPage = current >= _page * PageSize && current < (_page + 1) * PageSize && current < count;
            if (_highlight != null)
            {
                _highlight.gameObject.SetActive(currentOnPage);
                if (currentOnPage)
                    _highlight.rectTransform.anchoredPosition = new Vector2(0, FirstRowY - (current - _page * PageSize) * RowSpacing);
            }

            for (int i = 0; i < _rows.Count; i++)
            {
                var row = _rows[i];
                int displayIndex = _page * PageSize + i;
                bool available = names != null && displayIndex < count;
                if (row == null) continue;
                row.SetActive(available);
                if (!available) continue;

                string name = displayIndex == 0 ? VanillaLabel : names[displayIndex];
                var label = _rowLabels[i];
                if (label == null) continue;
                label.richText = false; // skin names are user-chosen: "<" must show as-is
                label.text = name ?? "";
                label.color = Color.white; // the amber highlight marks the worn skin
                PanelWidgets.FitLabel(label);
            }

            _lastKey = _controller.CurrentIndex + "/" + _page;
        }

        private void OnSkinRowClicked(int slot)
        {
            if (_controller == null) return;
            int displayIndex = _page * PageSize + slot;
            var names = _controller.SkinDisplayNames;
            if (names == null || displayIndex < 0 || displayIndex >= names.Count) return;
            try
            {
                _controller.SelectDisplayIndex(displayIndex);
                // Vanilla goes through the controller's CloneSkinApplier.RestoreVanilla()
                // branch; every other row is applied now with CloneSkinApplier.Apply.
                _controller.ApplySelectedNow();
                Refresh();
            }
            catch (Exception e)
            {
                _host?.LogWarning("[CustomSkins] couldn't switch skins: " + e.Message);
            }
        }

        private void ChangePage(int delta)
        {
            _page += delta;
            Refresh();
        }

        private TMP_Text AddLabel(Transform parent, string name, Vector2 pos, Vector2 size, string text,
            float fontSize, Color color, TextAlignmentOptions align)
        {
            var tmp = PanelWidgets.CreateLabel(parent, _font, pos, size, text, fontSize, color, align);
            tmp.name = name;
            tmp.richText = false;
            tmp.fontSizeMin = PanelWidgets.MinFitFontSize;
            tmp.fontSizeMax = fontSize;
            PanelWidgets.FitLabel(tmp);
            return tmp;
        }

        private GameObject AddButton(Transform parent, string name, Vector2 pos, Vector2 size, string label,
            float fontSize, Color textColor, TextAlignmentOptions align, Action onClick)
        {
            var go = PanelWidgets.CreateButton(parent, _font, name, pos, size, label, fontSize, textColor, align);
            var tmp = LabelOf(go);
            if (tmp != null)
            {
                tmp.richText = false;
                tmp.fontSizeMin = PanelWidgets.MinFitFontSize;
                tmp.fontSizeMax = fontSize;
                PanelWidgets.FitLabel(tmp);
            }
            var button = go.GetComponent<Button>();
            if (button != null && onClick != null) button.onClick.AddListener(() => onClick());
            return go;
        }

        private static TMP_Text LabelOf(GameObject go) =>
            go != null && go.transform.Find("Text (TMP)") != null
                ? go.transform.Find("Text (TMP)").GetComponent<TMP_Text>()
                : null;

        private static TMP_FontAsset FindFont(GameObject panel)
        {
            try
            {
                var title = panel.transform.Find("Settings") ?? (panel.transform.childCount > 0 ? panel.transform.GetChild(0) : null);
                var tmp = title != null ? title.GetComponentInChildren<TMP_Text>(true) : null;
                return tmp != null && tmp.font != null ? tmp.font : TMP_Settings.defaultFontAsset;
            }
            catch (Exception)
            {
                return null; // TMP falls back to its own default asset
            }
        }
    }
}

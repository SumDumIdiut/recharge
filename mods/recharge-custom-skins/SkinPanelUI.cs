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
        private TMP_FontAsset _font;

        private readonly List<GameObject> _skinRows = new List<GameObject>();
        private TMP_Text _pageLabel;
        private Transform _root;

        private const int PageSize = 7;
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

            PanelWidgets.CreateDivider(_root, new Vector2(0, 195), 600);

            PanelWidgets.CreateLabel(_root, _font, new Vector2(0, 150), new Vector2(560, 26), "Choose a skin",
                fontSize: 20f, color: new Color(1f, 1f, 1f, 0.65f), align: TextAlignmentOptions.MidlineLeft);

            PanelWidgets.CreateBox(_root, new Vector2(0, BoxCenterY), new Vector2(580, 304), _boxSprite, _boxImageType, 2.5f);

            for (int i = 0; i < PageSize; i++)
            {
                int slot = i;
                var row = PanelWidgets.CreateButton(_root, _font, "SkinRow" + i, new Vector2(0, 122 - slot * 38), new Vector2(540, 32), "", 18f, Color.white, TextAlignmentOptions.Center, false);
                row.GetComponent<Button>().onClick.AddListener(() => OnSkinRowClicked(slot));
                _skinRows.Add(row);
            }

            var prevGo = PanelWidgets.CreateButton(_root, _font, "SkinsPrev", new Vector2(-90, -159), new Vector2(80, 28), "< Prev", 16f, _orange, TextAlignmentOptions.Right, false);
            prevGo.GetComponent<Button>().onClick.AddListener(() => ChangePage(-1));
            var nextGo = PanelWidgets.CreateButton(_root, _font, "SkinsNext", new Vector2(90, -159), new Vector2(80, 28), "Next >", 16f, _orange, TextAlignmentOptions.Left, false);
            nextGo.GetComponent<Button>().onClick.AddListener(() => ChangePage(1));
            _pageLabel = PanelWidgets.CreateLabel(_root, _font, new Vector2(0, -159), new Vector2(70, 26), "1/1", fontSize: 15f);

            Refresh();
        }

        private void OnEnable() => Refresh();

        private const float RowSpacing = 38f;
        private const float BoxCenterY = 8f;

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
        }

        private void OnSkinRowClicked(int slot)
        {
            int displayIndex = _page * PageSize + slot;
            if (displayIndex >= _controller.SkinDisplayNames.Count) return;
            _controller.SelectDisplayIndex(displayIndex);
            Refresh();
        }

        private void ChangePage(int delta)
        {
            _page += delta;
            Refresh();
        }

        private Sprite _boxSprite;
        private Image.Type _boxImageType;
    }
}

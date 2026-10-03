using System;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.UI;

namespace Recharge.ModApi
{
    /// <summary>
    /// Pages 2+ reuse the real StartGame/DeleteSave/Settings row slots for
    /// mod-contributed rows; page 1 is the untouched vanilla rows. A "Page 1/2 >"
    /// button under the last row switches pages (shown only when there's more than one).
    /// </summary>
    internal static class MenuPager
    {
        private const int MaxRowsPerPage = 3;

        private class Runtime : MonoBehaviour
        {
            public RectTransform StartGame;
            public RectTransform DeleteSave;
            public RectTransform Settings;
            public RectTransform Quit;
            public RectTransform Background;
            public GameObject[] Slots;
            public float TopY;
            public float RowSpacing;
            public float PanelTopY;
            public float BottomMargin;
            public float QuitY;
            public GameObject PageButton;
            public int CurrentPage;

            // Escape returns to the vanilla page from a mods page.
            private void Update()
            {
                if (CurrentPage <= 0) return;
                var kb = Keyboard.current;
                if (kb != null && kb.escapeKey.wasPressedThisFrame) ShowPage(this, 0);
            }
        }

        public static GameObject EnsureBuilt(pauseMenuScript menu)
        {
            var mainBit = MenuReflection.MainBit(menu);
            var existing = mainBit.transform.Find("ModsPager");
            if (existing != null)
            {
                var existingRt = existing.GetComponent<Runtime>();
                if (existingRt != null) ShowPage(existingRt, existingRt.CurrentPage);
                return existing.gameObject;
            }
            return Build(mainBit);
        }

        private static RectTransform FindFirst(Transform parent, params string[] names)
        {
            foreach (var name in names)
            {
                var found = parent.Find(name) as RectTransform;
                if (found != null) return found;
            }
            return null;
        }

        private static GameObject Build(GameObject mainBitGo)
        {
            var startGame = FindFirst(mainBitGo.transform, "StartGame", "Resume");
            var deleteSave = FindFirst(mainBitGo.transform, "DeleteSave", "Checkpoint Toggle", "CheckpointToggle");
            var settings = FindFirst(mainBitGo.transform, "Settings");
            var quit = FindFirst(mainBitGo.transform, "QuitToDesktop", "Quit to menu", "QuitToMenu");
            if (startGame == null || settings == null || quit == null) return null;

            float rowSpacing = settings.anchoredPosition.y - quit.anchoredPosition.y;
            if (rowSpacing <= 0f) rowSpacing = 60f;
            float topY = startGame.anchoredPosition.y;
            float originalQuitY = quit.anchoredPosition.y;

            var background = mainBitGo.GetComponent<RectTransform>();
            float panelTopY = 0f, bottomMargin = 0f;
            if (background != null)
            {
                // A ContentSizeFitter would force the height back every frame and
                // clip the extra row, so the vertical fit is handed to us here.
                var fitter = background.GetComponent<ContentSizeFitter>();
                if (fitter != null) fitter.verticalFit = ContentSizeFitter.FitMode.Unconstrained;
                panelTopY = TopEdge(background);
                var panelBottomEdge = BottomEdge(background);
                bottomMargin = originalQuitY - panelBottomEdge + 20f;
            }

            HideVanillaDividersInPagerRegion(mainBitGo.transform, topY, originalQuitY, out var dividerTemplate);

            var pagerGo = new GameObject("ModsPager", typeof(RectTransform));
            pagerGo.transform.SetParent(quit.parent, false);

            var rt = pagerGo.AddComponent<Runtime>();
            rt.StartGame = startGame;
            rt.DeleteSave = deleteSave;
            rt.Settings = settings;
            rt.Quit = quit;
            rt.Background = background;
            rt.TopY = topY;
            rt.RowSpacing = rowSpacing;
            rt.PanelTopY = panelTopY;
            rt.BottomMargin = bottomMargin;
            rt.CurrentPage = 0;

            float quitY = topY - (MaxRowsPerPage + 1) * rowSpacing;
            quit.anchoredPosition = new Vector2(quit.anchoredPosition.x, quitY);
            rt.QuitY = quitY;
            ResizeBackgroundToFit(background, panelTopY, quitY, bottomMargin);

            CreateDividers(dividerTemplate, topY, rowSpacing);
            rt.Slots = CreateSlots(quit, settings);
            rt.PageButton = CreatePageButton(rt, pagerGo, quit, settings);

            ShowPage(rt, 0);
            return pagerGo;
        }

        private static void HideVanillaDividersInPagerRegion(Transform mainBit, float topY, float originalQuitY, out Transform dividerTemplate)
        {
            float regionTop = topY - 0.01f;
            float regionBottom = originalQuitY + 0.01f;
            dividerTemplate = null;
            foreach (Transform child in mainBit)
            {
                if (!child.name.StartsWith("Line")) continue;
                var lineRt = child as RectTransform;
                if (lineRt == null) continue;
                if (lineRt.anchoredPosition.y <= regionTop && lineRt.anchoredPosition.y >= regionBottom)
                    child.gameObject.SetActive(false);
                else if (dividerTemplate == null && child.gameObject.activeSelf)
                    dividerTemplate = child;
            }
        }

        private static float TopEdge(RectTransform rt) => rt.anchoredPosition.y + (1f - rt.pivot.y) * rt.sizeDelta.y;
        private static float BottomEdge(RectTransform rt) => rt.anchoredPosition.y - rt.pivot.y * rt.sizeDelta.y;

        // Anchors and pivots vary between menus, so set the height and then place
        // the rect from its own pivot instead of assuming a centered one.
        private static void ResizeBackgroundToFit(RectTransform background, float panelTopY, float quitY, float bottomMargin)
        {
            if (background == null) return;
            float bottomEdge = quitY - bottomMargin;
            background.sizeDelta = new Vector2(background.sizeDelta.x, panelTopY - bottomEdge);
            background.anchoredPosition = new Vector2(background.anchoredPosition.x, bottomEdge + background.pivot.y * background.sizeDelta.y);
        }

        private static void CreateDividers(Transform dividerTemplate, float topY, float rowSpacing)
        {
            if (dividerTemplate == null) return;
            for (int i = 0; i < MaxRowsPerPage + 1; i++)
            {
                var divider = UnityEngine.Object.Instantiate(dividerTemplate.gameObject, dividerTemplate.parent);
                divider.name = "ModsPagerDivider" + i;
                var dividerRt = (RectTransform)divider.transform;
                dividerRt.anchoredPosition = new Vector2(dividerRt.anchoredPosition.x, topY - (i + 0.5f) * rowSpacing);
            }
        }

        private static GameObject[] CreateSlots(RectTransform quit, RectTransform settings)
        {
            var slots = new GameObject[MaxRowsPerPage];
            for (int i = 0; i < MaxRowsPerPage; i++)
            {
                var slotGo = UnityEngine.Object.Instantiate(quit.gameObject, quit.parent);
                slotGo.name = "ModsPagerSlot" + i;
                slotGo.SetActive(false);
                MenuUiUtil.CopyButtonTextColor(settings.gameObject, slotGo);
                slots[i] = slotGo;
            }
            return slots;
        }

        // A row under Quit (a child of the pager, so hiding the pager hides it) that steps to the next page.
        private static GameObject CreatePageButton(Runtime rt, GameObject pagerGo, RectTransform quit, RectTransform settings)
        {
            var pagerRt = (RectTransform)pagerGo.transform;
            pagerRt.anchorMin = Vector2.zero;
            pagerRt.anchorMax = Vector2.one;
            pagerRt.offsetMin = Vector2.zero;
            pagerRt.offsetMax = Vector2.zero;
            var go = UnityEngine.Object.Instantiate(quit.gameObject, pagerGo.transform);
            go.name = "ModsPagerPageButton";
            var goRt = (RectTransform)go.transform;
            goRt.anchoredPosition = new Vector2(quit.anchoredPosition.x, rt.QuitY + rt.RowSpacing);
            MenuUiUtil.CopyButtonTextColor(settings.gameObject, go);
            var btn = go.GetComponent<Button>();
            btn.onClick = new Button.ButtonClickedEvent();
            btn.onClick.AddListener(() => ShowPage(rt, rt.CurrentPage + 1));
            go.SetActive(false);
            return go;
        }

        private static void ShowPage(Runtime rt, int page)
        {
            var rows = MenuRowRegistry.All;
            int modPageCount = rows.Count == 0 ? 0 : (int)Math.Ceiling(rows.Count / (double)MaxRowsPerPage);
            int totalPages = 1 + modPageCount;
            if (page < 0) page = totalPages - 1;
            if (page >= totalPages) page = 0;
            rt.CurrentPage = page;

            // The page button, and room for it in the panel, only when there's a page to go to.
            if (rt.PageButton != null)
            {
                bool paged = totalPages > 1;
                rt.PageButton.SetActive(paged);
                if (paged) MenuUiUtil.SetButtonLabel(rt.PageButton, "Page " + (page + 1) + "/" + totalPages + "  >");
                float bottomY = paged ? rt.QuitY : rt.QuitY + rt.RowSpacing;
                rt.Quit.anchoredPosition = new Vector2(rt.Quit.anchoredPosition.x, bottomY);
                ResizeBackgroundToFit(rt.Background, rt.PanelTopY, bottomY, rt.BottomMargin);
            }

            if (page == 0) ShowVanillaPage(rt);
            else ShowModPage(rt, rows, page);
        }

        private static void ShowVanillaPage(Runtime rt)
        {
            rt.StartGame.gameObject.SetActive(true);
            rt.StartGame.anchoredPosition = new Vector2(rt.StartGame.anchoredPosition.x, rt.TopY);
            int slotIndex = 1;
            if (rt.DeleteSave != null)
            {
                rt.DeleteSave.gameObject.SetActive(true);
                rt.DeleteSave.anchoredPosition = new Vector2(rt.DeleteSave.anchoredPosition.x, rt.TopY - slotIndex * rt.RowSpacing);
                slotIndex++;
            }
            rt.Settings.gameObject.SetActive(true);
            rt.Settings.anchoredPosition = new Vector2(rt.Settings.anchoredPosition.x, rt.TopY - slotIndex * rt.RowSpacing);
            foreach (var slot in rt.Slots) slot.SetActive(false);
        }

        private static void ShowModPage(Runtime rt, System.Collections.Generic.IReadOnlyList<MenuRowRegistry.Entry> rows, int page)
        {
            rt.StartGame.gameObject.SetActive(false);
            if (rt.DeleteSave != null) rt.DeleteSave.gameObject.SetActive(false);
            rt.Settings.gameObject.SetActive(false);

            int startIdx = (page - 1) * MaxRowsPerPage;
            int count = Math.Max(0, Math.Min(MaxRowsPerPage, rows.Count - startIdx));
            var mainBit = rt.StartGame.transform.parent.gameObject;
            for (int i = 0; i < MaxRowsPerPage; i++)
            {
                var slot = rt.Slots[i];
                if (i >= count) { slot.SetActive(false); continue; }

                var spec = rows[startIdx + i];
                slot.SetActive(true);
                var slotRt = (RectTransform)slot.transform;
                slotRt.anchoredPosition = new Vector2(slotRt.anchoredPosition.x, rt.TopY - i * rt.RowSpacing);
                MenuUiUtil.SetButtonLabel(slot, spec.Label);
                var btn = slot.GetComponent<Button>();
                btn.onClick = new Button.ButtonClickedEvent();
                btn.onClick.AddListener(() =>
                {
                    mainBit.SetActive(false);
                    spec.OnClick();
                });
            }
        }
    }
}

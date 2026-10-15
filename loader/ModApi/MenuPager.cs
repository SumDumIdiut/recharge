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
            public float BackgroundScaleY = 1f;
            public bool ChildBackground;
            public float BottomMargin;
            public float QuitY;
            public GameObject PageButton;
            public int CurrentPage;
            public float QuitTargetY;
            public bool LayoutLogged;

            // Re-apply the layout whenever the pager is shown again (e.g. a mod
            // panel that borrowed the Quit row closed), so Quit always lands
            // below the page row.
            private void OnEnable()
            {
                if (Quit != null && Slots != null) ShowPage(this, CurrentPage);
            }

            // The page button is a sibling of Quit (same parent and anchors), so it
            // doesn't hide with the pager on its own.
            private void OnDisable()
            {
                if (PageButton != null) PageButton.SetActive(false);
            }

            // Re-assert the row order after any layout pass or vanilla script moved things.
            private void LateUpdate()
            {
                if (Quit == null) return;
                SetY(Quit, QuitTargetY);
                if (PageButton != null && PageButton.activeSelf) SetY((RectTransform)PageButton.transform, QuitTargetY + RowSpacing);
            }

            private static void SetY(RectTransform r, float y)
            {
                if (Mathf.Abs(r.anchoredPosition.y - y) > 0.01f) r.anchoredPosition = new Vector2(r.anchoredPosition.x, y);
            }

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

        private static string LabelOf(Transform t)
        {
            var tmp = t.GetComponentInChildren<TMPro.TMP_Text>(true);
            return tmp != null ? tmp.text : null;
        }

        // The visible quit button: an active Button whose label (or name) says quit,
        // lowest on screen if several match; falls back to the known names.
        private static RectTransform FindQuit(Transform mainBit, RectTransform startGame, RectTransform settings)
        {
            RectTransform best = null;
            foreach (var b in mainBit.GetComponentsInChildren<Button>(true))
            {
                if (b.transform == startGame || b.transform == settings) continue;
                if (b.name.StartsWith("ModsPager")) continue;
                var label = LabelOf(b.transform) ?? "";
                bool quitLike = label.IndexOf("quit", StringComparison.OrdinalIgnoreCase) >= 0
                    || b.name.IndexOf("quit", StringComparison.OrdinalIgnoreCase) >= 0;
                if (!quitLike || !b.gameObject.activeInHierarchy) continue;
                var r = b.transform as RectTransform;
                if (r == null) continue;
                if (best == null || r.anchoredPosition.y < best.anchoredPosition.y) best = r;
            }
            return best ?? FindFirst(mainBit, "QuitToDesktop", "Quit to menu", "QuitToMenu");
        }

        private static void LogLayout(Transform mainBit, string stage, Runtime rt)
        {
            try
            {
                var sb = new System.Text.StringBuilder();
                sb.Append("[Recharge] MenuPager layout (").Append(stage).Append("): panel=").Append(mainBit.name).AppendLine();
                foreach (var c in mainBit.GetComponents<Component>())
                    if (c is LayoutGroup || c is ContentSizeFitter || c is Canvas || c is LayoutElement)
                        sb.Append("  panel component: ").Append(c.GetType().Name).AppendLine();
                foreach (Transform child in mainBit)
                {
                    var r = child as RectTransform;
                    sb.Append("  ").Append(child.name).Append(" active=").Append(child.gameObject.activeSelf);
                    if (r != null)
                        sb.Append(" y=").Append(r.anchoredPosition.y).Append(" aMinY=").Append(r.anchorMin.y).Append(" aMaxY=").Append(r.anchorMax.y)
                          .Append(" pivY=").Append(r.pivot.y).Append(" h=").Append(r.rect.height);
                    var label = LabelOf(child);
                    if (label != null) sb.Append(" label='").Append(label).Append("'");
                    sb.AppendLine();
                }
                if (rt != null)
                {
                    sb.Append("  picked: Start=").Append(rt.StartGame?.name).Append(" Delete=").Append(rt.DeleteSave?.name)
                      .Append(" Settings=").Append(rt.Settings?.name).Append(" Quit=").Append(rt.Quit?.name)
                      .Append(" quitParent=").Append(rt.Quit?.parent?.name).AppendLine();
                    sb.Append("  topY=").Append(rt.TopY).Append(" rowSpacing=").Append(rt.RowSpacing).Append(" QuitY=").Append(rt.QuitY)
                      .Append(" quitTarget=").Append(rt.QuitTargetY).AppendLine();
                    if (rt.PageButton != null)
                    {
                        var p = (RectTransform)rt.PageButton.transform;
                        sb.Append("  pageButton: y=").Append(p.anchoredPosition.y).Append(" aMinY=").Append(p.anchorMin.y).Append(" aMaxY=").Append(p.anchorMax.y)
                          .Append(" pivY=").Append(p.pivot.y).Append(" parent=").Append(p.parent?.name).AppendLine();
                    }
                }
                Debug.Log(sb.ToString());
            }
            catch (Exception e) { Debug.Log("[Recharge] MenuPager layout log failed: " + e.Message); }
        }

        private static GameObject Build(GameObject mainBitGo)
        {
            var startGame = FindFirst(mainBitGo.transform, "StartGame", "Resume");
            var deleteSave = FindFirst(mainBitGo.transform, "DeleteSave", "Checkpoint Toggle", "CheckpointToggle");
            var settings = FindFirst(mainBitGo.transform, "Settings");
            var quit = FindQuit(mainBitGo.transform, startGame, settings);
            if (startGame == null || settings == null || quit == null) { LogLayout(mainBitGo.transform, "build-failed", null); return null; }
            LogLayout(mainBitGo.transform, "before", null);

            float rowSpacing = settings.anchoredPosition.y - quit.anchoredPosition.y;
            if (rowSpacing <= 0f) rowSpacing = 60f;
            float topY = startGame.anchoredPosition.y;
            float originalQuitY = quit.anchoredPosition.y;

            var background = mainBitGo.GetComponent<RectTransform>();
            // The title-screen panel is itself the background image. The in-game
            // pause panel is a bare container whose background is a child Image,
            // so resizing the container did nothing and Main Menu hung off the end.
            bool childBackground = false;
            float backgroundScaleY = 1f;
            if (mainBitGo.GetComponent<Graphic>() == null)
            {
                var childBg = FindBackgroundChild(mainBitGo.transform);
                if (childBg != null)
                {
                    background = childBg;
                    childBackground = true;
                    backgroundScaleY = Mathf.Max(0.0001f, Mathf.Abs(childBg.localScale.y));
                }
            }
            float panelTopY = 0f, bottomMargin = 0f;
            if (background != null)
            {
                // A ContentSizeFitter would force the height back every frame and
                // clip the extra row, so the vertical fit is handed to us here.
                var fitter = background.GetComponent<ContentSizeFitter>();
                if (fitter != null) fitter.verticalFit = ContentSizeFitter.FitMode.Unconstrained;
                panelTopY = TopEdge(background, backgroundScaleY);
                var panelBottomEdge = BottomEdge(background, backgroundScaleY);
                // Title panel keeps its 20 extra; the pause panel's own bottom edge already
                // matches vanilla (about 13 below the Quit row), so adding 20 left a wide empty band.
                bottomMargin = originalQuitY - panelBottomEdge + (childBackground ? 0f : 20f);
                if (childBackground)
                    Debug.Log("[Recharge] MenuPager pause bottomMargin=" + bottomMargin + " (quitY=" + originalQuitY + " panelBottom=" + panelBottomEdge + " panelTop=" + panelTopY + " scaleY=" + backgroundScaleY + ")");
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
            rt.BackgroundScaleY = backgroundScaleY;
            rt.ChildBackground = childBackground;
            rt.BottomMargin = bottomMargin;
            rt.CurrentPage = 0;

            float quitY = topY - (MaxRowsPerPage + 1) * rowSpacing;
            quit.anchoredPosition = new Vector2(quit.anchoredPosition.x, quitY);
            rt.QuitY = quitY;
            rt.QuitTargetY = quitY;
            ResizeBackgroundToFit(background, panelTopY, quitY, bottomMargin, backgroundScaleY, childBackground);

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

        // Edges in the parent's space; the local scale matters for the child
        // background of the pause panel (1 for the title-screen panel).
        private static float TopEdge(RectTransform rt, float scaleY) => rt.anchoredPosition.y + (1f - rt.pivot.y) * rt.sizeDelta.y * scaleY;
        private static float BottomEdge(RectTransform rt, float scaleY) => rt.anchoredPosition.y - rt.pivot.y * rt.sizeDelta.y * scaleY;

        // The biggest plain Image directly under the pause panel (not a button row or divider).
        private static RectTransform FindBackgroundChild(Transform panel)
        {
            RectTransform best = null;
            float bestArea = 0f;
            foreach (Transform child in panel)
            {
                var r = child as RectTransform;
                if (r == null || child.GetComponent<Image>() == null || child.GetComponent<Button>() != null) continue;
                if (child.name.StartsWith("Line") || child.name.StartsWith("ModsPager")) continue;
                float area = r.rect.width * r.rect.height;
                if (area > bestArea) { bestArea = area; best = r; }
            }
            return best;
        }

        // Anchors and pivots vary between menus, so set the height and then place
        // the rect from its own pivot instead of assuming a centered one.
        private static void ResizeBackgroundToFit(RectTransform background, float panelTopY, float quitY, float bottomMargin, float scaleY, bool child)
        {
            if (background == null) return;
            float bottomEdge = quitY - bottomMargin;
            if (child)
            {
                float height = (panelTopY - bottomEdge) / scaleY;
                background.sizeDelta = new Vector2(background.sizeDelta.x, background.sizeDelta.y + (height - background.rect.height));
                background.anchoredPosition = new Vector2(background.anchoredPosition.x, bottomEdge + background.pivot.y * height * scaleY);
                return;
            }
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

        // A row above Quit (sibling of Quit; Runtime.OnDisable hides it with the pager) that steps to the next page.
        private static GameObject CreatePageButton(Runtime rt, GameObject pagerGo, RectTransform quit, RectTransform settings)
        {
            var pagerRt = (RectTransform)pagerGo.transform;
            pagerRt.anchorMin = Vector2.zero;
            pagerRt.anchorMax = Vector2.one;
            pagerRt.offsetMin = Vector2.zero;
            pagerRt.offsetMax = Vector2.zero;
            var go = UnityEngine.Object.Instantiate(quit.gameObject, quit.parent);
            go.name = "ModsPagerPageButton";
            var goRt = (RectTransform)go.transform;
            goRt.anchorMin = quit.anchorMin;
            goRt.anchorMax = quit.anchorMax;
            goRt.pivot = quit.pivot;
            goRt.sizeDelta = quit.sizeDelta;
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
                rt.QuitTargetY = bottomY;
                if (paged) ((RectTransform)rt.PageButton.transform).anchoredPosition = new Vector2(rt.Quit.anchoredPosition.x, bottomY + rt.RowSpacing);
                ResizeBackgroundToFit(rt.Background, rt.PanelTopY, bottomY, rt.BottomMargin, rt.BackgroundScaleY, rt.ChildBackground);
            }

            if (page == 0) ShowVanillaPage(rt);
            else ShowModPage(rt, rows, page);
            if (!rt.LayoutLogged) { rt.LayoutLogged = true; LogLayout(rt.Quit.parent, "after", rt); }
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

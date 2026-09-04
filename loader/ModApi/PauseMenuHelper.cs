using System;
using System.Collections.Generic;
using System.Linq;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Recharge.ModApi
{
    /// <summary>
    /// Adds an entry to the real pause menu. Page 1 is the real vanilla menu
    /// (Start Demo / Delete Save Data / Settings), untouched; every mod's
    /// entry lives on page 2+, reusing the exact same row slots, up to 4 per
    /// page, flipped between with a compact "&lt; i/N &gt;" control. The
    /// panel, the pager row and Quit are all sized/positioned exactly once
    /// (for the worst case - a full page of mod rows) and never move again as
    /// pages flip - a lighter page (like the 3-row vanilla one) just leaves
    /// its unused slots blank instead of resizing anything.
    /// </summary>
    public static class PauseMenuHelper
    {
        // 3, not 4 - matches the real vanilla page's own row count
        // (StartGame/DeleteSave/Settings), which is already about as tall as
        // the panel can go without the fixed-size panel running past the
        // bottom of the screen.
        private const int MaxRowsPerPage = 3;

        private class ModRowSpec
        {
            public string RowName;
            public string Label;
            public Action OnClick;
        }

        // Session-wide list of what mod rows exist (page 2+ content). OnClick
        // is REPLACED (not just registered once) on every call, since it
        // closes over whatever panel/menu instance is live right now - those
        // get destroyed on every scene reload, so a stale closure from an
        // earlier instance must never be left wired after a mod re-registers.
        private static readonly List<ModRowSpec> _rows = new List<ModRowSpec>();

        /// <summary>
        /// Registers a mod entry that runs <paramref name="onClick"/> when
        /// selected - no sub-panel of its own. Use this when you're managing
        /// your own panel (open it from onClick - its own Back button should
        /// return to <c>menu.mainBitPublic</c>). Use <see cref="AddPanelRow"/>
        /// instead if you just need a blank sub-screen to fill in.
        /// </summary>
        /// <param name="rowName">
        /// A stable, unique id for this row (not shown to the player) - also
        /// this call's idempotency key, safe to call unconditionally every
        /// session (including every scene load, since a fresh pauseMenuScript
        /// instance needs its own copy of the pager rebuilt).
        /// </param>
        /// <returns>The shared pager row's GameObject, or null if the real menu's expected shape wasn't found (e.g. the game updated) - added defensively, log a warning and continue rather than throw.</returns>
        public static GameObject AddRow(pauseMenuScript menu, string rowName, string label, Action onClick)
        {
            if (menu == null || menu.mainBitPublic == null || menu.settingsBitPublic == null) return null;
            Upsert(rowName, label, onClick);
            return EnsurePager(menu);
        }

        /// <summary>
        /// Registers a mod entry that opens a blank sub-panel (cloned from
        /// the real Settings panel's own shape, so it matches the game's own
        /// visual style) when selected - the sub-panel's Close button is
        /// already wired back to <c>menu.mainBitPublic</c> directly. Fill the
        /// returned GameObject with your own UI content after this call
        /// returns.
        /// </summary>
        /// <param name="rowName">Same idempotency key as <see cref="AddRow"/> - also becomes the sub-panel GameObject's name suffix ("&lt;rowName&gt;Bit").</param>
        /// <returns>The (empty) sub-panel GameObject, inactive until selected, or null if the real menu's expected shape wasn't found.</returns>
        public static GameObject AddPanelRow(pauseMenuScript menu, string rowName, string label)
        {
            if (menu == null || menu.mainBitPublic == null || menu.settingsBitPublic == null) return null;

            var panel = BuildBlankPanel(menu, rowName, label, backTarget: menu.mainBitPublic);
            Upsert(rowName, label, () => panel.SetActive(true));
            EnsurePager(menu);
            return panel;
        }

        private static void Upsert(string rowName, string label, Action onClick)
        {
            var existing = _rows.FirstOrDefault(r => r.RowName == rowName);
            if (existing != null) { existing.OnClick = onClick; existing.Label = label; return; }
            _rows.Add(new ModRowSpec { RowName = rowName, Label = label, OnClick = onClick });
        }

        private class PagerRuntime : MonoBehaviour
        {
            public RectTransform StartGame;
            public RectTransform DeleteSave;
            public RectTransform Settings;
            public RectTransform Quit;
            public RectTransform Background;
            public RectTransform PagerRow;
            public GameObject[] Slots;
            public float TopY;
            public float RowSpacing;
            public float PanelTopY;
            public float BottomMargin;
            public int CurrentPage;
        }

        private static GameObject EnsurePager(pauseMenuScript menu)
        {
            var existing = menu.mainBitPublic.transform.Find("ModsPager");
            if (existing != null)
            {
                var rt = existing.GetComponent<PagerRuntime>();
                if (rt != null) ShowPage(rt, rt.CurrentPage); // re-render in case a row was just added/changed
                return existing.gameObject;
            }
            return BuildPager(menu);
        }

        private static GameObject BuildPager(pauseMenuScript menu)
        {
            var startGame = menu.mainBitPublic.transform.Find("StartGame") as RectTransform;
            var deleteSave = menu.mainBitPublic.transform.Find("DeleteSave") as RectTransform;
            var settings = menu.mainBitPublic.transform.Find("Settings") as RectTransform;
            var quit = menu.mainBitPublic.transform.Find("QuitToDesktop") as RectTransform;
            if (startGame == null || settings == null || quit == null) return null;

            float rowSpacing = settings.anchoredPosition.y - quit.anchoredPosition.y;
            if (rowSpacing <= 0f) rowSpacing = 60f;
            float topY = startGame.anchoredPosition.y;
            float originalQuitY = quit.anchoredPosition.y;

            var background = menu.mainBitPublic.GetComponent<RectTransform>();
            float panelTopY = 0f, bottomMargin = 0f;
            if (background != null)
            {
                panelTopY = background.anchoredPosition.y + background.sizeDelta.y / 2f;
                var panelBottomEdge = background.anchoredPosition.y - background.sizeDelta.y / 2f;
                // +20 safety buffer - the real vanilla margin below Quit is
                // tight even for the original 3-row layout, and reserving
                // space for a full MaxRowsPerPage below leaves none to spare.
                bottomMargin = originalQuitY - panelBottomEdge + 20f;
            }

            // The real dividers between StartGame/DeleteSave/Settings/Quit
            // don't track per-page row counts, so they're dropped entirely
            // (found by position, not name, since the real names - "Line",
            // "Line (1)", ... - aren't a reliable contract) and replaced
            // below with fresh ones at the now-fixed slot gaps instead.
            float regionTop = topY - 0.01f;
            float regionBottom = originalQuitY + 0.01f;
            Transform dividerTemplate = null;
            foreach (Transform child in menu.mainBitPublic.transform)
            {
                if (!child.name.StartsWith("Line")) continue;
                var lineRt = child as RectTransform;
                if (lineRt == null) continue;
                if (lineRt.anchoredPosition.y <= regionTop && lineRt.anchoredPosition.y >= regionBottom)
                    child.gameObject.SetActive(false);
                else if (dividerTemplate == null && child.gameObject.activeSelf)
                    dividerTemplate = child;
            }

            var pagerGo = new GameObject("ModsPager", typeof(RectTransform));
            pagerGo.transform.SetParent(quit.parent, false);
            var pagerRt = (RectTransform)pagerGo.transform;

            var rt = pagerGo.AddComponent<PagerRuntime>();
            rt.StartGame = startGame;
            rt.DeleteSave = deleteSave;
            rt.Settings = settings;
            rt.Quit = quit;
            rt.Background = background;
            rt.PagerRow = pagerRt;
            rt.TopY = topY;
            rt.RowSpacing = rowSpacing;
            rt.PanelTopY = panelTopY;
            rt.BottomMargin = bottomMargin;
            rt.CurrentPage = 0;

            // Fixed once, for good - sized for the worst case (a full
            // MaxRowsPerPage of content) so the panel/pager/Quit never move
            // again as pages flip; a lighter page (e.g. the 3-row vanilla
            // one) just leaves its unused slots blank instead of shrinking
            // anything, per how this is meant to look.
            float pagerY = topY - MaxRowsPerPage * rowSpacing;
            float quitY = pagerY - rowSpacing;
            quit.anchoredPosition = new Vector2(quit.anchoredPosition.x, quitY);
            pagerRt.anchoredPosition = new Vector2(pagerRt.anchoredPosition.x, pagerY);
            if (background != null)
            {
                float bottomEdge = quitY - bottomMargin;
                background.sizeDelta = new Vector2(background.sizeDelta.x, panelTopY - bottomEdge);
                background.anchoredPosition = new Vector2(background.anchoredPosition.x, (panelTopY + bottomEdge) / 2f);
            }

            // One divider per gap between the fixed slots (StartGame..slot3,
            // then the pager, then Quit) - safe to place once, up front, now
            // that none of those positions ever move again.
            if (dividerTemplate != null)
            {
                for (int i = 0; i < MaxRowsPerPage + 1; i++)
                {
                    var divider = UnityEngine.Object.Instantiate(dividerTemplate.gameObject, dividerTemplate.parent);
                    divider.name = "ModsPagerDivider" + i;
                    var dividerRt = (RectTransform)divider.transform;
                    dividerRt.anchoredPosition = new Vector2(dividerRt.anchoredPosition.x, topY - (i + 0.5f) * rowSpacing);
                }
            }

            // Reusable content-row slots for mod pages, cloned from Quit
            // (guaranteed to stay active and structurally identical to the
            // real rows, unlike Settings which page 0 can hide).
            rt.Slots = new GameObject[MaxRowsPerPage];
            for (int i = 0; i < MaxRowsPerPage; i++)
            {
                var slotGo = UnityEngine.Object.Instantiate(quit.gameObject, quit.parent);
                slotGo.name = "ModsPagerSlot" + i;
                slotGo.SetActive(false);
                rt.Slots[i] = slotGo;
            }

            var prevGo = UnityEngine.Object.Instantiate(quit.gameObject, pagerRt);
            prevGo.name = "Prev";
            var prevRt = (RectTransform)prevGo.transform;
            prevRt.anchoredPosition = new Vector2(-110f, 0f);
            prevRt.sizeDelta = new Vector2(60f, prevRt.sizeDelta.y);
            SetButtonLabel(prevGo, "<");
            ScaleButtonFontSize(prevGo, 1.6f);
            var prevBtn = prevGo.GetComponent<Button>();
            prevBtn.onClick = new Button.ButtonClickedEvent();
            prevBtn.onClick.AddListener(() => ShowPage(rt, rt.CurrentPage - 1));

            var nextGo = UnityEngine.Object.Instantiate(quit.gameObject, pagerRt);
            nextGo.name = "Next";
            var nextRt = (RectTransform)nextGo.transform;
            nextRt.anchoredPosition = new Vector2(110f, 0f);
            nextRt.sizeDelta = new Vector2(60f, nextRt.sizeDelta.y);
            SetButtonLabel(nextGo, ">");
            ScaleButtonFontSize(nextGo, 1.6f);
            var nextBtn = nextGo.GetComponent<Button>();
            nextBtn.onClick = new Button.ButtonClickedEvent();
            nextBtn.onClick.AddListener(() => ShowPage(rt, rt.CurrentPage + 1));

            var counterGo = UnityEngine.Object.Instantiate(quit.gameObject, pagerRt);
            counterGo.name = "Counter";
            var counterRt = (RectTransform)counterGo.transform;
            counterRt.anchoredPosition = Vector2.zero;
            counterRt.sizeDelta = new Vector2(170f, counterRt.sizeDelta.y);
            // Left with its Button intact but disabled, rather than
            // destroyed - the real rows' orange comes from the Button's own
            // Normal color state, not a fixed text color, so destroying it
            // and trying to reproduce that color by hand never reliably
            // matched. Disabling (not just clearing onClick) freezes it at
            // whatever color it already has instead of leaving it selectable
            // - otherwise keyboard/gamepad nav or a mouse hover can flip it
            // to the Highlighted color (a stray green) since it's still a
            // real Selectable.
            var counterBtn = counterGo.GetComponent<Button>();
            if (counterBtn != null) counterBtn.enabled = false;

            ShowPage(rt, 0);
            return pagerGo;
        }

        // Only ever toggles/relabels content rows within the MaxRowsPerPage
        // fixed slots - the panel, pager row and Quit were positioned once in
        // BuildPager and are never touched again, so a lighter page just
        // leaves its unused slots blank instead of resizing anything.
        private static void ShowPage(PagerRuntime rt, int page)
        {
            int modPageCount = _rows.Count == 0 ? 0 : (int)Math.Ceiling(_rows.Count / (double)MaxRowsPerPage);
            int totalPages = 1 + modPageCount;
            if (page < 0) page = totalPages - 1;
            if (page >= totalPages) page = 0;
            rt.CurrentPage = page;

            if (page == 0)
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
            else
            {
                rt.StartGame.gameObject.SetActive(false);
                if (rt.DeleteSave != null) rt.DeleteSave.gameObject.SetActive(false);
                rt.Settings.gameObject.SetActive(false);

                int startIdx = (page - 1) * MaxRowsPerPage;
                int count = Math.Max(0, Math.Min(MaxRowsPerPage, _rows.Count - startIdx));
                var mainBit = rt.StartGame.transform.parent.gameObject;
                for (int i = 0; i < MaxRowsPerPage; i++)
                {
                    var slot = rt.Slots[i];
                    if (i < count)
                    {
                        var spec = _rows[startIdx + i];
                        slot.SetActive(true);
                        var slotRt = (RectTransform)slot.transform;
                        slotRt.anchoredPosition = new Vector2(slotRt.anchoredPosition.x, rt.TopY - i * rt.RowSpacing);
                        SetButtonLabel(slot, spec.Label);
                        var btn = slot.GetComponent<Button>();
                        btn.onClick = new Button.ButtonClickedEvent();
                        btn.onClick.AddListener(() =>
                        {
                            mainBit.SetActive(false); // the page this row lives on doesn't hide itself before invoking a mod's onClick otherwise
                            spec.OnClick();
                        });
                    }
                    else
                    {
                        slot.SetActive(false);
                    }
                }
            }

            var counter = rt.PagerRow.Find("Counter");
            if (counter != null) SetButtonLabel(counter.gameObject, (page + 1) + "/" + totalPages);
            bool multi = totalPages > 1;
            var prev = rt.PagerRow.Find("Prev");
            var next = rt.PagerRow.Find("Next");
            if (prev != null) prev.gameObject.SetActive(multi);
            if (next != null) next.gameObject.SetActive(multi);
        }

        private static GameObject BuildBlankPanel(pauseMenuScript menu, string rowName, string label, GameObject backTarget)
        {
            var clone = UnityEngine.Object.Instantiate(menu.settingsBitPublic, menu.settingsBitPublic.transform.parent);
            clone.name = rowName + "Bit";
            clone.SetActive(false);

            var settingsScript = clone.GetComponent<SettingsScript>();
            if (settingsScript != null) UnityEngine.Object.Destroy(settingsScript);

            // The title bar isn't reliably sibling index 0 (confirmed live -
            // assuming "first child" left both the title text and Back
            // button destroyed, since some other child occupied that slot
            // instead) - match by the source panel's own real name instead,
            // same as recharge-multiplayer/MpMenuBuilder.cs's hand-rolled
            // equivalent already does. Falls back to "first child" only if
            // that name is ever missing, rather than failing outright.
            Transform title = null;
            foreach (Transform child in clone.transform)
            {
                if (child.name != "Settings") continue;
                title = child;
                break;
            }
            if (title == null && clone.transform.childCount > 0) title = clone.transform.GetChild(0);

            var toDestroy = new List<GameObject>();
            foreach (Transform child in clone.transform)
            {
                if (child != title) toDestroy.Add(child.gameObject);
            }
            foreach (var go in toDestroy) UnityEngine.Object.Destroy(go);

            if (title != null)
            {
                var titleTmp = title.GetComponent<TMP_Text>();
                if (titleTmp != null) titleTmp.text = label;
                var loc = title.GetComponent<UnityEngine.Localization.Components.LocalizeStringEvent>();
                if (loc != null) UnityEngine.Object.Destroy(loc);

                var closeBtn = title.Find("Close");
                if (closeBtn != null)
                {
                    SetButtonLabel(closeBtn.gameObject, "Back");
                    var btn = closeBtn.GetComponent<Button>();
                    btn.onClick = new Button.ButtonClickedEvent();
                    btn.onClick.AddListener(() =>
                    {
                        clone.SetActive(false);
                        backTarget.SetActive(true);
                    });
                }
            }

            return clone;
        }

        /// <summary>Relabels a cloned button's TMP text, stripping any inherited localization hookup so your own text sticks. Exposed publicly since it's just as useful when hand-styling rows outside <see cref="AddRow"/>/<see cref="AddPanelRow"/>.</summary>
        public static void SetButtonLabel(GameObject buttonGo, string text)
        {
            var label = buttonGo.transform.Find("Text (TMP)");
            if (label == null) return;
            var loc = label.GetComponent<UnityEngine.Localization.Components.LocalizeStringEvent>();
            if (loc != null) UnityEngine.Object.Destroy(loc);
            var tmp = label.GetComponent<TMP_Text>();
            if (tmp != null) tmp.text = text;
        }

        /// <summary>Copies another cloned button's own live TMP text color onto this one - the reliable way to match the real menu's normal orange exactly, since reconstructing it from an RGB guess doesn't survive whatever color-space/material handling TMP applies at render time.</summary>
        public static void CopyButtonTextColor(GameObject sourceButtonGo, GameObject targetButtonGo)
        {
            var sourceLabel = sourceButtonGo.transform.Find("Text (TMP)");
            var sourceTmp = sourceLabel != null ? sourceLabel.GetComponent<TMP_Text>() : null;
            if (sourceTmp == null) return;
            SetButtonTextColor(targetButtonGo, sourceTmp.color);
        }

        /// <summary>Multiplies a cloned button's TMP font size (e.g. to make a lone "&lt;"/"&gt;" glyph read clearly at a small button width). Exposed publicly for the same reason as <see cref="SetButtonLabel"/>.</summary>
        public static void ScaleButtonFontSize(GameObject buttonGo, float multiplier)
        {
            var label = buttonGo.transform.Find("Text (TMP)");
            var tmp = label != null ? label.GetComponent<TMP_Text>() : null;
            if (tmp == null) return;
            tmp.enableAutoSizing = false;
            tmp.fontSize *= multiplier;
        }

        /// <summary>Sets a cloned button's TMP text color directly - needed once its Button component is destroyed (e.g. a label-only element like a page counter), since a plain `.color` write alone doesn't reliably override TMP's own face color / vertex gradient.</summary>
        public static void SetButtonTextColor(GameObject buttonGo, Color color)
        {
            var label = buttonGo.transform.Find("Text (TMP)");
            var tmp = label != null ? label.GetComponent<TMP_Text>() : null;
            if (tmp == null) return;
            tmp.enableVertexGradient = false;
            tmp.color = color;
            tmp.faceColor = color;
        }
    }
}

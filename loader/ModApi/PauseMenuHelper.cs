using System;
using System.Collections.Generic;
using System.Linq;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Recharge.ModApi
{
    /// <summary>
    /// Adds an entry to the real pause menu. Page 1 is the untouched vanilla
    /// menu; every mod's entry lives on page 2+, sharing the same row slots
    /// (up to 3 each), flipped with a "&lt; i/N &gt;" control.
    /// </summary>
    public static class PauseMenuHelper
    {
        private const int MaxRowsPerPage = 3;

        private class ModRowSpec
        {
            public string RowName;
            public string Label;
            public Action OnClick;
        }

        private static readonly List<ModRowSpec> _rows = new List<ModRowSpec>();

        private static readonly System.Reflection.FieldInfo MainBitField =
            typeof(pauseMenuScript).GetField("mainBit", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
        private static readonly System.Reflection.FieldInfo SettingsBitField =
            typeof(pauseMenuScript).GetField("settingsBit", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);

        private static GameObject MainBit(pauseMenuScript menu) => MainBitField?.GetValue(menu) as GameObject;
        private static GameObject SettingsBit(pauseMenuScript menu) => SettingsBitField?.GetValue(menu) as GameObject;

        /// <summary>
        /// Registers a mod entry that runs <paramref name="onClick"/> when
        /// selected, with no sub-panel of its own. Use <see cref="AddPanelRow"/>
        /// instead if you need a blank sub-screen to fill in.
        /// </summary>
        /// <param name="rowName">Stable, unique id for this row - also the idempotency key, safe to call every scene load.</param>
        /// <returns>The shared pager row's GameObject, or null if the real menu's expected shape wasn't found.</returns>
        public static GameObject AddRow(pauseMenuScript menu, string rowName, string label, Action onClick)
        {
            if (menu == null || MainBit(menu) == null || SettingsBit(menu) == null) return null;
            Upsert(rowName, label, onClick);
            return EnsurePager(menu);
        }

        /// <summary>
        /// Registers a mod entry that opens a blank sub-panel (cloned from
        /// the real Settings panel, matching its visual style) when
        /// selected, with its Close button already wired back. Fill the
        /// returned GameObject with your own UI content.
        /// </summary>
        /// <param name="rowName">Same idempotency key as <see cref="AddRow"/>.</param>
        /// <returns>The (empty) sub-panel GameObject, inactive until selected, or null if the real menu's expected shape wasn't found.</returns>
        public static GameObject AddPanelRow(pauseMenuScript menu, string rowName, string label)
        {
            if (menu == null || MainBit(menu) == null || SettingsBit(menu) == null) return null;

            var panel = BuildBlankPanel(menu, rowName, label, backTarget: MainBit(menu));
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
            var existing = MainBit(menu).transform.Find("ModsPager");
            if (existing != null)
            {
                var rt = existing.GetComponent<PagerRuntime>();
                if (rt != null) ShowPage(rt, rt.CurrentPage);
                return existing.gameObject;
            }
            return BuildPager(menu);
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

        private static GameObject BuildPager(pauseMenuScript menu)
        {
            var mainBitGo = MainBit(menu);
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
                panelTopY = background.anchoredPosition.y + background.sizeDelta.y / 2f;
                var panelBottomEdge = background.anchoredPosition.y - background.sizeDelta.y / 2f;
                bottomMargin = originalQuitY - panelBottomEdge + 20f;
            }

            float regionTop = topY - 0.01f;
            float regionBottom = originalQuitY + 0.01f;
            Transform dividerTemplate = null;
            foreach (Transform child in mainBitGo.transform)
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

            rt.Slots = new GameObject[MaxRowsPerPage];
            for (int i = 0; i < MaxRowsPerPage; i++)
            {
                var slotGo = UnityEngine.Object.Instantiate(quit.gameObject, quit.parent);
                slotGo.name = "ModsPagerSlot" + i;
                slotGo.SetActive(false);
                CopyButtonTextColor(settings.gameObject, slotGo);
                rt.Slots[i] = slotGo;
            }

            float rowWidth = quit.sizeDelta.x;
            float arrowWidth = Mathf.Min(50f, rowWidth * 0.16f);
            float arrowX = rowWidth / 2f - arrowWidth / 2f;
            float counterWidth = Mathf.Max(60f, rowWidth - arrowWidth * 2f - 12f);

            var prevGo = UnityEngine.Object.Instantiate(quit.gameObject, pagerRt);
            prevGo.name = "Prev";
            var prevRt = (RectTransform)prevGo.transform;
            prevRt.anchoredPosition = new Vector2(-arrowX, 0f);
            prevRt.sizeDelta = new Vector2(arrowWidth, prevRt.sizeDelta.y);
            SetButtonLabel(prevGo, "<");
            ScaleButtonFontSize(prevGo, 1.6f);
            var prevBtn = prevGo.GetComponent<Button>();
            prevBtn.onClick = new Button.ButtonClickedEvent();
            prevBtn.onClick.AddListener(() => ShowPage(rt, rt.CurrentPage - 1));

            var nextGo = UnityEngine.Object.Instantiate(quit.gameObject, pagerRt);
            nextGo.name = "Next";
            var nextRt = (RectTransform)nextGo.transform;
            nextRt.anchoredPosition = new Vector2(arrowX, 0f);
            nextRt.sizeDelta = new Vector2(arrowWidth, nextRt.sizeDelta.y);
            SetButtonLabel(nextGo, ">");
            ScaleButtonFontSize(nextGo, 1.6f);
            var nextBtn = nextGo.GetComponent<Button>();
            nextBtn.onClick = new Button.ButtonClickedEvent();
            nextBtn.onClick.AddListener(() => ShowPage(rt, rt.CurrentPage + 1));

            var counterGo = UnityEngine.Object.Instantiate(quit.gameObject, pagerRt);
            counterGo.name = "Counter";
            var counterRt = (RectTransform)counterGo.transform;
            counterRt.anchoredPosition = Vector2.zero;
            counterRt.sizeDelta = new Vector2(counterWidth, counterRt.sizeDelta.y);
            var counterBtn = counterGo.GetComponent<Button>();
            if (counterBtn != null) counterBtn.enabled = false;

            ShowPage(rt, 0);
            return pagerGo;
        }

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
                            mainBit.SetActive(false);
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
            var settingsBitGo = SettingsBit(menu);
            var clone = UnityEngine.Object.Instantiate(settingsBitGo, settingsBitGo.transform.parent);
            clone.name = rowName + "Bit";
            clone.SetActive(false);

            var settingsScript = clone.GetComponent<SettingsScript>();
            if (settingsScript != null) UnityEngine.Object.Destroy(settingsScript);

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
                if (loc != null) UnityEngine.Object.DestroyImmediate(loc);

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

        /// <summary>Relabels a cloned button's TMP text, stripping any inherited localization hookup so your own text sticks.</summary>
        public static void SetButtonLabel(GameObject buttonGo, string text)
        {
            var label = buttonGo.transform.Find("Text (TMP)");
            if (label == null) return;
            var loc = label.GetComponent<UnityEngine.Localization.Components.LocalizeStringEvent>();
            if (loc != null) UnityEngine.Object.DestroyImmediate(loc);
            var tmp = label.GetComponent<TMP_Text>();
            if (tmp != null) tmp.text = text;
        }

        /// <summary>Copies another cloned button's own live TMP text color onto this one - more reliable than reconstructing it from an RGB guess.</summary>
        public static void CopyButtonTextColor(GameObject sourceButtonGo, GameObject targetButtonGo)
        {
            var sourceLabel = sourceButtonGo.transform.Find("Text (TMP)");
            var sourceTmp = sourceLabel != null ? sourceLabel.GetComponent<TMP_Text>() : null;
            if (sourceTmp == null) return;
            SetButtonTextColor(targetButtonGo, sourceTmp.color);
        }

        /// <summary>Multiplies a cloned button's TMP font size (e.g. for a lone "&lt;"/"&gt;" glyph).</summary>
        public static void ScaleButtonFontSize(GameObject buttonGo, float multiplier)
        {
            var label = buttonGo.transform.Find("Text (TMP)");
            var tmp = label != null ? label.GetComponent<TMP_Text>() : null;
            if (tmp == null) return;
            tmp.enableAutoSizing = false;
            tmp.fontSize *= multiplier;
        }

        /// <summary>Sets a cloned button's TMP text color directly, including face color - a plain `.color` write alone doesn't reliably override TMP's vertex gradient.</summary>
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

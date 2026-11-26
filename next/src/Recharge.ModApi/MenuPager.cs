using System;
using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.UI;

namespace Recharge.ModApi
{
    /// <summary>
    /// Adds a Mods row between Settings and Quit. Its list opens beside the
    /// game's menu, and the map picker can use the same fitted frame.
    /// </summary>
    internal static class MenuPager
    {
        private sealed class Runtime : MonoBehaviour
        {
            private const float Margin = 10f;
            private const float MainBottomMargin = 24f;
            private const float Padding = 8f;
            private const int RowsPerPage = 6;
            private const float TitleContentLiftFraction = 0.21f;
            private const float DividerInsetFraction = 0.08f;

            private readonly Vector3[] _corners = new Vector3[4];
            private readonly Button[] _rows = new Button[RowsPerPage];
            private readonly RectTransform[] _listDividers = new RectTransform[RowsPerPage];
            private readonly string[] _fitText = new string[RowsPerPage + 1];
            private readonly float[] _fitWidth = new float[RowsPerPage + 1];
            private readonly List<(RectTransform Rect, Vector2 Original, Vector2 Raised)> _titleElements =
                new List<(RectTransform Rect, Vector2 Original, Vector2 Raised)>();
            private Transform _main;
            private RectTransform _frame;
            private RectTransform _canvas;
            private RectTransform _settings;
            private RectTransform _quit;
            private TMP_Text _titleQuitLabel;
            private RectTransform _nativeDivider;
            private RectTransform _divider;
            private TMP_FontAsset _font;
            private RectTransform _panel;
            private Button _toggle;
            private Button _pageButton;
            private ColorBlock _menuColors;
            private Vector2 _frameSize;
            private Vector2 _framePosition;
            private Vector2 _mainPosition;
            private Vector2 _expandedPosition;
            private Vector3 _mainScale;
            private Vector2 _quitPosition;
            private Vector2 _quitWithMods;
            private ContentSizeFitter _fitter;
            private ContentSizeFitter.FitMode _verticalFit;
            private float _mainLift;
            private Rect _fitArea;
            private bool _frameExpanded;
            private bool _modsVisible = true;
            private Button _returnTo;
            private bool _open;
            private int _pageIndex;
            private int _pageCount = 1;
            private int _shownFrame;
            private IReadOnlyList<PauseMenuHelper.SideListRow> _list;
            private string _listOwner;
            private int _listShownFrame;

            /// <summary>The panel is showing an external list (e.g. the map picker) instead of the Mods rows.</summary>
            private bool ListOpen => _list != null;

            // The title menu is a RectTransform. The in-game pause menu groups
            // its buttons and frame under an ordinary Transform.
            private Vector2 MainPosition
            {
                get => _main is RectTransform rect ? rect.anchoredPosition : (Vector2)_main.localPosition;
                set
                {
                    if (_main is RectTransform rect) rect.anchoredPosition = value;
                    else _main.localPosition = new Vector3(value.x, value.y, _main.localPosition.z);
                }
            }

            public void Build(Transform main, RectTransform frame, RectTransform canvas,
                RectTransform settings, RectTransform quit, TMP_FontAsset font)
            {
                _main = main;
                _frame = frame;
                _canvas = canvas;
                _settings = settings;
                _quit = quit;
                if (main.Find("StartGame") != null)
                    _titleQuitLabel = quit.Find("Text (TMP)")?.GetComponent<TMP_Text>();
                _font = font;

                var quitButton = quit.GetComponent<Button>();
                _menuColors = quitButton.colors;
                if (_menuColors.normalColor.r <= _menuColors.normalColor.g)
                    _menuColors.normalColor = new Color(1f, 0.53f, 0.08f, 1f);
                _menuColors.highlightedColor = Color.green;
                _menuColors.selectedColor = Color.green;
                _menuColors.pressedColor = Color.green;
                _menuColors.colorMultiplier = 1f;

                var toggle = UnityEngine.Object.Instantiate(quit.gameObject, quit.parent);
                toggle.name = "ModsPagerToggle";
                toggle.SetActive(false);
                PanelLayoutHelper.IgnoreLayout(toggle);
                MenuUiUtil.SetButtonLabel(toggle, "Mods >");
                PauseMenuHelper.SetButtonAction(toggle, Toggle);
                _toggle = toggle.GetComponent<Button>();
                _toggle.navigation = new Navigation { mode = Navigation.Mode.Automatic };
                ApplyMenuColors(_toggle);
                _divider = CreateMenuDivider();

                // A sibling on the root canvas can sit outside the vanilla frame,
                // including when the game's own layout or mask controls that frame.
                _panel = CreateRect("RechargeModsMenu", canvas);
                _panel.gameObject.SetActive(false);
                _panel.anchorMin = _panel.anchorMax = canvas.pivot;
                _panel.pivot = new Vector2(0f, 1f);

                var image = _panel.gameObject.AddComponent<Image>();
                var frameImage = frame.GetComponent<Image>();
                image.sprite = frameImage != null ? frameImage.overrideSprite : null;
                image.color = frameImage != null ? frameImage.color : new Color(0.23f, 0.23f, 0.23f, 1f);
                if (image.sprite != null && image.sprite.border.sqrMagnitude > 0f) image.type = Image.Type.Sliced;

                for (int i = 0; i < _rows.Length; i++)
                    _rows[i] = CreateButton(_panel, "ModRow" + i);
                _pageButton = CreateButton(_panel, "ModsPage");
                _pageButton.onClick.AddListener(NextPage);
                var source = _nativeDivider != null ? _nativeDivider.GetComponentInChildren<Graphic>(true) : null;
                for (int i = 0; i < _listDividers.Length; i++)
                {
                    var divider = PanelWidgets.CreateDivider(_panel, Vector2.zero, 0f,
                        source != null ? source.color : new Color(1f, 1f, 1f, 0.25f));
                    divider.layer = _panel.gameObject.layer;
                    divider.GetComponent<Image>().raycastTarget = false;
                    _listDividers[i] = (RectTransform)divider.transform;
                }
                Refresh();
            }

            private void OnEnable()
            {
                _shownFrame = Time.frameCount;
                Canvas.willRenderCanvases += FitVisibleMenu;
                Refresh();
                if (_returnTo != null && _open) Select(_returnTo.interactable ? _returnTo : _rows[0]);
                _returnTo = null;
            }

            private void OnDisable()
            {
                Canvas.willRenderCanvases -= FitVisibleMenu;
                // A list (map picker) never outlives the menu it was opened from.
                _list = null;
                _listOwner = null;
                // The picker can keep using the expanded frame while the menu is hidden.
                if (_modsVisible) SetFrameExpanded(false);
                if (_panel != null) _panel.gameObject.SetActive(false);
                if (_returnTo == null) _open = false;
            }

            private void OnDestroy()
            {
                if (_toggle != null) UnityEngine.Object.Destroy(_toggle.gameObject);
                if (_divider != null) UnityEngine.Object.Destroy(_divider.gameObject);
                if (_panel != null) UnityEngine.Object.Destroy(_panel.gameObject);
            }

            public void Refresh()
            {
                if (_panel == null) return;
                if (ListOpen)
                {
                    ShowListPage();
                    if (_panel.gameObject.activeInHierarchy) Layout();
                    return;
                }
                if (!_modsVisible) return;
                var entries = MenuRowRegistry.Visible();
                if (entries.Count == 0) _open = false;
                SetFrameExpanded(isActiveAndEnabled && entries.Count > 0);
                MenuUiUtil.SetButtonLabel(_toggle.gameObject, _open ? "Mods <" : "Mods >");
                bool showList = _frameExpanded && _open;
                if (showList) ShowPage(entries);
                _panel.gameObject.SetActive(showList);
                if (_panel.gameObject.activeInHierarchy) Layout();
            }

            public bool SetModsVisible(bool visible)
            {
                if (_modsVisible == visible) return _frameExpanded;
                _modsVisible = visible;
                SetModsRowVisible(visible && _frameExpanded);
                if (!visible)
                {
                    _open = false;
                    _panel.gameObject.SetActive(false);
                }
                else
                {
                    Refresh();
                }
                return _frameExpanded;
            }

            private void ShowPage(IReadOnlyList<MenuRowRegistry.Entry> entries)
            {
                _pageCount = Math.Max(1, (int)Math.Ceiling(entries.Count / (double)RowsPerPage));
                _pageIndex = Math.Min(_pageIndex, _pageCount - 1);
                int start = _pageIndex * RowsPerPage;
                for (int i = 0; i < _rows.Length; i++)
                {
                    var row = _rows[i];
                    var entry = start + i < entries.Count ? entries[start + i] : null;
                    row.interactable = entry != null;
                    MenuUiUtil.SetButtonLabel(row.gameObject, entry?.Label ?? "");
                    PauseMenuHelper.SetButtonAction(row.gameObject, entry == null ? null : () => OpenEntry(row, entry));
                }
                MenuUiUtil.SetButtonLabel(_pageButton.gameObject, "Page " + (_pageIndex + 1) + " / " + _pageCount);
            }

            /// <summary>
            /// Hands the side panel to an external list (the map picker, ...) with the Mods list's
            /// frame, paging and row styling. The main menu is left untouched, so its own rows keep
            /// working while the list is open.
            /// </summary>
            public bool ShowList(string owner, IReadOnlyList<PauseMenuHelper.SideListRow> rows)
            {
                if (_panel == null || rows == null) return false;
                _list = rows;
                _listOwner = owner;
                _pageIndex = 0;
                _open = false;
                _listShownFrame = Time.frameCount;
                // A list needs the wider frame even when no mods are installed (and so no Mods row).
                SetFrameExpanded(isActiveAndEnabled);
                SetModsRowVisible(MenuRowRegistry.Visible().Count > 0);
                MenuUiUtil.SetButtonLabel(_toggle.gameObject, "Mods >");
                ShowListPage();
                _panel.gameObject.SetActive(true);
                if (_panel.gameObject.activeInHierarchy) Layout();
                if (rows.Count > 0) Select(_rows[0]);
                return true;
            }

            private void ShowListPage()
            {
                int count = _list?.Count ?? 0;
                _pageCount = Math.Max(1, (int)Math.Ceiling(count / (double)RowsPerPage));
                _pageIndex = Math.Min(_pageIndex, _pageCount - 1);
                int start = _pageIndex * RowsPerPage;
                for (int i = 0; i < _rows.Length; i++)
                {
                    var row = _rows[i];
                    var entry = start + i < count ? _list[start + i] : null;
                    row.interactable = entry != null;
                    MenuUiUtil.SetButtonLabel(row.gameObject, entry?.Label ?? "");
                    PauseMenuHelper.SetButtonAction(row.gameObject, entry == null ? null : () => entry.OnClick?.Invoke());
                }
                MenuUiUtil.SetButtonLabel(_pageButton.gameObject, "Page " + (_pageIndex + 1) + " / " + _pageCount);
            }

            /// <summary>Closes an external list; the Mods list comes back if it was open.</summary>
            public bool CloseList()
            {
                if (!ListOpen) return false;
                _list = null;
                _listOwner = null;
                _pageIndex = 0;
                if (_panel != null) _panel.gameObject.SetActive(false);
                Refresh();
                if (_toggle != null && _toggle.isActiveAndEnabled) Select(_toggle);
                return true;
            }

            public bool IsListOpen(string owner) => ListOpen && _listOwner == owner;

            private void SetFrameExpanded(bool expanded)
            {
                if (_frameExpanded == expanded) return;
                _frameExpanded = expanded;
                if (!expanded)
                {
                    SetModsRowVisible(false);
                    if (_quit != null) _quit.anchoredPosition = _quitPosition;
                    foreach (var element in _titleElements)
                        if (element.Rect != null) element.Rect.anchoredPosition = element.Original;
                    _titleElements.Clear();
                    if (_frame != null)
                    {
                        _frame.sizeDelta = _frameSize;
                        _frame.anchoredPosition = _framePosition;
                    }
                    if (_main != null)
                    {
                        MainPosition = _mainPosition;
                        _main.localScale = _mainScale;
                    }
                    if (_fitter != null) _fitter.verticalFit = _verticalFit;
                    return;
                }

                _mainPosition = MainPosition;
                _mainScale = _main.localScale;
                _framePosition = _frame.anchoredPosition;
                _frameSize = _frame.sizeDelta;
                _quitPosition = _quit.anchoredPosition;
                _fitter = _frame.GetComponent<ContentSizeFitter>();
                if (_fitter != null)
                {
                    _verticalFit = _fitter.verticalFit;
                    _fitter.verticalFit = ContentSizeFitter.FitMode.Unconstrained;
                }

                // Put Mods in Quit's original slot and move Quit down by one native row.
                float step = _settings.anchoredPosition.y - _quitPosition.y;
                if (step <= 0f) step = 60f;
                ((RectTransform)_toggle.transform).anchoredPosition = _quitPosition;
                _quitWithMods = _quitPosition - Vector2.up * step;
                _quit.anchoredPosition = _quitWithMods;
                var growth = _quit.parent.TransformVector(Vector3.up * step);
                // Raise the entire menu by half the added row, which keeps
                // its centre near the original one. The viewport can lift it more.
                _mainLift = Mathf.Abs(_canvas.InverseTransformVector(growth).y) * 0.5f;
                var frameGrowth = Mathf.Abs(_frame.InverseTransformVector(growth).y);
                var parentGrowth = _frame.parent.InverseTransformVector(growth).y;
                _frame.sizeDelta += new Vector2(0f, frameGrowth);
                _frame.anchoredPosition -= Vector2.up * (parentGrowth * (1f - _frame.pivot.y));
                _expandedPosition = MainPosition;
                if (_divider != null)
                    _divider.anchoredPosition = new Vector2(_divider.anchoredPosition.x, _quitPosition.y - step * 0.5f);
                SetModsRowVisible(true);
                if (_main.Find("StartGame") != null) RaiseTitleContent(growth * TitleContentLiftFraction);
                _fitArea = default;
            }

            private void SetModsRowVisible(bool visible)
            {
                _toggle.gameObject.SetActive(visible);
                if (_divider != null) _divider.gameObject.SetActive(visible);
            }

            private void RaiseTitleContent(Vector3 lift)
            {
                // Keep the dividers aligned with the raised labels inside the title frame.
                foreach (var rect in _main.GetComponentsInChildren<RectTransform>())
                {
                    bool divider = rect == _divider || ((rect.parent == _main || rect.parent == _quit.parent)
                        && rect.name.StartsWith("Line", StringComparison.Ordinal));
                    if (!divider)
                    {
                        var graphic = rect.GetComponent<Graphic>();
                        if (graphic == null || !graphic.isActiveAndEnabled || (!(graphic is TMP_Text) && !(graphic is Text))) continue;
                    }
                    var original = rect.anchoredPosition;
                    var raised = original + (Vector2)rect.parent.InverseTransformVector(lift);
                    _titleElements.Add((rect, original, raised));
                    rect.anchoredPosition = raised;
                }
            }

            private RectTransform CreateMenuDivider()
            {
                foreach (Transform child in _quit.parent)
                {
                    if (!(child is RectTransform line) || !child.name.StartsWith("Line", StringComparison.Ordinal)) continue;
                    if (line.anchoredPosition.y <= _quit.anchoredPosition.y || line.anchoredPosition.y >= _settings.anchoredPosition.y) continue;
                    _nativeDivider = line;
                    var divider = UnityEngine.Object.Instantiate(line, line.parent);
                    divider.name = "ModsPagerDivider";
                    divider.gameObject.SetActive(false);
                    PanelLayoutHelper.IgnoreLayout(divider.gameObject);
                    return divider;
                }
                return null;
            }

            private Vector2 VerticalBounds(RectTransform rect)
            {
                rect.GetWorldCorners(_corners);
                return new Vector2(_canvas.InverseTransformPoint(_corners[0]).y, _canvas.InverseTransformPoint(_corners[2]).y);
            }

            private Vector2 MainMenuBounds()
            {
                var frame = VerticalBounds(_frame);
                var quit = VerticalBounds(_quit);
                if (!_modsVisible)
                {
                    // Fit to the main menu's Quit position while the picker uses it as Back.
                    var offset = _quit.parent.TransformVector(_quitWithMods - _quit.anchoredPosition);
                    quit += Vector2.one * _canvas.InverseTransformVector(offset).y;
                }
                return new Vector2(Mathf.Min(frame.x, quit.x), Mathf.Max(frame.y, quit.y));
            }

            private void FitMainMenu()
            {
                _fitArea = _canvas.rect;
                float height = _fitArea.height - MainBottomMargin - Margin;
                if (height <= 0f) return;

                // Start every fit from the expanded layout at native scale.
                MainPosition = _expandedPosition;
                _main.localScale = _mainScale;
                var bounds = MainMenuBounds();
                float fullHeight = bounds.y - bounds.x;
                if (fullHeight > height)
                {
                    _main.localScale = _mainScale * (height / fullHeight);
                    bounds = MainMenuBounds();
                }
                float shift = Mathf.Clamp(_mainLift, _fitArea.yMin + MainBottomMargin - bounds.x, _fitArea.yMax - Margin - bounds.y);
                MainPosition += (Vector2)_main.parent.InverseTransformVector(_canvas.TransformVector(Vector3.up * shift));
            }

            private void Toggle()
            {
                // Mods clicked while another list (the map picker) owns the panel: switch to Mods.
                if (ListOpen) { _list = null; _listOwner = null; }
                _open = !_open;
                if (_open) _pageIndex = 0;

                Refresh();
                if (_toggle.isActiveAndEnabled) Select(_open ? _rows[0] : _toggle);
            }

            private void NextPage()
            {
                if (_pageCount <= 1) return;
                _pageIndex = (_pageIndex + 1) % _pageCount;
                Refresh();
            }

            private void OpenEntry(Button row, MenuRowRegistry.Entry entry)
            {
                _returnTo = row;
                _main.gameObject.SetActive(false);
                try { entry.OnClick(); }
                catch { _main.gameObject.SetActive(true); throw; }
            }

            private static void Select(Button button)
            {
                var events = EventSystem.current;
                if (events != null) events.SetSelectedGameObject(button.gameObject);
            }

            private void Update()
            {
                if (_panel == null) return;
                var kb = Keyboard.current;
                if (kb == null || !kb.escapeKey.wasPressedThisFrame) return;
                // Escape backs out of an external list first, then out of Mods.
                // (Skip the frame the list was opened on: the same Escape press
                // that closed a save list reopens this one.)
                if (ListOpen) { if (Time.frameCount != _listShownFrame) CloseList(); return; }
                // An Escape that just closed a mod's settings also re-enables this menu.
                if (_open && Time.frameCount != _shownFrame) Toggle();
            }

            private void FitVisibleMenu()
            {
                // A side list still needs re-docking on resize when no mods expanded the frame.
                if (!_frameExpanded && !ListOpen) return;
                if (_frameExpanded)
                {
                    if (_modsVisible && _titleQuitLabel != null && _titleQuitLabel.text == "Quit game")
                    {
                        // Keep the title button's localizer and the map picker's label ownership.
                        var label = _titleQuitLabel.GetComponent<ModLabel>();
                        if (label != null) label.Text = "Quit Game";
                        else _titleQuitLabel.text = "Quit Game";
                    }
                    // Unity can rebuild the layout without changing the canvas size.
                    // Check the real frame and Quit bounds just before rendering.
                    if (_modsVisible && _quit.anchoredPosition != _quitWithMods) _quit.anchoredPosition = _quitWithMods;
                    foreach (var element in _titleElements)
                        if (element.Rect != null && element.Rect.anchoredPosition != element.Raised)
                            element.Rect.anchoredPosition = element.Raised;
                    var area = _canvas.rect;
                    var bounds = MainMenuBounds();
                    if (_fitArea != area || bounds.x < area.yMin + MainBottomMargin - 0.1f
                        || bounds.y > area.yMax - Margin + 0.1f) FitMainMenu();
                }
                if (_panel != null && _panel.gameObject.activeInHierarchy) Layout();
            }

            private void Layout()
            {
                Rect area = _canvas.rect;
                if (area.width <= Margin * 2f || area.height <= (Margin + Padding) * 2f) return;
                _frame.GetWorldCorners(_corners);
                var bottomLeft = _canvas.InverseTransformPoint(_corners[0]);
                var topRight = _canvas.InverseTransformPoint(_corners[2]);

                // Match the fitted main frame and share its height across all rows.
                float height = Mathf.Min(topRight.y - bottomLeft.y, area.height - Margin * 2f);
                if (height <= Padding * 2f) return;
                float rowHeight = (height - Padding * 2f) / (RowsPerPage + 1);
                float width = Mathf.Clamp(topRight.x - bottomLeft.x, 176f, 320f);
                float right = topRight.x + Margin;
                float available = area.xMax - Margin - right;
                width = Mathf.Min(width, area.width - Margin * 2f);
                // With room beside the main menu, dock there. On narrow windows,
                // the same button and list fit at the right edge of the canvas.
                if (available >= Mathf.Min(width, 176f)) width = Mathf.Min(width, available);
                float x = Mathf.Clamp(right, area.xMin + Margin, area.xMax - Margin - width);
                float y = Mathf.Clamp(topRight.y, area.yMin + Margin + height, area.yMax - Margin);
                _panel.anchoredPosition = new Vector2(x, y);
                _panel.sizeDelta = new Vector2(width, height);

                float lineHeight = 2f;
                if (_nativeDivider != null)
                {
                    var line = VerticalBounds(_nativeDivider);
                    lineHeight = Mathf.Min(rowHeight, Mathf.Max(1f, line.y - line.x));
                }
                float dividerInset = width * DividerInsetFraction;
                for (int i = 0; i < _rows.Length; i++)
                {
                    PlaceRow((RectTransform)_rows[i].transform, Padding + i * rowHeight, rowHeight);
                    PlaceRow(_listDividers[i], Padding + (i + 1) * rowHeight - lineHeight * 0.5f, lineHeight, dividerInset);
                }
                PlaceRow((RectTransform)_pageButton.transform, Padding + RowsPerPage * rowHeight, rowHeight);
                for (int i = 0; i < _rows.Length; i++) FitRow(_rows[i], i);
                FitRow(_pageButton, _rows.Length);
            }

            // Long mod or map names shrink to the row instead of being drawn over
            // the panel border; only resized when the text or the row width changes.
            private void FitRow(Button button, int index)
            {
                var label = button != null
                    ? button.transform.Find("Text (TMP)")?.GetComponent<TMP_Text>()
                    : null;
                if (label == null) return;
                string text = label.text ?? "";
                float width = label.rectTransform.rect.width;
                if (_fitText[index] == text && _fitWidth[index] == width) return;
                _fitText[index] = text;
                _fitWidth[index] = width;
                PanelWidgets.FitLabel(label);
            }

            private Button CreateButton(Transform parent, string name)
            {
                var row = CreateRect(name, parent);
                var image = row.gameObject.AddComponent<Image>();
                image.color = Color.clear;
                image.canvasRenderer.cullTransparentMesh = false;
                var button = row.gameObject.AddComponent<Button>();
                var text = PanelWidgets.CreateLabel(row, _font, Vector2.zero, Vector2.zero, "", 22f, Color.white);
                text.name = "Text (TMP)";
                text.gameObject.layer = row.gameObject.layer;
                text.raycastTarget = false;
                var textRect = text.rectTransform;
                textRect.anchorMin = Vector2.zero;
                textRect.anchorMax = Vector2.one;
                textRect.offsetMin = new Vector2(5f, 0f);
                textRect.offsetMax = new Vector2(-5f, 0f);
                ApplyMenuColors(button);
                return button;
            }

            private void ApplyMenuColors(Button button)
            {
                // Tint the TMP label through Unity's button states. The
                // row's image still receives mouse events across its full area.
                MenuUiUtil.SetButtonTextColor(button.gameObject, Color.white);
                var text = button.transform.Find("Text (TMP)");
                button.targetGraphic = text != null ? text.GetComponent<TMP_Text>() : button.targetGraphic;
                button.transition = Selectable.Transition.ColorTint;
                button.colors = _menuColors;
            }

            private static void PlaceRow(RectTransform row, float top, float height, float inset = Padding)
            {
                row.anchorMin = new Vector2(0f, 1f);
                row.anchorMax = Vector2.one;
                row.pivot = new Vector2(0.5f, 1f);
                row.anchoredPosition = new Vector2(0f, -top);
                row.sizeDelta = new Vector2(-2f * inset, height);
            }
        }

        public static bool SetModsVisible(pauseMenuScript menu, bool visible)
        {
            var runtime = RuntimeFor(menu);
            return runtime != null && runtime.SetModsVisible(visible);
        }

        public static bool ShowList(pauseMenuScript menu, string owner, IReadOnlyList<PauseMenuHelper.SideListRow> rows)
        {
            if (menu == null) return false;
            // A list may be the first thing to need the panel (a mod-less install has no other reason to build it).
            EnsureBuilt(menu);
            var runtime = RuntimeFor(menu);
            return runtime != null && runtime.ShowList(owner, rows);
        }

        public static bool IsListOpen(pauseMenuScript menu, string owner)
        {
            var runtime = RuntimeFor(menu);
            return runtime != null && runtime.IsListOpen(owner);
        }

        public static bool CloseList(pauseMenuScript menu)
        {
            var runtime = RuntimeFor(menu);
            return runtime != null && runtime.CloseList();
        }

        public static void Refresh(pauseMenuScript menu) => RuntimeFor(menu)?.Refresh();

        private static Runtime RuntimeFor(pauseMenuScript menu)
        {
            var root = menu != null ? MenuReflection.MainBit(menu)?.transform.Find("ModsPager") : null;
            return root != null ? root.GetComponent<Runtime>() : null;
        }

        public static GameObject EnsureBuilt(pauseMenuScript menu)
        {
            var main = MenuReflection.MainBit(menu)?.transform;
            if (main == null) return null;
            var existing = main.Find("ModsPager");
            if (existing != null)
            {
                existing.GetComponent<Runtime>()?.Refresh();
                return existing.gameObject;
            }

            var canvas = main.GetComponentInParent<Canvas>(true)?.rootCanvas;
            var settings = main.Find("Settings") as RectTransform;
            var quit = FindQuit(main);
            var font = settings != null ? settings.GetComponentInChildren<TMP_Text>(true)?.font : null;
            var frame = FindFrame(main);
            if (frame == null || canvas == null || !(canvas.transform is RectTransform canvasRect) || quit == null || font == null) return null;

            var root = CreateRect("ModsPager", main);
            PanelLayoutHelper.IgnoreLayout(root.gameObject);
            var runtime = root.gameObject.AddComponent<Runtime>();
            runtime.Build(main, frame, canvasRect, settings, quit, font);
            return root.gameObject;
        }

        private static RectTransform FindQuit(Transform main)
        {
            RectTransform best = null;
            foreach (var button in main.GetComponentsInChildren<Button>(true))
            {
                if (!button.gameObject.activeInHierarchy || !(button.transform is RectTransform rect)) continue;
                var label = button.GetComponentInChildren<TMP_Text>(true)?.text ?? "";
                if (button.name.IndexOf("quit", StringComparison.OrdinalIgnoreCase) < 0
                    && label.IndexOf("quit", StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (best == null || rect.anchoredPosition.y < best.anchoredPosition.y) best = rect;
            }
            if (best != null) return best;

            foreach (var name in new[] { "QuitToDesktop", "Quit to menu", "QuitToMenu" })
            {
                var quit = main.Find(name) as RectTransform;
                if (quit != null && quit.GetComponent<Button>() != null) return quit;
            }
            return null;
        }

        // At the title screen the panel itself is the image. The in-game menu
        // puts its backdrop on a child; use that frame as the docking reference.
        private static RectTransform FindFrame(Transform main)
        {
            var best = main as RectTransform;
            if (best != null && main.GetComponent<Graphic>() != null) return best;
            float bestArea = 0f;
            foreach (Transform child in main)
            {
                if (!(child is RectTransform rect) || child.GetComponent<Image>() == null || child.GetComponent<Button>() != null) continue;
                if (child.name.StartsWith("Line", StringComparison.Ordinal)) continue;
                float area = rect.rect.width * rect.rect.height;
                if (area > bestArea) { best = rect; bestArea = area; }
            }
            return best;
        }

        private static RectTransform CreateRect(string name, Transform parent)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.layer = parent.gameObject.layer;
            go.transform.SetParent(parent, false);
            return (RectTransform)go.transform;
        }
    }
}

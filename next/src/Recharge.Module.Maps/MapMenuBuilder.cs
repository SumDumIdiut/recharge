using System;
using System.Collections.Generic;
using System.Linq;
using Recharge.ModApi;
using TMPro;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.Localization;
using UnityEngine.UI;

namespace Recharge.Module.Maps;


// "Start Game" (renamed from the real vanilla "Start Demo") and "Delete save
// data" open the map picker instead of acting directly. The picker shows up
// to four maps at a time (Base Game, B-side or custom maps). A "Page n/m >"
// row swaps between groups of four, and Quit acts as Back until the picker
// closes.
//
// An alternative Start Game menu keeps the main menu functional and draws the
// map list beside it, in the same side panel as Mods. The Settings panel's
// "Start Menu" row switches between the two (persisted in PlayerPrefs).
internal static class MapMenuBuilder
{
    private const int RowsPerPage = 4;
    private const string ListOwner = "maps";

    // The Start Game menu always uses the Picker now; the old Side Panel style and
    // its Settings toggle ("Start Menu: Picker/Side Panel") were removed.
    private static bool SidePanelStyle => false;

    public static void Install(pauseMenuScript menu)
    {
        if (PauseMenuHelper.MainBit(menu) == null || PauseMenuHelper.SettingsBit(menu) == null) return;
        if (PauseMenuHelper.MainBit(menu).transform.Find("MapsInstalled") != null) return; // idempotent per instance

        var marker = new GameObject("MapsInstalled");
        marker.transform.SetParent(PauseMenuHelper.MainBit(menu).transform, false);
        var host = marker.AddComponent<MenuHost>();

        // The real B-side/hard-mode row (gated behind BsideEnabler, only
        // visible once snfDemoCompleted is set) now lives inside the map
        // picker instead - hide the original so it doesn't float redundantly.
        var bside = PauseMenuHelper.MainBit(menu).GetComponentInChildren<BsideEnabler>(true);
        if (bside != null) bside.gameObject.SetActive(false);

        // True vertical centering, not a guessed offset: this panel's own
        // anchor (both min and max) already sits at the screen's vertical
        // center (0.5) and its pivot is 0.5 too, so anchoredPosition.y = 0
        // centers it exactly regardless of how tall it ends up once
        // PauseMenuHelper sizes it for however many mods are installed.
        // Applied once, before that sizing runs, so it's baked into every
        // measurement downstream rather than fighting it after the fact.
        var mainRt = PauseMenuHelper.MainBit(menu).GetComponent<RectTransform>();
        if (mainRt != null) mainRt.anchoredPosition = new Vector2(mainRt.anchoredPosition.x, 0f);

        var startGame = PauseMenuHelper.MainBit(menu).transform.Find("StartGame") as RectTransform;
        var deleteSave = PauseMenuHelper.MainBit(menu).transform.Find("DeleteSave") as RectTransform;
        var settings = PauseMenuHelper.MainBit(menu).transform.Find("Settings") as RectTransform;
        if (startGame == null || settings == null) return;

        host.Picker = BuildPicker(menu, startGame);

        PauseMenuHelper.SetButtonLabel(startGame.gameObject, "Start Game");
        var startBtn = startGame.GetComponent<Button>();
        startBtn.onClick = new Button.ButtonClickedEvent();
        startBtn.onClick.AddListener(() => OpenStartMenu(menu, host, deleteMode: false));

        if (deleteSave != null)
        {
            var deleteBtn = deleteSave.GetComponent<Button>();
            deleteBtn.onClick = new Button.ButtonClickedEvent();
            deleteBtn.onClick.AddListener(() => OpenStartMenu(menu, host, deleteMode: true));
        }
    }

    private static void OpenStartMenu(pauseMenuScript menu, MenuHost host, bool deleteMode)
    {
        if (!SidePanelStyle || host == null) { host?.Picker?.Open(deleteMode); return; }
        OpenSidePanel(menu, host, deleteMode);
    }

    private enum MapPageKind { BaseGame, BSide, Custom }

    private struct MapPage
    {
        public string Label;
        public MapPageKind Kind;
        public string MapId; // only meaningful for Custom
        public Action Play;
    }

    // The side-panel Start Game menu: the map list stays beside the menu (same
    // frame, styling and paging as Mods) and the main menu keeps working.
    private static void OpenSidePanel(pauseMenuScript menu, MenuHost host, bool deleteMode)
    {
        if (menu == null) return; // the save picker's Back callback can outlive a menu
        if (!deleteMode && PauseMenuHelper.IsSideListOpen(menu, ListOwner))
        {
            PauseMenuHelper.CloseSideList(menu);
            return;
        }
        // Start Game while a map's save list is up takes the panel back.
        host?.Saves?.Hide();

        var counters = new Dictionary<string, int>();
        var rows = new List<PauseMenuHelper.SideListRow>();
        foreach (var page in BuildPageList(menu))
        {
            var p = page; // local copy for the closure
            var row = new PauseMenuHelper.SideListRow(deleteMode ? "Delete " + p.Label : p.Label);
            row.OnClick = () => ActivateSide(menu, host, row, p, deleteMode, counters);
            rows.Add(row);
        }

        if (!PauseMenuHelper.ShowSideList(menu, ListOwner, rows))
        {
            Debug.LogWarning("[RechargeMaps] the pause menu has no side panel for the map list");
            host?.Picker?.Open(deleteMode);
        }
    }

    private static void ActivateSide(pauseMenuScript menu, MenuHost host, PauseMenuHelper.SideListRow row,
        MapPage page, bool deleteMode, Dictionary<string, int> counters)
    {
        if (page.Kind != MapPageKind.BSide && SaveSlots.Library != null)
        {
            OpenSavesSide(menu, host, page, deleteMode);
            return;
        }

        if (deleteMode)
        {
            DeleteLegacy(menu, row, page, counters);
            return;
        }

        page.Play();
        if (menu.menuOpen) menu.menuButtonPressed();
    }

    private static void OpenSavesSide(pauseMenuScript menu, MenuHost host, MapPage page, bool deleteMode)
    {
        var main = PauseMenuHelper.MainBit(menu);
        var startGame = main != null ? main.transform.Find("StartGame") as RectTransform : null;
        if (host == null || main == null || startGame == null) return;
        if (host.Saves == null)
        {
            var template = startGame.GetComponent<Button>();
            if (template == null) return;
            host.Saves = new SavePicker((RectTransform)main.transform, template);
        }

        bool custom = page.Kind == MapPageKind.Custom;
        PauseMenuHelper.CloseSideList(menu);
        host.Saves.Closed = () => OpenSidePanel(menu, host, deleteMode);
        host.Saves.Open(
            custom ? SaveLibrary.Custom : SaveLibrary.Vanilla,
            custom ? SaveSlots.MapId(page.MapId) : SaveLibrary.BaseGame,
            page.Label,
            custom ? SaveSlots.Revision(page.MapId) : null,
            deleteMode,
            entry => PlaySaveSide(menu, page, entry, host));
    }

    private static void PlaySaveSide(pauseMenuScript menu, MapPage page, SaveEntry entry, MenuHost host)
    {
        if (DoorTransition.Busy) return;
        var session = SaveSlots.Prepare(entry, page.MapId);
        if (page.Kind == MapPageKind.Custom)
            MapManager.Instance.PlayMap(page.MapId, menu, false, session);
        else
            MapManager.LeaveTo(menu, false, session);
        host.Saves.Hide();
        if (menu.menuOpen) menu.menuButtonPressed();
    }

    // B-side (and installs without save hooks) keeps the vanilla delete flow.
    private static void DeleteLegacy(pauseMenuScript menu, PauseMenuHelper.SideListRow row, MapPage page,
        Dictionary<string, int> counters)
    {
        if (page.Kind == MapPageKind.Custom)
        {
            var messages = GetDeleteMessages(menu);
            counters.TryGetValue(page.MapId, out var counter);
            counter++;
            counters[page.MapId] = counter;
            if (messages == null || counter >= 4)
            {
                var playing = MapManager.CurrentMapId == page.MapId;
                MapSaves.Delete(page.MapId);
                if (playing) MapManager.Instance.PlayMap(page.MapId, menu);
                counters[page.MapId] = 0;
                row.Label = "Delete " + page.Label;
            }
            else
            {
                row.Label = messages[counter].GetLocalizedString();
            }
        }
        else
        {
            bool isHard = page.Kind == MapPageKind.BSide;
            if (isHard) menu.DeleteSavePressedHard();
            else menu.DeleteSavePressed();
            row.Label = RealDeleteButtonText(menu, isHard);
        }

        PauseMenuHelper.RefreshSideList(menu);
    }

    /// <summary>Lives on the per-menu marker: owns the side menu's save picker and its layout/lifetime.</summary>
    private sealed class MenuHost : MonoBehaviour
    {
        public PickerState Picker;
        public SavePicker Saves;

        private void Update()
        {
            if (Saves == null || !Saves.Visible) return;
            var kb = Keyboard.current; // Escape backs out of saves to the map list
            if (kb != null && kb.escapeKey.wasPressedThisFrame) Saves.Back();
        }

        private void LateUpdate()
        {
            if (Saves != null && Saves.Visible) Saves.Layout();
        }

        private void OnDisable() => Saves?.Hide();
        private void OnDestroy() => Saves?.Destroy();
    }


    private class PickerState : MonoBehaviour
    {
        private const float RowLiftFraction = 0.22f;
        private const float BackOffsetFraction = 0.14f;

        public pauseMenuScript Menu;
        public RectTransform StartGame;
        public RectTransform DeleteSave;
        public RectTransform Settings;
        public GameObject[] Slots; // up to RowsPerPage map rows, reused across picker pages
        public GameObject PagerRow;
        public GameObject PageButton;
        public RectTransform Quit; // doubles as the picker's Back row
        public Button QuitButton;
        public Button.ButtonClickedEvent QuitClick;
        public string QuitLabel;

        private bool _open;
        private bool _deleteMode;
        private int _pageIndex;
        private List<MapPage> _pages;
        private readonly Dictionary<string, int> _deleteCounters = new Dictionary<string, int>();
        private float[] _rowYs;
        private float _rowLift;
        private bool _quitMoved;
        private Vector2 _quitOrigPos;
        private readonly List<GameObject> _hiddenDividers = new List<GameObject>();
        private readonly List<GameObject> _pickerDividers = new List<GameObject>();
        private SavePicker _saves;

        public void Open(bool deleteMode)
        {
            _saves?.Hide();
            _deleteMode = deleteMode;
            _pageIndex = 0;
            _deleteCounters.Clear();
            _pages = BuildPageList(Menu);

            bool expanded = PauseMenuHelper.SetModsMenuVisible(Menu, false);
            float topY = StartGame.anchoredPosition.y;
            float slot1Y = DeleteSave != null ? DeleteSave.anchoredPosition.y : topY - 60f;
            float rowSpacing = Mathf.Abs(topY - slot1Y);
            if (rowSpacing == 0f) rowSpacing = 60f;
            float panelBottom = float.NegativeInfinity;
            try
            {
                var panelRt = PauseMenuHelper.MainBit(Menu).GetComponent<RectTransform>();
                var rowParent = (Quit != null ? Quit.parent : StartGame.parent) as RectTransform;
                if (panelRt != null && rowParent == panelRt) panelBottom = panelRt.rect.yMin;
                else if (panelRt != null && rowParent != null)
                    panelBottom = rowParent.InverseTransformPoint(panelRt.TransformPoint(new Vector3(0f, panelRt.rect.yMin, 0f))).y;
            }
            catch (Exception) { }
            int backIndex = RowsPerPage + 1;
            float backY = topY - backIndex * rowSpacing;
            if (expanded && Quit != null && Quit.anchoredPosition.y < topY)
            {
                // Use the original Quit position to space the rows in the fitted frame.
                backY = Quit.anchoredPosition.y;
                rowSpacing = (topY - backY) / backIndex;
            }
            else if (!float.IsNegativeInfinity(panelBottom) && backY - rowSpacing * 0.5f < panelBottom)
            {
                float fit = (topY - (panelBottom + rowSpacing * 0.5f)) / backIndex;
                if (fit > 0f && fit < rowSpacing) { rowSpacing = fit; backY = topY - backIndex * rowSpacing; }
            }
            _rowLift = rowSpacing * RowLiftFraction;
            topY += _rowLift;
            backY += _rowLift;
            _rowYs = new float[backIndex + 1];
            for (int i = 0; i < backIndex; i++) _rowYs[i] = topY - i * rowSpacing;
            _rowYs[backIndex] = backY;

            for (int i = 0; i < Slots.Length; i++)
                ((RectTransform)Slots[i].transform).anchoredPosition = new Vector2(0f, _rowYs[i]);
            ((RectTransform)PagerRow.transform).anchoredPosition = new Vector2(0f, _rowYs[RowsPerPage]);

            StartGame.gameObject.SetActive(false);
            if (DeleteSave != null) DeleteSave.gameObject.SetActive(false);
            Settings.gameObject.SetActive(false);
            float backButtonY = backY - rowSpacing * BackOffsetFraction;
            if (Quit != null)
            {
                Quit.gameObject.SetActive(true);
                if (!_quitMoved) { _quitOrigPos = Quit.anchoredPosition; _quitMoved = true; }
                Quit.anchoredPosition = new Vector2(_quitOrigPos.x, backButtonY);
                PauseMenuHelper.SetButtonLabel(Quit.gameObject, "Back");
                QuitButton.onClick = new Button.ButtonClickedEvent();
                QuitButton.onClick.AddListener(Close);
            }

            RefreshPage();
            _open = true;

            ApplyPickerDividers();
        }

        private void ApplyPickerDividers()
        {
            try
            {
                RestorePickerDividers();

                // Use the original span to identify the dividers the picker replaces.
                float top = _rowYs[0] - _rowLift + 0.5f;
                float bottom = _rowYs[_rowYs.Length - 1] - _rowLift - 0.5f;
                RectTransform template = null;
                foreach (Transform child in transform)
                {
                    if (!(child is RectTransform line) || !line.gameObject.activeSelf) continue;
                    bool native = line.name.StartsWith("Line", StringComparison.Ordinal);
                    if (!native && !line.name.StartsWith("ModsPagerDivider", StringComparison.Ordinal)) continue;
                    if (template == null || (native && !template.name.StartsWith("Line", StringComparison.Ordinal)))
                        template = line;

                    float y = line.anchoredPosition.y;
                    if (y <= top && y >= bottom) _hiddenDividers.Add(line.gameObject);
                }
                if (template == null) return;

                for (int i = 0; i < _rowYs.Length - 1; i++)
                {
                    var line = UnityEngine.Object.Instantiate(template, template.parent);
                    _pickerDividers.Add(line.gameObject);
                    line.name = "MapsPickerDivider" + i;
                    line.anchoredPosition = new Vector2(template.anchoredPosition.x, (_rowYs[i] + _rowYs[i + 1]) * 0.5f);
                }
                foreach (var line in _hiddenDividers) line.SetActive(false);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[Navigator] picker dividers: " + e.Message);
                RestorePickerDividers();
            }
        }

        private void RestorePickerDividers()
        {
            try
            {
                foreach (var line in _pickerDividers)
                {
                    if (line == null) continue;
                    line.SetActive(false);
                    UnityEngine.Object.Destroy(line);
                }
                _pickerDividers.Clear();
                foreach (var line in _hiddenDividers) if (line != null) line.SetActive(true);
                _hiddenDividers.Clear();
            }
            catch (Exception e)
            {
                Debug.LogWarning("[Navigator] picker dividers: " + e.Message);
            }
        }

        // Safety nets: whenever the panel goes away the lines come back; if it
        // returns while the picker is still open, the picker lines return too.
        private void OnDisable() { _saves?.Hide(); RestorePickerDividers(); }
        private void OnDestroy() { _saves?.Destroy(); RestorePickerDividers(); }
        private void OnEnable() { if (_open && _rowYs != null) ApplyPickerDividers(); }
        private void LateUpdate() => _saves?.Layout();

        // Escape backs out of the picker, same as the Back row.
        private void Update()
        {
            if (!_open) return;
            var kb = Keyboard.current;
            if (kb != null && kb.escapeKey.wasPressedThisFrame) Close();
        }

        public void Close()
        {
            if (!_open) return;
            if (_saves?.Visible == true) { _saves.Back(); return; }
            _open = false;
            RestorePickerDividers();
            foreach (var slot in Slots) slot.SetActive(false);
            PagerRow.SetActive(false);

            StartGame.gameObject.SetActive(true);
            if (DeleteSave != null) DeleteSave.gameObject.SetActive(true);
            Settings.gameObject.SetActive(true);
            if (Quit != null)
            {
                if (_quitMoved) { Quit.anchoredPosition = _quitOrigPos; _quitMoved = false; }
                if (QuitLabel != null) PauseMenuHelper.SetButtonLabel(Quit.gameObject, QuitLabel);
                if (QuitClick != null) QuitButton.onClick = QuitClick;
            }

            // Re-enable Mods after handing Quit back to the main menu.
            PauseMenuHelper.SetModsMenuVisible(Menu, true);
        }

        private int PageCount => Math.Max(1, (int)Math.Ceiling(_pages.Count / (double)RowsPerPage));

        public void NextPage()
        {
            int totalPages = PageCount;
            if (totalPages <= 1) return;
            _pageIndex = (_pageIndex + 1) % totalPages;
            RefreshPage();
        }

        private void RefreshPage()
        {
            int startIdx = _pageIndex * RowsPerPage;
            int count = Math.Max(0, Math.Min(RowsPerPage, _pages.Count - startIdx));
            for (int i = 0; i < RowsPerPage; i++)
            {
                var slot = Slots[i];
                if (i < count)
                {
                    var page = _pages[startIdx + i];
                    slot.SetActive(true);
                    PauseMenuHelper.SetButtonLabel(slot, RowLabel(page));
                    FitSlot(slot);
                    PauseMenuHelper.SetButtonAction(slot, () => ClickRow(slot, page));
                }
                else
                {
                    slot.SetActive(false);
                }
            }

            int totalPages = PageCount;
            PauseMenuHelper.SetButtonLabel(PageButton, "Page " + (_pageIndex + 1) + " / " + totalPages + (totalPages > 1 ? " >" : ""));
            FitSlot(PageButton);
            PagerRow.SetActive(true);
        }

        private static void FitSlot(GameObject slot)
        {
            var label = slot != null ? slot.transform.Find("Text (TMP)")?.GetComponent<TMPro.TMP_Text>() : null;
            if (label != null) PanelWidgets.FitLabel(label);
        }

        private string RowLabel(MapPage page) => _deleteMode ? "Delete " + page.Label : page.Label;

        private void ClickRow(GameObject slot, MapPage page)
        {
            if (page.Kind != MapPageKind.BSide && SaveSlots.Library != null)
            {
                var custom = page.Kind == MapPageKind.Custom;
                _saves ??= new SavePicker((RectTransform)transform, StartGame.GetComponent<Button>());
                _saves.Open(custom ? SaveLibrary.Custom : SaveLibrary.Vanilla,
                    custom ? SaveSlots.MapId(page.MapId) : SaveLibrary.BaseGame, page.Label,
                    custom ? SaveSlots.Revision(page.MapId) : null, _deleteMode,
                    entry => PlaySave(page, entry));
                return;
            }
            _saves?.Hide();
            if (_deleteMode) ClickDelete(slot, page);
            else ClickPlay(page);
        }

        private void PlaySave(MapPage page, SaveEntry entry)
        {
            if (DoorTransition.Busy) return;
            var session = SaveSlots.Prepare(entry, page.MapId);
            if (page.Kind == MapPageKind.Custom)
                MapManager.Instance.PlayMap(page.MapId, Menu, false, session);
            else
                MapManager.LeaveTo(Menu, false, session);
            _saves.Hide();
            if (Menu.menuOpen) Menu.menuButtonPressed();
        }

        private void ClickPlay(MapPage page)
        {
            page.Play();
            if (Menu.menuOpen) Menu.menuButtonPressed();
        }

        // Base Game/B-side: forwards every click straight to the real
        // vanilla DeleteSavePressed()/DeleteSavePressedHard() (same 4-click
        // escalating confirm, same whole-folder + shared currency/upgrade
        // wipe) so this can never drift from real behavior - then mirrors
        // the real button's own resulting text. Both always target their own
        // real folder regardless of which difficulty is currently active, so
        // this is correct for whichever row is clicked.
        // Custom map: no vanilla equivalent exists, so this drives its own
        // escalating confirm (reusing the same real localized messages,
        // tracked per row since several maps can be on screen at once) and,
        // on the final click, deletes that map's own save folder (never Base
        // Game's), reloading it live if it's the one currently in the pocket.
        private void ClickDelete(GameObject slot, MapPage page)
        {
            if (page.Kind == MapPageKind.Custom)
            {
                var messages = GetDeleteMessages(Menu);
                _deleteCounters.TryGetValue(page.MapId, out var counter);
                counter++;
                _deleteCounters[page.MapId] = counter;
                if (messages == null || counter >= 4)
                {
                    var playing = MapManager.CurrentMapId == page.MapId;
                    MapSaves.Delete(page.MapId);
                    if (playing) MapManager.Instance.PlayMap(page.MapId, Menu);
                    _deleteCounters[page.MapId] = 0;
                    PauseMenuHelper.SetButtonLabel(slot, RowLabel(page));
                }
                else
                {
                    PauseMenuHelper.SetButtonLabel(slot, messages[counter].GetLocalizedString());
                }
            }
            else
            {
                bool isHard = page.Kind == MapPageKind.BSide;
                if (isHard) Menu.DeleteSavePressedHard();
                else Menu.DeleteSavePressed();
                PauseMenuHelper.SetButtonLabel(slot, RealDeleteButtonText(Menu, isHard));
            }

            FitSlot(slot);
        }
    }

    private static PickerState BuildPicker(pauseMenuScript menu, RectTransform startGame)
    {
        var main = PauseMenuHelper.MainBit(menu).transform;
        var state = main.gameObject.AddComponent<PickerState>();
        state.Menu = menu;
        state.StartGame = startGame;
        state.DeleteSave = main.Find("DeleteSave") as RectTransform;
        state.Settings = main.Find("Settings") as RectTransform;

        state.Slots = new GameObject[RowsPerPage];
        for (int i = 0; i < RowsPerPage; i++)
        {
            var slotGo = UnityEngine.Object.Instantiate(startGame.gameObject, main);
            slotGo.name = "MapsPickerSlot" + i;
            slotGo.SetActive(false);
            state.Slots[i] = slotGo;
        }

        var pagerRow = new GameObject("MapsPickerPager", typeof(RectTransform));
        var pagerRect = (RectTransform)pagerRow.transform;
        pagerRect.SetParent(main, false);
        pagerRect.sizeDelta = new Vector2(Mathf.Max(100f, pagerRect.sizeDelta.x), 60f);
        pagerRow.SetActive(false);
        state.PagerRow = pagerRow;

        var pageGo = UnityEngine.Object.Instantiate(startGame.gameObject, pagerRow.transform);
        pageGo.name = "MapsPickerPageButton";
        ((RectTransform)pageGo.transform).anchoredPosition = new Vector2(0f, 0f);
        PauseMenuHelper.SetButtonLabel(pageGo, "Page 1 / 1");
        PauseMenuHelper.SetButtonAction(pageGo, state.NextPage);
        state.PageButton = pageGo;

        // Remember the quit row so picker mode can hand it back untouched.
        var quit = main.Find("QuitToDesktop") as RectTransform;
        if (quit != null)
        {
            state.Quit = quit;
            state.QuitButton = quit.GetComponent<Button>();
            state.QuitClick = state.QuitButton != null ? state.QuitButton.onClick : null;
            var labelT = quit.Find("Text (TMP)");
            state.QuitLabel = labelT != null ? labelT.GetComponent<TMPro.TMP_Text>()?.text : null;
        }

        return state;
    }

    // Base Game is always first; B-side mirrors BsideEnabler's own gate
    // exactly (moving it doesn't unlock anything the player hasn't already
    // earned); every <mapsDir>/<id>/map.json folder follows.
    private static List<MapPage> BuildPageList(pauseMenuScript menu)
    {
        var pages = new List<MapPage>
        {
            new MapPage { Label = "Base Game", Kind = MapPageKind.BaseGame, Play = () => MapManager.LeaveTo(menu, false) }
        };

        if (PlayerPrefs.HasKey("snfDemoCompleted"))
        {
            pages.Add(new MapPage { Label = "B-side", Kind = MapPageKind.BSide, Play = () => MapManager.LeaveTo(menu, true) });
        }

        string[] mapIds;
        try
        {
            var dir = MapPaths.MapsDir;
            System.IO.Directory.CreateDirectory(dir);
            mapIds = System.IO.Directory.GetDirectories(dir)
                .Where(d => System.IO.File.Exists(System.IO.Path.Combine(d, "map.json")))
                // The editor's "Test in game" slot is a copy of a map, not one of its own.
                .Where(d => System.IO.Path.GetFileName(d) != "map-maker-test")
                .Select(d => System.IO.Path.GetFileName(d))
                .ToArray();
        }
        catch (Exception e)
        {
            mapIds = Array.Empty<string>();
            Debug.LogError("[RechargeMaps] failed to list maps dir: " + e);
        }

        foreach (var mapId in mapIds)
        {
            var id = mapId; // local copy for the closure
            // Hub installs are in folders named by hub id: shown by their Hub name, others by their own.
            var name = MapDefinition.ReadName(id);
            pages.Add(new MapPage { Label = string.IsNullOrWhiteSpace(name) ? id : name.Trim(), Kind = MapPageKind.Custom, MapId = id, Play = () => MapManager.Instance.PlayMap(id, menu) });
        }

        return pages;
    }

    private static LocalizedString[] GetDeleteMessages(pauseMenuScript menu)
    {
        return Reflect.TryGetField<LocalizedString[]>(menu, "deleteSaveMessages");
    }

    private static string RealDeleteButtonText(pauseMenuScript menu, bool isHard)
    {
        var fieldName = isHard ? "deleteSaveButtonHard" : "deleteSaveButton";
        var tmp = Reflect.TryGetField<TMP_Text>(menu, fieldName);
        return tmp != null ? tmp.text : "Delete Savedata";
    }
}

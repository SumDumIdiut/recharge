using System;
using System.Collections.Generic;
using System.Linq;
using Recharge.ModApi;
using TMPro;
using UnityEngine;
using UnityEngine.Localization;

namespace Recharge.Module.Maps;


// "Start Game" (renamed from the real vanilla "Start Demo") and "Delete save
// data" both open the map list in the pause menu's side panel - the same
// frame, row styling and paging as Mods - instead of switching the main menu
// itself into "picker mode". The main menu's own rows keep working while the
// list is open: Start Game again (or Escape) closes it, and the real B-side
// row is listed here instead of floating on its own.
internal static class MapMenuBuilder
{
    private const string ListOwner = "maps";

    public static void Install(pauseMenuScript menu)
    {
        var main = PauseMenuHelper.MainBit(menu);
        if (main == null || PauseMenuHelper.SettingsBit(menu) == null) return;
        if (main.transform.Find("MapsInstalled") != null) return; // idempotent per instance

        var marker = new GameObject("MapsInstalled");
        marker.transform.SetParent(main.transform, false);

        // The real B-side/hard-mode row (gated behind BsideEnabler, only
        // visible once snfDemoCompleted is set) now lives inside the map
        // list instead - hide the original so it doesn't float redundantly.
        var bside = main.GetComponentInChildren<BsideEnabler>(true);
        if (bside != null) bside.gameObject.SetActive(false);

        // True vertical centering, not a guessed offset: this panel's own
        // anchor (both min and max) already sits at the screen's vertical
        // center (0.5) and its pivot is 0.5 too, so anchoredPosition.y = 0
        // centers it exactly regardless of how tall it ends up once
        // PauseMenuHelper sizes it for however many mods are installed.
        // Applied once, before that sizing runs, so it's baked into every
        // measurement downstream rather than fighting it after the fact.
        var mainRt = main.GetComponent<RectTransform>();
        if (mainRt != null) mainRt.anchoredPosition = new Vector2(mainRt.anchoredPosition.x, 0f);

        var startGame = main.transform.Find("StartGame") as RectTransform;
        var deleteSave = main.transform.Find("DeleteSave") as RectTransform;
        if (startGame == null) return;

        PauseMenuHelper.SetButtonLabel(startGame.gameObject, "Start Game");
        PauseMenuHelper.SetButtonAction(startGame.gameObject, () => OpenMaps(menu, deleteMode: false));

        if (deleteSave != null)
            PauseMenuHelper.SetButtonAction(deleteSave.gameObject, () => OpenMaps(menu, deleteMode: true));
    }

    /// <summary>Shows the map list in the side panel; Start Game toggles it shut again.</summary>
    private static void OpenMaps(pauseMenuScript menu, bool deleteMode)
    {
        if (!deleteMode && PauseMenuHelper.IsSideListOpen(menu, ListOwner))
        {
            PauseMenuHelper.CloseSideList(menu);
            return;
        }

        // Per-open, so a half-finished delete confirmation never carries over.
        var counters = new Dictionary<string, int>();
        var rows = new List<PauseMenuHelper.SideListRow>();
        foreach (var page in BuildPageList(menu))
        {
            var p = page; // local copy for the closure
            var row = new PauseMenuHelper.SideListRow(deleteMode ? "Delete " + p.Label : p.Label);
            row.OnClick = deleteMode
                ? () => ClickDelete(menu, row, p, counters)
                : () => ClickPlay(menu, p);
            rows.Add(row);
        }

        if (!PauseMenuHelper.ShowSideList(menu, ListOwner, rows))
            Debug.LogWarning("[RechargeMaps] the pause menu has no side panel for the map list");
    }

    private enum MapPageKind { BaseGame, BSide, Custom }

    private struct MapPage
    {
        public string Label;
        public MapPageKind Kind;
        public string MapId; // only meaningful for Custom
        public Action Play;
    }

    private static void ClickPlay(pauseMenuScript menu, MapPage page)
    {
        page.Play();
        if (menu.menuOpen) menu.menuButtonPressed();
    }

    // Base Game/B-side: forwards every click straight to the real vanilla
    // DeleteSavePressed()/DeleteSavePressedHard() (same 4-click escalating
    // confirm, same whole-folder + shared currency/upgrade wipe) so this can
    // never drift from real behavior - then mirrors the real button's own
    // resulting text. Both always target their own real folder regardless of
    // which difficulty is currently active, so this is correct for whichever
    // row is clicked.
    // Custom map: no vanilla equivalent exists, so this drives its own
    // escalating confirm (reusing the same real localized messages, tracked
    // per row since several maps can be on screen at once) and, on the final
    // click, deletes that map's own save folder (never Base Game's),
    // reloading it live if it's the one currently in the pocket.
    private static void ClickDelete(pauseMenuScript menu, PauseMenuHelper.SideListRow row, MapPage page,
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

        // The list lives in the shared side panel, so the new text is drawn by it.
        PauseMenuHelper.RefreshSideList(menu);
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

using System;
using System.Collections.Generic;
using System.Linq;
using Recharge.ModApi;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace Recharge.Module.Maps;

// A canvas sibling uses the same frame as Mods and stays outside the map
// menu's mask. The map picker owns it and hides it with the menu.
internal sealed class SavePicker
{
    private const int RowsPerPage = 6;
    private const float Margin = 10f;
    private const float Padding = 8f;
    private readonly RectTransform _frame;
    private readonly RectTransform _canvas;
    private readonly RectTransform _panel;
    private readonly RectTransform _statusPanel;
    private readonly Button[] _buttons = new Button[RowsPerPage + 2];
    private readonly string[] _fitText = new string[RowsPerPage + 2];
    private readonly float[] _fitWidth = new float[RowsPerPage + 2];
    private readonly RectTransform[] _lines = new RectTransform[RowsPerPage + 1];
    private readonly Vector3[] _corners = new Vector3[4];
    private readonly List<(string Label, Action Click)> _entries = new List<(string, Action)>();
    private readonly TMP_Text _status;
    private Vector2 _statusTextSize;
    private int _page;
    private string _kind;
    private string _mapId;
    private string _mapName;
    private string _revision;
    private bool _delete;
    private Action<SaveEntry> _play;
    private string _confirm;
    private enum View { List, Assign, Details, Rename, Name }
    private View _view;
    private SaveEntry _selected;
    private readonly TMP_InputField _input;
    private readonly TMP_FontAsset _font;
    public bool Visible => _panel.gameObject.activeSelf;

    public SavePicker(RectTransform frame, Button template)
    {
        _frame = frame;
        _canvas = (RectTransform)frame.GetComponentInParent<Canvas>().rootCanvas.transform;
        _panel = CreateFrame("RechargeSavePicker");
        _statusPanel = CreateFrame("RechargeSaveMessage");
        _statusPanel.GetComponent<Image>().raycastTarget = false;

        var font = template.GetComponentInChildren<TMP_Text>(true).font;
        _font = font;
        for (int i = 0; i < _buttons.Length; i++)
            _buttons[i] = CreateRow(template, i);
        for (int i = 0; i < _lines.Length; i++)
        {
            var line = PanelWidgets.CreateDivider(_panel, Vector2.zero, 0f, new Color(1f, 1f, 1f, 0.25f));
            line.layer = _panel.gameObject.layer;
            line.GetComponent<Image>().raycastTarget = false;
            _lines[i] = (RectTransform)line.transform;
        }
        _status = PanelWidgets.CreateLabel(_statusPanel, font, Vector2.zero, Vector2.zero, "", 16f, Color.white);
        _status.gameObject.layer = _statusPanel.gameObject.layer;
        _status.richText = false;
        _status.raycastTarget = false;
        _status.textWrappingMode = TextWrappingModes.Normal;
        _status.overflowMode = TextOverflowModes.Ellipsis;

        _input = PanelWidgets.CreateInputField(_panel, font, Vector2.zero, new Vector2(200f, 40f), "Save name", 20f);
        _input.gameObject.layer = _panel.gameObject.layer;
        _input.richText = false;
        _input.characterLimit = 48;
        _input.onSubmit.AddListener(_ => CommitInput());
        _input.gameObject.SetActive(false);
        Hide();
    }

    private Button CreateRow(Button template, int index)
    {
        // Level Select clones the same native button. Keep its material and
        // transition together so the text has the game's orange and hover tint.
        var row = UnityEngine.Object.Instantiate(template, _panel);
        var go = row.gameObject;
        go.name = "SaveRow" + index;
        go.layer = _panel.gameObject.layer;
        row.transform.localScale = Vector3.one;
        row.transform.localRotation = Quaternion.identity;
        row.navigation = new Navigation { mode = Navigation.Mode.Automatic };
        PauseMenuHelper.SetButtonAction(go, null);

        var text = row.GetComponentInChildren<TMP_Text>(true);
        var label = text.GetComponent<ModLabel>();
        if (label != null) UnityEngine.Object.DestroyImmediate(label); // the clone needs its own label owner
        text.gameObject.layer = go.layer;
        text.richText = false;
        text.fontSize = text.fontSizeMax = 22f;
        var rect = text.rectTransform;
        rect.localScale = Vector3.one;
        rect.anchorMin = Vector2.zero;
        rect.anchorMax = Vector2.one;
        rect.offsetMin = Vector2.zero;
        rect.offsetMax = Vector2.zero;
        PauseMenuHelper.SetButtonLabel(go, "");
        go.SetActive(true);
        return row;
    }

    private RectTransform CreateFrame(string name)
    {
        var panel = PanelWidgets.CreateContainer(_canvas, name, Vector2.zero);
        panel.gameObject.layer = _canvas.gameObject.layer;
        panel.anchorMin = panel.anchorMax = _canvas.pivot;
        panel.pivot = new Vector2(0f, 1f);
        var background = panel.gameObject.AddComponent<Image>();
        var image = _frame.GetComponent<Image>();
        background.sprite = image != null ? image.overrideSprite : PanelWidgets.FindPanelSprite(_frame, out _);
        background.color = image != null ? image.color : new Color(0.23f, 0.23f, 0.23f, 1f);
        if (background.sprite != null && background.sprite.border.sqrMagnitude > 0f) background.type = Image.Type.Sliced;
        return panel;
    }

    public void Open(string kind, string id, string name, string revision, bool delete, Action<SaveEntry> play)
    {
        _kind = kind;
        _mapId = id;
        _mapName = name;
        _revision = revision;
        _delete = delete;
        _play = play;
        _view = View.List;
        _selected = null;
        _confirm = null;
        _page = 0;
        _panel.SetAsLastSibling();
        _panel.gameObject.SetActive(true);
        Refresh();
        Layout();
    }

    public void Hide()
    {
        _panel.gameObject.SetActive(false);
        SetStatus(null);
    }

    public void Destroy()
    {
        UnityEngine.Object.Destroy(_panel.gameObject);
        UnityEngine.Object.Destroy(_statusPanel.gameObject);
    }

    private void Refresh(string status = null)
    {
        if (_view == View.Details) { RefreshDetails(); return; }
        if (_view == View.Rename || _view == View.Name) { RefreshInput(); return; }
        _input.gameObject.SetActive(false);
        _entries.Clear();
        var entries = SaveSlots.Library.Scan();
        var legacy = _kind == SaveLibrary.Custom ? SaveSlots.UnassignedLegacy(entries).ToArray() : Array.Empty<string>();
        var matches = entries.Where(e => e.Metadata?.Matches(_kind, _mapId) == true)
            .OrderByDescending(e => e.Metadata.Saved ?? e.Metadata.Created);
        if (_view == View.Assign)
        {
            foreach (var entry in entries.Where(e => e.Metadata == null))
                _entries.Add((entry.Label, () => Confirm("assign:" + entry.Path, "Assign " + entry.Label + " to " + _mapName + "?",
                    () => { SaveSlots.Library.Assign(entry, _kind, _mapId, _mapName, _revision); SwitchView(View.List); })));
            foreach (var path in legacy)
            {
                var name = System.IO.Path.GetFileName(path);
                _entries.Add(("Legacy " + name, () => Confirm("legacy:" + path, "Assign " + name + " to " + _mapName + "?",
                    () => { SaveSlots.ImportLegacy(path, _mapId, _mapName, _revision); SwitchView(View.List); })));
            }
        }
        else
        {
            foreach (var entry in matches)
            {
                if (_delete)
                    _entries.Add((entry.Label, () => Confirm("delete:" + entry.Metadata.Id, "Move " + entry.Label + " to recovery?",
                        () => { SaveSlots.Library.Archive(entry); Refresh("Moved to recovery."); })));
                else
                    _entries.Add((entry.Label, () => OpenDetails(entry)));
            }
            if (_view == View.List && !_delete)
            {
                if (_kind == SaveLibrary.Vanilla && SaveSlots.CanImportBaseGame)
                    _entries.Add(("Import Existing Save", () => { SaveSlots.ImportBaseGame(); Refresh("Imported an independent copy."); }));
                if (entries.Any(e => e.Metadata == null) || legacy.Length > 0)
                    _entries.Add(("Needs Import >", () => SwitchView(View.Assign)));
            }
        }

        var pages = Math.Max(1, (_entries.Count + RowsPerPage - 1) / RowsPerPage);
        _page = Math.Min(_page, pages - 1);
        if (_view == View.Assign) Bind(0, "Assign to " + _mapName, null);
        else if (_delete) Bind(0, "Delete " + _mapName, null);
        else Bind(0, "New Game", BeginName);
        for (int i = 0; i < RowsPerPage; i++)
        {
            var index = _page * RowsPerPage + i;
            if (index >= _entries.Count) Bind(i + 1, "", null);
            else Bind(i + 1, _entries[index].Label, _entries[index].Click);
        }
        Bind(RowsPerPage + 1, "Page " + (_page + 1) + " / " + pages + (pages > 1 ? " >" : ""), () =>
        {
            if (pages <= 1) return;
            _confirm = null;
            _page = (_page + 1) % pages;
            Refresh();
        });
        SetStatus(status ?? SaveSlots.Library.RecoveryMessage
            ?? (_entries.Count == 0 && _view == View.List ? "No saves for " + _mapName : null));
    }

    public void Back()
    {
        switch (_view)
        {
            case View.List: Hide(); Closed?.Invoke(); break;
            case View.Details: _selected = null; SwitchView(View.List); break;
            case View.Rename: SwitchView(View.Details); break;
            case View.Name: SwitchView(View.List); break;
            default: SwitchView(View.List); break; // Assign
        }
    }

    /// <summary>Called when Back closes the list itself, so the owner can return to the map list.</summary>
    public Action Closed;

    private void SwitchView(View view)
    {
        _view = view;
        _page = 0;
        _confirm = null;
        Refresh();
    }

    private void Continue(SaveEntry entry)
    {
        if (_revision != null && entry.Metadata.Revision != null && _revision != entry.Metadata.Revision)
            Confirm("play:" + entry.Metadata.Id, "Map version changed. Click again to continue.", () => _play(entry));
        else _play(entry);
    }

    private void OpenDetails(SaveEntry entry)
    {
        _selected = entry;
        _view = View.Details;
        _confirm = null;
        Refresh();
    }

    // The details view shows the save's stats in the message panel and its
    // actions in the rows, so Play/Rename/Delete all live behind one click.
    private void RefreshDetails()
    {
        _input.gameObject.SetActive(false);
        var e = _selected;
        Bind(0, e?.Label ?? "Save", null);
        Bind(1, "Play", e == null ? (Action)null : () => Continue(e));
        Bind(2, "Rename", e == null ? (Action)null : BeginRename);
        Bind(3, "Delete", e == null ? (Action)null : () => Confirm("delete:" + e.Metadata.Id,
            "Move " + e.Label + " to recovery?",
            () => { SaveSlots.Library.Archive(e); _selected = null; SwitchView(View.List); }));
        Bind(4, "< Back", () => { _selected = null; SwitchView(View.List); });
        Bind(5, "", null);
        Bind(6, "", null);
        Bind(RowsPerPage + 1, "", null);
        SetStatus(e == null ? null : string.Join("\n", SaveStats.Read(e)));
    }

    private void BeginName()
    {
        _selected = null;
        _input.text = "";
        _view = View.Name;
        _confirm = null;
        Refresh();
        _input.ActivateInputField();
    }

    private void BeginRename()
    {
        if (_selected == null) return;
        _input.text = _selected.Label;
        _view = View.Rename;
        _confirm = null;
        Refresh();
        _input.ActivateInputField();
    }

    // Shared by the rename and new-save-name views: a title, the input (placed
    // in Layout), a commit button and a cancel.
    private void RefreshInput()
    {
        bool rename = _view == View.Rename;
        Bind(0, rename ? "Rename save" : "New Game", null);
        Bind(1, "", null); // the input field overlays this row (positioned in Layout)
        Bind(2, "", null);
        Bind(3, rename ? "Save name" : "Create", CommitInput);
        Bind(4, "Cancel", () => SwitchView(rename ? View.Details : View.List));
        Bind(5, "", null);
        Bind(6, "", null);
        Bind(RowsPerPage + 1, "", null);
        _input.gameObject.SetActive(true);
        _input.transform.SetAsLastSibling();
        SetStatus(rename ? null : "Name it, or leave blank for a default.");
    }

    private void CommitInput()
    {
        var text = _input.text?.Trim() ?? "";
        try
        {
            if (_view == View.Rename)
            {
                if (_selected == null) { SwitchView(View.List); return; }
                if (!string.IsNullOrEmpty(text)) SaveSlots.Library.Rename(_selected, text);
                SwitchView(View.Details);
            }
            else if (_view == View.Name)
            {
                var entry = SaveSlots.Library.Create(_kind, _mapId, _mapName, _revision);
                if (!string.IsNullOrEmpty(text))
                {
                    // A fresh save has no player data, so undo it cleanly if the
                    // chosen name is taken or invalid and let the player retry.
                    try { SaveSlots.Library.Rename(entry, text); }
                    catch { try { SaveSlots.Library.Archive(entry); } catch { } throw; }
                }
                _play(entry);
            }
        }
        catch (Exception ex)
        {
            _confirm = null;
            SetStatus(ex.Message);
            Debug.LogWarning("[RechargeMaps] save name: " + ex.Message);
        }
    }

    private void Confirm(string key, string message, Action action)
    {
        if (_confirm != key) { _confirm = key; SetStatus(message); return; }
        _confirm = null;
        action();
    }

    private void Bind(int index, string label, Action click)
    {
        var button = _buttons[index];
        PauseMenuHelper.SetButtonLabel(button.gameObject, label);
        button.interactable = click != null;
        PauseMenuHelper.SetButtonAction(button.gameObject, click == null ? null : () =>
        {
            try { click(); }
            catch (Exception e)
            {
                _confirm = null;
                SetStatus(e.Message);
                Debug.LogWarning("[RechargeMaps] save picker: " + e.Message);
            }
        });
    }

    private void SetStatus(string message)
    {
        _status.text = message ?? "";
        _statusTextSize = Vector2.zero;
        bool show = Visible && !string.IsNullOrEmpty(message);
        _statusPanel.gameObject.SetActive(show);
        if (show) _statusPanel.SetAsLastSibling();
    }

    public void Layout()
    {
        if (!Visible) return;
        _frame.GetWorldCorners(_corners);
        var left = _canvas.InverseTransformPoint(_corners[0]);
        var right = _canvas.InverseTransformPoint(_corners[2]);
        var area = _canvas.rect;
        var height = Mathf.Min(right.y - left.y, area.height - 2 * Margin);
        var width = Mathf.Min(Mathf.Clamp(right.x - left.x, 176f, 320f), area.width - 2 * Margin);
        if (height <= 2 * Padding || width <= 2 * Padding) return;
        var x = Mathf.Clamp(right.x + Margin, area.xMin + Margin, area.xMax - Margin - width);
        var y = Mathf.Clamp(right.y, area.yMin + Margin + height, area.yMax - Margin);
        _panel.anchoredPosition = new Vector2(x, y);
        _panel.sizeDelta = new Vector2(width, height);
        var step = (height - 2 * Padding) / _buttons.Length;
        for (int i = 0; i < _buttons.Length; i++)
        {
            Place((RectTransform)_buttons[i].transform, width - 2 * Padding, step, Padding + (i + .5f) * step);
            FitRow(i);
        }
        for (int i = 0; i < _lines.Length; i++)
            Place(_lines[i], width * .84f, 2, Padding + (i + 1) * step);
        if (_input.gameObject.activeSelf)
            // Match the dividers' inset (width * .84) so the field sits inside the
            // panel's rounded border instead of overhanging it.
            Place((RectTransform)_input.transform, width * 0.84f, Mathf.Min(step * 0.9f, 44f), Padding + 1.5f * step);
        if (_statusPanel.gameObject.activeSelf) LayoutStatus(area, x + width + Margin, y, width, height);
    }

    private void FitRow(int index)
    {
        var label = _buttons[index] != null
            ? _buttons[index].transform.Find("Text (TMP)")?.GetComponent<TMP_Text>()
            : null;
        if (label == null) return;
        string text = label.text ?? "";
        float width = label.rectTransform.rect.width;
        if (_fitText[index] == text && _fitWidth[index] == width) return;
        _fitText[index] = text;
        _fitWidth[index] = width;
        PanelWidgets.FitLabel(label);
    }

    private void LayoutStatus(Rect area, float rightOfPicker, float top, float width, float pickerHeight)
    {
        var available = area.xMax - Margin - rightOfPicker;
        bool beside = available >= Mathf.Min(width, 176f);
        var messageWidth = beside ? Mathf.Min(width, available) : width;
        var textWidth = messageWidth - 2 * Padding;
        if (_statusTextSize.x != textWidth)
            _statusTextSize = new Vector2(textWidth, _status.GetPreferredValues(textWidth, float.PositiveInfinity).y);
        // The details view is a block of stats, so let it use the picker's full
        // height; transient feedback elsewhere stays to a third.
        var cap = _view == View.Details ? pickerHeight : Mathf.Max(4 * Padding, pickerHeight / 3);
        var maxHeight = Mathf.Min(pickerHeight, cap);
        var messageHeight = Mathf.Min(_statusTextSize.y + 4 * Padding, maxHeight);
        // On narrow windows the title has room for feedback above the map rows.
        var x = beside ? rightOfPicker : area.xMin + Margin;
        _statusPanel.anchoredPosition = new Vector2(x, top);
        _statusPanel.sizeDelta = new Vector2(messageWidth, messageHeight);
        Place(_status.rectTransform, textWidth, messageHeight - 2 * Padding, messageHeight * .5f);
    }

    private static void Place(RectTransform row, float width, float height, float down)
    {
        row.anchorMin = row.anchorMax = new Vector2(.5f, 1f);
        row.anchoredPosition = new Vector2(0, -down);
        row.sizeDelta = new Vector2(width, height);
    }
}

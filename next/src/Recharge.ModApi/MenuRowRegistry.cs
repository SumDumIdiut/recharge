using System;
using System.Collections.Generic;
using System.Linq;

namespace Recharge.ModApi
{
    /// <summary>
    /// The list of mod-contributed pause-menu rows (page 2+ of the pager).
    /// Purely data - knows nothing about how rows get drawn or paged.
    /// Session-wide (static): mods re-register on every scene load (a fresh
    /// pauseMenuScript needs its own copy rebuilt), so entries are keyed by
    /// a stable row name and upserted, never blindly appended.
    /// </summary>
    internal static class MenuRowRegistry
    {
        internal class Entry
        {
            public string RowName;
            public string Label;
            public Action OnClick;
            /// <summary>When set and false, the row is left out of the pager (re-checked every time the menu is shown).</summary>
            public Func<bool> Visible;
        }

        private static readonly List<Entry> _rows = new List<Entry>();

        public static IReadOnlyList<Entry> All => _rows;

        /// <summary>
        /// Rows of the parts Recharge integrates (Gun, Skinmod, DOTnet; their settings and lobbies live in the Recharge app, DOTnet's in-lobby controls on a key), so the in-game menu never lists them even though the
        /// mod's own code, which we don't rebuild, still registers them. Matched by the row name the mod passes to AddPanelRow/AddRow.
        /// </summary>
        private static readonly HashSet<string> IntegratedRows = new HashSet<string>(StringComparer.Ordinal) { "GunPanel", "CustomSkins", "Multiplayer" };

        /// <summary>The rows to show right now: those without a visibility test, or whose test passes.</summary>
        public static IReadOnlyList<Entry> Visible()
        {
            var list = new List<Entry>(_rows.Count);
            foreach (var r in _rows)
            {
                if (IntegratedRows.Contains(r.RowName)) continue;
                bool show;
                try { show = r.Visible == null || r.Visible(); } catch { show = false; }
                if (show) list.Add(r);
            }
            return list;
        }

        public static void Upsert(string rowName, string label, Action onClick, Func<bool> visible = null)
        {
            var existing = _rows.FirstOrDefault(r => r.RowName == rowName);
            if (existing != null) { existing.OnClick = onClick; existing.Label = label; existing.Visible = visible; return; }
            _rows.Add(new Entry { RowName = rowName, Label = label, OnClick = onClick, Visible = visible });
        }
    }
}

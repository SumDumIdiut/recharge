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
        }

        private static readonly List<Entry> _rows = new List<Entry>();

        public static IReadOnlyList<Entry> All => _rows;

        public static void Upsert(string rowName, string label, Action onClick)
        {
            var existing = _rows.FirstOrDefault(r => r.RowName == rowName);
            if (existing != null) { existing.OnClick = onClick; existing.Label = label; return; }
            _rows.Add(new Entry { RowName = rowName, Label = label, OnClick = onClick });
        }
    }
}

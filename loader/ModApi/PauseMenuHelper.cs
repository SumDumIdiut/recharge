using System;
using UnityEngine;

namespace Recharge.ModApi
{
    /// <summary>
    /// Public entry point for adding an entry to the real pause menu. Page 1
    /// is the untouched vanilla menu; every mod's entry lives on page 2+,
    /// sharing the same row slots. Hands off to <see cref="MenuRowRegistry"/>,
    /// <see cref="MenuPanelRegistry"/>, <see cref="MenuPager"/> and
    /// <see cref="MenuUiUtil"/> for each concern.
    /// </summary>
    public static class PauseMenuHelper
    {
        public static GameObject AddRow(pauseMenuScript menu, string rowName, string label, Action onClick)
        {
            if (!HasExpectedShape(menu)) return null;
            MenuRowRegistry.Upsert(rowName, label, onClick);
            return MenuPager.EnsureBuilt(menu);
        }

        public static GameObject AddPanelRow(pauseMenuScript menu, string rowName, string label)
        {
            if (!HasExpectedShape(menu)) return null;

            var panel = MenuPanelRegistry.GetOrCreate(menu, rowName, label);
            MenuRowRegistry.Upsert(rowName, label, () => panel.SetActive(true));
            MenuPager.EnsureBuilt(menu);
            return panel;
        }

        // Same blank-panel machinery as AddPanelRow, but without a
        // top-level pause-menu row - for a panel only reachable from a
        // button inside another mod panel. backTarget lets "Back"/Escape
        // return to a parent panel instead of the main pause menu.
        public static GameObject GetOrCreatePanel(pauseMenuScript menu, string rowName, string label, GameObject backTarget = null)
        {
            if (!HasExpectedShape(menu)) return null;
            return MenuPanelRegistry.GetOrCreate(menu, rowName, label, backTarget);
        }

        private static bool HasExpectedShape(pauseMenuScript menu) =>
            menu != null && MenuReflection.MainBit(menu) != null && MenuReflection.SettingsBit(menu) != null;

        public static void SetButtonLabel(GameObject buttonGo, string text) => MenuUiUtil.SetButtonLabel(buttonGo, text);
        public static void CopyButtonTextColor(GameObject sourceButtonGo, GameObject targetButtonGo) => MenuUiUtil.CopyButtonTextColor(sourceButtonGo, targetButtonGo);
        public static void ScaleButtonFontSize(GameObject buttonGo, float multiplier) => MenuUiUtil.ScaleButtonFontSize(buttonGo, multiplier);
        public static void SetButtonTextColor(GameObject buttonGo, Color color) => MenuUiUtil.SetButtonTextColor(buttonGo, color);

        /// <summary>
        /// A panel from AddPanelRow/GetOrCreatePanel drives its title/Close
        /// row through a Unity layout group, which silently reverts direct
        /// anchoredPosition changes on the next rebuild. Call this once
        /// before filling a panel with custom multi-page content: strips
        /// any LayoutGroup/ContentSizeFitter and recenters title/Close at
        /// the given Y offsets so they stay put afterward.
        /// </summary>
        public static void NormalizePanelLayout(GameObject panel, float titleY = 300f, float closeY = -300f) =>
            PanelLayoutHelper.NormalizePanelLayout(panel, titleY, closeY);

        /// <summary>
        /// Marks a UI element as ignored by any Unity layout group on its
        /// parent, so its position/size won't be recalculated or reverted by
        /// one. Useful for a sub-page container (or anything else) you want
        /// positioned by explicit anchoredPosition instead of participating
        /// in a parent's layout group.
        /// </summary>
        public static void IgnoreLayout(GameObject go) => PanelLayoutHelper.IgnoreLayout(go);
    }
}

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

        // Same blank-panel machinery as AddPanelRow (title, Back button,
        // Escape-to-close) but without also adding a top-level pause-menu
        // row - for a panel only reachable from a button inside another mod
        // panel. backTarget defaults to the main pause menu like
        // AddPanelRow, but can be a parent panel instead so "Back"/Escape
        // returns to it rather than skipping past it.
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
        /// A panel from AddPanelRow/GetOrCreatePanel is a clone of the
        /// vanilla Settings screen, which drives its title/Close row through
        /// an active Unity layout group - setting their anchoredPosition
        /// directly does nothing, since the group silently reverts it on the
        /// next layout rebuild (which fires as soon as you add more
        /// children). Call this once, right after creating a panel you plan
        /// to fill with custom multi-page or otherwise complex content: it
        /// strips any LayoutGroup/ContentSizeFitter found under the panel
        /// and recenters the title to top-center and Close to bottom-center
        /// at the given Y offsets, so both stay put no matter what you add
        /// afterward. Not needed for a simple single-page panel - the
        /// vanilla layout only causes visible problems once enough content
        /// triggers a rebuild that moves things you never touched.
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

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

        private static bool HasExpectedShape(pauseMenuScript menu) =>
            menu != null && MenuReflection.MainBit(menu) != null && MenuReflection.SettingsBit(menu) != null;

        public static void SetButtonLabel(GameObject buttonGo, string text) => MenuUiUtil.SetButtonLabel(buttonGo, text);
        public static void CopyButtonTextColor(GameObject sourceButtonGo, GameObject targetButtonGo) => MenuUiUtil.CopyButtonTextColor(sourceButtonGo, targetButtonGo);
        public static void ScaleButtonFontSize(GameObject buttonGo, float multiplier) => MenuUiUtil.ScaleButtonFontSize(buttonGo, multiplier);
        public static void SetButtonTextColor(GameObject buttonGo, Color color) => MenuUiUtil.SetButtonTextColor(buttonGo, color);
    }
}

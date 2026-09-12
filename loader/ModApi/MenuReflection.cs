using System.Reflection;
using UnityEngine;

namespace Recharge.ModApi
{
    /// <summary>
    /// Reflection access to pauseMenuScript's private mainBit/settingsBit
    /// fields - there's no public API for either, and every other piece of
    /// the pause-menu system needs at least one of them.
    /// </summary>
    internal static class MenuReflection
    {
        private static readonly FieldInfo MainBitField =
            typeof(pauseMenuScript).GetField("mainBit", BindingFlags.NonPublic | BindingFlags.Instance);
        private static readonly FieldInfo SettingsBitField =
            typeof(pauseMenuScript).GetField("settingsBit", BindingFlags.NonPublic | BindingFlags.Instance);

        public static GameObject MainBit(pauseMenuScript menu) => MainBitField?.GetValue(menu) as GameObject;
        public static GameObject SettingsBit(pauseMenuScript menu) => SettingsBitField?.GetValue(menu) as GameObject;
    }
}

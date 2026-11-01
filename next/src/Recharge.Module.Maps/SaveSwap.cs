using System;
using Recharge.Loader.Core.Maps;
using UnityEngine;

namespace Recharge.Module.Maps;

// The file side of map saves; the logic is Recharge.Loader.Core.Maps.SaveSwapCore, rooted at the persistent data path.
internal static class SaveSwap
{
    public const string Game = SaveSwapCore.Game;
    public const string GameBackup = SaveSwapCore.GameBackup;

    private static SaveSwapCore _core;
    private static SaveSwapCore Core => _core ??= new SaveSwapCore(Application.persistentDataPath,
        m => Debug.Log("[RechargeMaps] " + m), m => Debug.LogError("[RechargeMaps] " + m), m => Debug.LogWarning("[RechargeMaps] " + m));

    public static string Full(string folder) => Core.Full(folder);
    public static bool HasSave(string folder) => Core.HasSave(folder);
    public static bool IsSwapped => Core.IsSwapped;
    public static string Describe(string folder) => Core.Describe(folder);
    public static void SwapIn(string folder) => Core.SwapIn(folder);
    public static void SwapOut() => Core.SwapOut();
    public static void CopyFolder(string from, string to) => Core.CopyFolder(from, to);
    public static void DeleteFolder(string folder) => Core.DeleteFolder(folder);
}

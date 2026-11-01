using System;
using System.Diagnostics;

namespace Recharge.App.Bridge
{
    /// <summary>Opens a folder or an http(s) address with the desktop's default program: xdg-open on Linux, the shell on Windows.</summary>
    internal static class ShellOpen
    {
        internal static void Open(string target)
        {
            ProcessStartInfo info;
            if (OperatingSystem.IsWindows())
            {
                info = new ProcessStartInfo(target) { UseShellExecute = true };
            }
            else
            {
                info = new ProcessStartInfo("xdg-open") { UseShellExecute = false };
                info.ArgumentList.Add(target);
            }
            using Process? process = Process.Start(info);
            if (process is null && !OperatingSystem.IsWindows()) throw new InvalidOperationException("could not start xdg-open");
        }
    }
}

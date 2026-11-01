using System;
using System.Diagnostics;

namespace Recharge.App.Game
{
    /// <summary>Launches IGTAP through Steam: <c>steam -applaunch &lt;appid&gt;</c>, with RECHARGE_LINK in the environment of the steam process.</summary>
    public sealed class SteamGameLauncher : IGameLauncher
    {
        public void Launch(string gameDir, string appId, string linkEnvironmentValue)
        {
            // Steam starts the game itself, so the variable only reaches it when this call is what starts Steam; a running Steam
            // ignores it, and the game then reads the link file the session wrote next to it instead.
            var info = new ProcessStartInfo(OperatingSystem.IsWindows() ? WindowsSteamExe() : "steam") { UseShellExecute = false };
            info.ArgumentList.Add("-applaunch");
            info.ArgumentList.Add(appId);
            info.Environment[Recharge.Link.LinkClient.EnvironmentVariable] = linkEnvironmentValue;
            using Process? process = Process.Start(info);
            if (process is null) throw new InvalidOperationException("game: could not start steam");
        }

        /// <summary>Steam.exe from the install folder (registry, then the default location); plain "steam.exe" lets the PATH try.</summary>
        private static string WindowsSteamExe()
        {
            string? root = Recharge.App.Bridge.GameFinder.WindowsSteamRoot();
            string exe = root is null ? "" : System.IO.Path.Combine(root, "steam.exe");
            return System.IO.File.Exists(exe) ? exe : "steam.exe";
        }
    }
}

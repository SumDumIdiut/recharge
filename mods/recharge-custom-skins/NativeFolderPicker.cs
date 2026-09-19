using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace RechargeCustomSkins
{
    internal static class NativeFolderPicker
    {
        [DllImport("shell32.dll")]
        private static extern IntPtr SHBrowseForFolder(ref BROWSEINFO lpbi);

        [DllImport("shell32.dll")]
        private static extern bool SHGetPathFromIDList(IntPtr pidl, StringBuilder pszPath);

        [DllImport("ole32.dll")]
        private static extern void CoTaskMemFree(IntPtr pv);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        private struct BROWSEINFO
        {
            public IntPtr hwndOwner;
            public IntPtr pidlRoot;
            public IntPtr pszDisplayName;
            public string lpszTitle;
            public uint ulFlags;
            public IntPtr lpfn;
            public IntPtr lParam;
            public int iImage;
        }

        private const uint BIF_RETURNONLYFSDIRS = 0x0001;
        private const uint BIF_NEWDIALOGSTYLE = 0x0040;

        public static string PickFolder(string title)
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return PickFolderWindows(title);
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux)) return PickFolderLinux(title);
            if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX)) return PickFolderMac(title);
            return null;
        }

        private static string PickFolderWindows(string title)
        {
            var displayNameBuffer = Marshal.AllocHGlobal(520);
            try
            {
                var bi = new BROWSEINFO
                {
                    hwndOwner = IntPtr.Zero,
                    pidlRoot = IntPtr.Zero,
                    pszDisplayName = displayNameBuffer,
                    lpszTitle = title,
                    ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE,
                };
                var pidl = SHBrowseForFolder(ref bi);
                if (pidl == IntPtr.Zero) return null;
                try
                {
                    var path = new StringBuilder(260);
                    return SHGetPathFromIDList(pidl, path) ? path.ToString() : null;
                }
                finally
                {
                    CoTaskMemFree(pidl);
                }
            }
            catch (Exception)
            {
                return null;
            }
            finally
            {
                Marshal.FreeHGlobal(displayNameBuffer);
            }
        }

        private static string PickFolderLinux(string title)
        {
            var candidates = new (string exe, string args)[]
            {
                ("zenity", $"--file-selection --directory --title=\"{title}\""),
                ("kdialog", $"--getexistingdirectory --title \"{title}\""),
            };
            foreach (var (exe, args) in candidates)
            {
                var result = RunPickerProcess(exe, args);
                if (result != null) return result;
            }
            return null;
        }

        private static string PickFolderMac(string title)
        {
            var script = $"POSIX path of (choose folder with prompt \"{title}\")";
            return RunPickerProcess("osascript", $"-e '{script}'");
        }

        private static string RunPickerProcess(string exe, string args)
        {
            try
            {
                var psi = new ProcessStartInfo(exe, args)
                {
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                using var proc = Process.Start(psi);
                if (proc == null) return null;
                string output = proc.StandardOutput.ReadToEnd().Trim();
                proc.WaitForExit();
                return proc.ExitCode == 0 && output.Length > 0 ? output : null;
            }
            catch (System.ComponentModel.Win32Exception)
            {
                return null;
            }
        }
    }
}

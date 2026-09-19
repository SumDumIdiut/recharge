using System;
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
    }
}

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Recharge.App.Settings;

namespace Recharge.App.Windows
{
    /// <summary>The common "Open" dialog (GetOpenFileNameW) for the Windows shell, behind the same FilePicker front as the GTK one.</summary>
    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    internal static class WindowsFilePicker
    {
        private const uint OFN_ALLOWMULTISELECT = 0x200, OFN_EXPLORER = 0x80000, OFN_FILEMUSTEXIST = 0x1000, OFN_PATHMUSTEXIST = 0x800, OFN_NOCHANGEDIR = 0x8;
        private const int BufferChars = 32768;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct OPENFILENAME
        {
            public int lStructSize;
            public IntPtr hwndOwner, hInstance;
            public string? lpstrFilter, lpstrCustomFilter;
            public int nMaxCustFilter, nFilterIndex;
            public IntPtr lpstrFile;
            public int nMaxFile;
            public string? lpstrFileTitle;
            public int nMaxFileTitle;
            public string? lpstrInitialDir, lpstrTitle;
            public uint Flags;
            public ushort nFileOffset, nFileExtension;
            public string? lpstrDefExt;
            public IntPtr lCustData, lpfnHook;
            public string? lpTemplateName;
            public IntPtr pvReserved;
            public int dwReserved, FlagsEx;
        }

        [DllImport("comdlg32.dll", CharSet = CharSet.Unicode)]
        private static extern bool GetOpenFileNameW(ref OPENFILENAME ofn);

        /// <summary>The dialog's filter string: "Name\0*.a;*.b\0...\0\0".</summary>
        internal static string FilterString(IReadOnlyList<PickFilter> filters)
        {
            var sb = new StringBuilder();
            foreach (PickFilter f in filters)
            {
                var masks = new List<string>();
                foreach (string ext in f.Extensions)
                {
                    string clean = ext.TrimStart('.', '*');
                    if (clean.Length > 0) masks.Add("*." + clean);
                }
                if (masks.Count == 0) continue;
                sb.Append(f.Name).Append('\0').Append(string.Join(';', masks)).Append('\0');
            }
            sb.Append("All files\0*.*\0\0");
            return sb.ToString();
        }

        /// <summary>The paths in a multi-select buffer: "dir\0a\0b\0\0", or one full path when a single file was chosen.</summary>
        internal static string[] ParseResult(string[] parts)
        {
            if (parts.Length == 0) return Array.Empty<string>();
            if (parts.Length == 1) return new[] { parts[0] };
            var list = new List<string>();
            for (int i = 1; i < parts.Length; i++) list.Add(System.IO.Path.Combine(parts[0], parts[i]));
            return list.ToArray();
        }

        public static Task<string[]> PickAsync(string title, IReadOnlyList<PickFilter> filters, bool multiple)
        {
            var done = new TaskCompletionSource<string[]>(TaskCreationOptions.RunContinuationsAsynchronously);
            var thread = new Thread(() =>
            {
                IntPtr buffer = Marshal.AllocHGlobal(BufferChars * 2);
                try
                {
                    Marshal.WriteInt16(buffer, 0);
                    var ofn = new OPENFILENAME
                    {
                        lStructSize = Marshal.SizeOf<OPENFILENAME>(),
                        lpstrFilter = FilterString(filters),
                        nFilterIndex = 1,
                        lpstrFile = buffer,
                        nMaxFile = BufferChars,
                        lpstrTitle = title,
                        Flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | (multiple ? OFN_ALLOWMULTISELECT : 0),
                    };
                    if (!GetOpenFileNameW(ref ofn)) { done.TrySetResult(Array.Empty<string>()); return; }
                    var parts = new List<string>();
                    int offset = 0;
                    while (offset < BufferChars)
                    {
                        string? part = Marshal.PtrToStringUni(buffer + offset * 2);
                        if (string.IsNullOrEmpty(part)) break;
                        parts.Add(part);
                        offset += part.Length + 1;
                    }
                    done.TrySetResult(ParseResult(parts.ToArray()));
                }
                catch (Exception e) { done.TrySetException(e); }
                finally { Marshal.FreeHGlobal(buffer); }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.IsBackground = true;
            thread.Start();
            return done.Task;
        }
    }
}

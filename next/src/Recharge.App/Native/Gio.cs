using System;
using System.Runtime.InteropServices;

namespace Recharge.App.Native
{
    /// <summary>Gio symbols used by the shell.</summary>
    internal static class Gio
    {
        internal const string Lib = "libgio-2.0.so.0";

        [DllImport(Lib)]
        internal static extern IntPtr g_memory_input_stream_new_from_bytes(IntPtr bytes);

        [DllImport(Lib)]
        internal static extern IntPtr g_file_new_for_path([MarshalAs(UnmanagedType.LPUTF8Str)] string path);

        [DllImport(Lib)]
        internal static extern IntPtr g_file_read(IntPtr file, IntPtr cancellable, IntPtr error);
    }
}

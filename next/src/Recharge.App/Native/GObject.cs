using System;
using System.Runtime.InteropServices;

namespace Recharge.App.Native
{
    /// <summary>GObject symbols used by the shell.</summary>
    internal static class GObject
    {
        internal const string Lib = "libgobject-2.0.so.0";

        [DllImport(Lib)]
        internal static extern void g_object_unref(IntPtr instance);

        [DllImport(Lib)]
        internal static extern ulong g_signal_connect_data(
            IntPtr instance,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string detailedSignal,
            IntPtr handler,
            IntPtr data,
            IntPtr destroyData,
            int connectFlags);
    }
}

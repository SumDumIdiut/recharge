using System;
using System.Runtime.InteropServices;

namespace Recharge.App.Native
{
    /// <summary>GLib symbols used by the shell.</summary>
    internal static class GLib
    {
        internal const string Lib = "libglib-2.0.so.0";

        [DllImport(Lib)]
        internal static extern void g_free(IntPtr memory);

        [DllImport(Lib)]
        internal static extern uint g_idle_add(GSourceFunc function, IntPtr data);

        [DllImport(Lib)]
        internal static extern uint g_timeout_add(uint interval, GSourceFunc function, IntPtr data);

        [DllImport(Lib)]
        internal static extern uint g_quark_from_static_string(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string value);

        [DllImport(Lib)]
        internal static extern IntPtr g_error_new_literal(
            uint domain,
            int code,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string message);

        [DllImport(Lib)]
        internal static extern void g_error_free(IntPtr error);

        [DllImport(Lib)]
        internal static extern IntPtr g_bytes_new(byte[] data, nuint size);

        [DllImport(Lib)]
        internal static extern void g_bytes_unref(IntPtr bytes);
    }
}

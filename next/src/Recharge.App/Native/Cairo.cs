using System;
using System.Runtime.InteropServices;

namespace Recharge.App.Native
{
    /// <summary>Cairo symbols used by snapshot mode.</summary>
    internal static class Cairo
    {
        internal const string Lib = "libcairo.so.2";

        [DllImport(Lib)]
        internal static extern int cairo_surface_write_to_png(
            IntPtr surface,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string filename);

        [DllImport(Lib)]
        internal static extern void cairo_surface_destroy(IntPtr surface);
    }
}

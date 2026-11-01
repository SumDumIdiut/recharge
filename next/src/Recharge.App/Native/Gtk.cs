using System;
using System.Runtime.InteropServices;

namespace Recharge.App.Native
{
    /// <summary>GTK 3 symbols used by the shell.</summary>
    internal static class Gtk
    {
        internal const string Lib = "libgtk-3.so.0";

        [DllImport(Lib)]
        internal static extern void gtk_init(IntPtr argc, IntPtr argv);

        [DllImport(Lib)]
        internal static extern IntPtr gtk_window_new(int type);

        [DllImport(Lib)]
        internal static extern void gtk_window_set_title(
            IntPtr window,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string title);

        [DllImport(Lib)]
        internal static extern void gtk_window_set_default_size(IntPtr window, int width, int height);

        [DllImport(Lib)]
        internal static extern void gtk_widget_set_size_request(IntPtr widget, int width, int height);

        [DllImport(Lib)]
        internal static extern int gtk_window_set_icon_from_file(
            IntPtr window,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string filename,
            IntPtr error);

        [DllImport(Lib)]
        internal static extern void gtk_container_add(IntPtr container, IntPtr widget);

        [DllImport(Lib)]
        internal static extern void gtk_widget_show_all(IntPtr widget);

        [DllImport(Lib)]
        internal static extern void gtk_main();

        [DllImport(Lib)]
        internal static extern void gtk_main_quit();
    }
}

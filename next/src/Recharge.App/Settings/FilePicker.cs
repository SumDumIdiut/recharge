using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Recharge.App.Native;

namespace Recharge.App.Settings
{
    /// <summary>A GTK "open a file" chooser (GtkFileChooserNative, so it uses the desktop portal when there is one), limited to pictures and videos.</summary>
    internal static class FilePicker
    {
        private const string GtkLib = "libgtk-3.so.0";
        private const int ActionOpen = 0;
        private const int ResponseAccept = -3;

        [DllImport(GtkLib)]
        private static extern IntPtr gtk_file_chooser_native_new(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string title, IntPtr parent, int action,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string? acceptLabel, [MarshalAs(UnmanagedType.LPUTF8Str)] string? cancelLabel);

        [DllImport(GtkLib)]
        private static extern int gtk_native_dialog_run(IntPtr dialog);

        [DllImport(GtkLib)]
        private static extern void gtk_native_dialog_destroy(IntPtr dialog);

        [DllImport(GtkLib)]
        private static extern IntPtr gtk_file_chooser_get_filename(IntPtr chooser);

        [DllImport(GtkLib)]
        private static extern IntPtr gtk_file_filter_new();

        [DllImport(GtkLib)]
        private static extern void gtk_file_filter_set_name(IntPtr filter, [MarshalAs(UnmanagedType.LPUTF8Str)] string name);

        [DllImport(GtkLib)]
        private static extern void gtk_file_filter_add_pattern(IntPtr filter, [MarshalAs(UnmanagedType.LPUTF8Str)] string pattern);

        [DllImport(GtkLib)]
        private static extern void gtk_file_chooser_add_filter(IntPtr chooser, IntPtr filter);

        private static readonly GSourceFunc RunOnMain = OnMain;

        private sealed class Request
        {
            public string Title = "";
            public TaskCompletionSource<string?> Done = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        /// <summary>Shows the chooser on the GTK main thread; completes with the chosen file, or null when cancelled.</summary>
        public static Task<string?> PickMediaAsync(string title)
        {
            var request = new Request { Title = title };
            GCHandle handle = GCHandle.Alloc(request);
            if (GLib.g_idle_add(RunOnMain, GCHandle.ToIntPtr(handle)) == 0)
            {
                handle.Free();
                request.Done.TrySetException(new InvalidOperationException("could not open the file chooser"));
            }
            return request.Done.Task;
        }

        private static int OnMain(IntPtr data)
        {
            GCHandle handle = GCHandle.FromIntPtr(data);
            var request = (Request)handle.Target!;
            handle.Free();
            try
            {
                IntPtr dialog = gtk_file_chooser_native_new(request.Title, IntPtr.Zero, ActionOpen, "Add", "Cancel");
                if (dialog == IntPtr.Zero) throw new InvalidOperationException("the file chooser isn't available");
                try
                {
                    IntPtr filter = gtk_file_filter_new();
                    gtk_file_filter_set_name(filter, "Pictures and videos");
                    foreach (string ext in new[] { "png", "jpg", "jpeg", "webp", "gif", "mp4", "webm" })
                    {
                        gtk_file_filter_add_pattern(filter, "*." + ext);
                        gtk_file_filter_add_pattern(filter, "*." + ext.ToUpperInvariant());
                    }
                    gtk_file_chooser_add_filter(dialog, filter);
                    string? chosen = null;
                    if (gtk_native_dialog_run(dialog) == ResponseAccept)
                    {
                        IntPtr name = gtk_file_chooser_get_filename(dialog);
                        if (name != IntPtr.Zero)
                        {
                            chosen = Marshal.PtrToStringUTF8(name);
                            GLib.g_free(name);
                        }
                    }
                    request.Done.TrySetResult(chosen);
                }
                finally
                {
                    gtk_native_dialog_destroy(dialog);
                    GObject.g_object_unref(dialog);
                }
            }
            catch (Exception e)
            {
                request.Done.TrySetException(e);
            }
            return 0;
        }
    }
}

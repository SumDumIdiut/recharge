using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Recharge.App.Native;

namespace Recharge.App.Settings
{
    /// <summary>A GTK folder chooser (GtkFileChooserNative, so it uses the desktop portal when there is one).</summary>
    internal static class FolderPicker
    {
        private const string GtkLib = "libgtk-3.so.0";
        private const int ActionSelectFolder = 2;
        private const int ResponseAccept = -3;

        [DllImport(GtkLib)]
        private static extern IntPtr gtk_file_chooser_native_new(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string title,
            IntPtr parent,
            int action,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string? acceptLabel,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string? cancelLabel);

        [DllImport(GtkLib)]
        private static extern int gtk_native_dialog_run(IntPtr dialog);

        [DllImport(GtkLib)]
        private static extern void gtk_native_dialog_destroy(IntPtr dialog);

        [DllImport(GtkLib)]
        private static extern IntPtr gtk_file_chooser_get_filename(IntPtr chooser);

        [DllImport(GtkLib)]
        private static extern int gtk_file_chooser_set_filename(IntPtr chooser, [MarshalAs(UnmanagedType.LPUTF8Str)] string name);

        private static readonly GSourceFunc RunOnMain = OnMain;

        private sealed class Request
        {
            public string Title = "";
            public string? Start;
            public TaskCompletionSource<string?> Done = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        /// <summary>Shows the chooser on the GTK main thread; completes with the chosen folder, or null when cancelled.</summary>
        public static Task<string?> PickAsync(string title, string? startFolder)
        {
            var request = new Request { Title = title, Start = startFolder };
            GCHandle handle = GCHandle.Alloc(request);
            if (GLib.g_idle_add(RunOnMain, GCHandle.ToIntPtr(handle)) == 0)
            {
                handle.Free();
                request.Done.TrySetException(new InvalidOperationException("could not open the folder chooser"));
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
                IntPtr dialog = gtk_file_chooser_native_new(request.Title, IntPtr.Zero, ActionSelectFolder, "Choose", "Cancel");
                if (dialog == IntPtr.Zero) throw new InvalidOperationException("the folder chooser isn't available");
                try
                {
                    if (!string.IsNullOrEmpty(request.Start)) gtk_file_chooser_set_filename(dialog, request.Start);
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

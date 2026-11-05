using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Recharge.App.Native;

namespace Recharge.App.Settings
{
    /// <summary>One filter of the chooser: a label and the extensions (no dot) it lets through.</summary>
    internal sealed record PickFilter(string Name, string[] Extensions);

    /// <summary>
    /// An "open a file" chooser: GTK (GtkFileChooserNative, so it uses the desktop portal when there is one) on Linux, the common
    /// Windows dialog on Windows. Shared by backgrounds.pickFile and files.pick.
    /// </summary>
    internal static class FilePicker
    {
        public static readonly PickFilter[] MediaFilters = { new PickFilter("Pictures and videos", new[] { "png", "jpg", "jpeg", "webp", "gif", "mp4", "webm" }) };

        /// <summary>The extensions to match, in both cases (GTK patterns are case-sensitive).</summary>
        public static IEnumerable<string> Patterns(PickFilter filter)
        {
            foreach (string ext in filter.Extensions)
            {
                string clean = ext.TrimStart('.', '*');
                if (clean.Length == 0) continue;
                yield return "*." + clean;
                yield return "*." + clean.ToUpperInvariant();
            }
        }

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
        private static extern IntPtr gtk_file_filter_new();

        [DllImport(GtkLib)]
        private static extern void gtk_file_filter_set_name(IntPtr filter, [MarshalAs(UnmanagedType.LPUTF8Str)] string name);

        [DllImport(GtkLib)]
        private static extern void gtk_file_filter_add_pattern(IntPtr filter, [MarshalAs(UnmanagedType.LPUTF8Str)] string pattern);

        [DllImport(GtkLib)]
        private static extern void gtk_file_chooser_add_filter(IntPtr chooser, IntPtr filter);

        [DllImport(GtkLib)]
        private static extern void gtk_file_chooser_set_select_multiple(IntPtr chooser, int multiple);

        [DllImport(GtkLib)]
        private static extern IntPtr gtk_file_chooser_get_filenames(IntPtr chooser);

        [DllImport("libglib-2.0.so.0")]
        private static extern void g_slist_free(IntPtr list);

        private static readonly GSourceFunc RunOnMain = OnMain;

        private sealed class Request
        {
            public string Title = "";
            public IReadOnlyList<PickFilter> Filters = Array.Empty<PickFilter>();
            public bool Multiple;
            public TaskCompletionSource<string[]> Done = new TaskCompletionSource<string[]>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        /// <summary>Shows the chooser for one picture or video; completes with the chosen file, or null when cancelled.</summary>
        public static async Task<string?> PickMediaAsync(string title)
        {
            string[] chosen = await PickAsync(title, MediaFilters, false).ConfigureAwait(false);
            return chosen.Length > 0 ? chosen[0] : null;
        }

        /// <summary>Shows the chooser; completes with the chosen files (empty when cancelled).</summary>
        public static Task<string[]> PickAsync(string title, IReadOnlyList<PickFilter> filters, bool multiple)
        {
            if (OperatingSystem.IsWindows()) return Windows.WindowsFilePicker.PickAsync(title, filters, multiple);
            var request = new Request { Title = title, Filters = filters, Multiple = multiple };
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
                    foreach (PickFilter pick in request.Filters)
                    {
                        IntPtr filter = gtk_file_filter_new();
                        gtk_file_filter_set_name(filter, pick.Name);
                        foreach (string pattern in Patterns(pick)) gtk_file_filter_add_pattern(filter, pattern);
                        gtk_file_chooser_add_filter(dialog, filter);
                    }
                    if (request.Multiple) gtk_file_chooser_set_select_multiple(dialog, 1);
                    var chosen = new List<string>();
                    if (gtk_native_dialog_run(dialog) == ResponseAccept)
                    {
                        // a GSList of g_malloc'd paths: { void* data; GSList* next; }
                        IntPtr list = gtk_file_chooser_get_filenames(dialog);
                        for (IntPtr node = list; node != IntPtr.Zero; node = Marshal.ReadIntPtr(node, IntPtr.Size))
                        {
                            IntPtr name = Marshal.ReadIntPtr(node);
                            if (name == IntPtr.Zero) continue;
                            string? path = Marshal.PtrToStringUTF8(name);
                            if (!string.IsNullOrEmpty(path)) chosen.Add(path);
                            GLib.g_free(name);
                        }
                        if (list != IntPtr.Zero) g_slist_free(list);
                    }
                    request.Done.TrySetResult(chosen.ToArray());
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

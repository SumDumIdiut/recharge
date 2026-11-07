using System;
using System.IO;
using System.Runtime.InteropServices;
using Recharge.App.Native;

namespace Recharge.App
{
    /// <summary>Waits for the page to be ready, then writes a PNG of the WebView. Dev only: an --eval-js
    /// script runs first and its document.title is printed, so a snapshot run can report DOM state.</summary>
    internal sealed class SnapshotController
    {
        private static readonly GSourceFunc TimeoutCallback = OnTimeout;
        private static readonly GSourceFunc DelayCallback = OnDelay;
        private static readonly GSourceFunc CaptureCallback = OnCapture;
        private static readonly GAsyncReadyCallback SnapshotReadyCallback = OnSnapshotReady;
        private static readonly GAsyncReadyCallback EvalReadyCallback = OnEvalReady;

        private readonly string _outputPath;
        private readonly int _timeoutMilliseconds;
        private readonly string _evalJs;
        private IntPtr _view;
        private bool _ready;
        private bool _started;
        private bool _wasReady;

        internal SnapshotController(string outputPath, int timeoutSeconds, string evalJs = "")
        {
            _outputPath = outputPath;
            _timeoutMilliseconds = checked(timeoutSeconds * 1000);
            _evalJs = evalJs;
        }

        internal int ExitCode { get; private set; }

        internal void Start(IntPtr view)
        {
            _view = view;
            GCHandle handle = GCHandle.Alloc(this);
            uint source = GLib.g_timeout_add((uint)_timeoutMilliseconds, TimeoutCallback, GCHandle.ToIntPtr(handle));
            if (source == 0)
            {
                handle.Free();
            }
        }

        internal void NotifyReady()
        {
            if (_ready || _started)
            {
                return;
            }
            _ready = true;

            GCHandle handle = GCHandle.Alloc(this);
            uint source = GLib.g_timeout_add(300, DelayCallback, GCHandle.ToIntPtr(handle));
            if (source == 0)
            {
                handle.Free();
            }
        }

        private static int OnTimeout(IntPtr data)
        {
            GCHandle handle = GCHandle.FromIntPtr(data);
            var controller = (SnapshotController?)handle.Target;
            handle.Free();
            if (controller is not null && !controller._started)
            {
                controller._wasReady = false;
                controller.TakeSnapshot();
            }
            return 0;
        }

        private static int OnDelay(IntPtr data)
        {
            GCHandle handle = GCHandle.FromIntPtr(data);
            var controller = (SnapshotController?)handle.Target;
            handle.Free();
            if (controller is null)
            {
                return 0;
            }
            if (controller._started)
            {
                return 0;
            }
            controller._wasReady = true;
            if (controller._evalJs.Length > 0)
            {
                controller.RunEval();
            }
            else
            {
                controller.TakeSnapshot();
            }
            return 0;
        }

        /// <summary>Runs the --eval-js script in the page; the result callback prints its document.title, then the snapshot is taken.</summary>
        private void RunEval()
        {
            GCHandle handle = GCHandle.Alloc(this);
            WebKit.webkit_web_view_evaluate_javascript(
                _view,
                _evalJs,
                (nint)(-1),
                IntPtr.Zero,
                IntPtr.Zero,
                IntPtr.Zero,
                EvalReadyCallback,
                GCHandle.ToIntPtr(handle));
        }

        private static void OnEvalReady(IntPtr sourceObject, IntPtr result, IntPtr data)
        {
            GCHandle handle = GCHandle.FromIntPtr(data);
            var controller = (SnapshotController?)handle.Target;
            handle.Free();
            if (controller is null)
            {
                return;
            }
            WebKit.webkit_web_view_evaluate_javascript_finish(sourceObject, result, IntPtr.Zero);
            // the title property settles just after the script returns
            GCHandle again = GCHandle.Alloc(controller);
            GLib.g_timeout_add(400, CaptureCallback, GCHandle.ToIntPtr(again));
        }

        private static int OnCapture(IntPtr data)
        {
            GCHandle handle = GCHandle.FromIntPtr(data);
            var controller = (SnapshotController?)handle.Target;
            handle.Free();
            if (controller is not null)
            {
                Console.WriteLine("eval: " + WebKit.WebViewTitle(controller._view));
                controller.TakeSnapshot();
            }
            return 0; // once
        }

        private void TakeSnapshot()
        {
            _started = true;
            GCHandle handle = GCHandle.Alloc(this);
            WebKit.webkit_web_view_get_snapshot(
                _view,
                WebKit.SnapshotRegionVisible,
                WebKit.SnapshotOptionsNone,
                IntPtr.Zero,
                SnapshotReadyCallback,
                GCHandle.ToIntPtr(handle));
        }

        private static void OnSnapshotReady(IntPtr sourceObject, IntPtr result, IntPtr data)
        {
            GCHandle handle = GCHandle.FromIntPtr(data);
            var controller = (SnapshotController?)handle.Target;
            handle.Free();
            if (controller is null)
            {
                return;
            }

            IntPtr surface = WebKit.webkit_web_view_get_snapshot_finish(sourceObject, result, IntPtr.Zero);
            if (surface == IntPtr.Zero)
            {
                Console.Error.WriteLine("snapshot failed: WebKit returned no surface");
                controller.ExitCode = 4;
                Gtk.gtk_main_quit();
                return;
            }

            int status;
            try
            {
                string? directory = Path.GetDirectoryName(controller._outputPath);
                if (!string.IsNullOrEmpty(directory))
                {
                    Directory.CreateDirectory(directory);
                }
                status = Cairo.cairo_surface_write_to_png(surface, controller._outputPath);
            }
            finally
            {
                Cairo.cairo_surface_destroy(surface);
            }

            if (status != 0)
            {
                Console.Error.WriteLine("snapshot failed: could not write " + controller._outputPath);
                controller.ExitCode = 4;
                Gtk.gtk_main_quit();
                return;
            }

            Console.WriteLine(
                (controller._wasReady ? "snapshot: " : "snapshot (not ready): ") +
                controller._outputPath);
            controller.ExitCode = controller._wasReady ? 0 : 3;
            Gtk.gtk_main_quit();
        }
    }
}

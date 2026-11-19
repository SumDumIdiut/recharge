using System;
using System.IO;
using System.Runtime.InteropServices;
using Recharge.App.Bridge;
using Recharge.App.Native;
using Recharge.App.Scheme;

namespace Recharge.App
{
    /// <summary>Creates the GTK window and its WebKit view.</summary>
    internal sealed class AppShell
    {
        private static readonly GtkDestroyCallback DestroyCallback = OnDestroy;
        private static readonly WebKitPermissionRequestCallback PermissionCallback = OnPermissionRequest;

        private AppShell(IntPtr window, IntPtr view, BridgeHost bridge)
        {
            Window = window;
            View = view;
            Bridge = bridge;
        }

        internal IntPtr Window { get; }
        internal IntPtr View { get; }
        internal BridgeHost Bridge { get; }

        internal static AppShell Create(AppOptions options)
        {
            string uiRoot = Path.Combine(AppContext.BaseDirectory, "ui");
            string icon = Path.Combine(AppContext.BaseDirectory, "icon.png");

            IntPtr window = Gtk.gtk_window_new(0); // GTK_WINDOW_TOPLEVEL
            Gtk.gtk_window_set_title(window, "Recharge");
            Gtk.gtk_window_set_default_size(window, options.Width, options.Height);
            Gtk.gtk_widget_set_size_request(window, 960, 600);
            if (File.Exists(icon))
            {
                Gtk.gtk_window_set_icon_from_file(window, icon, IntPtr.Zero);
            }

            GObject.g_signal_connect_data(
                window,
                "destroy",
                Marshal.GetFunctionPointerForDelegate(DestroyCallback),
                IntPtr.Zero,
                IntPtr.Zero,
                0);

            UiSchemeHandler.Register(uiRoot);

            IntPtr userContentManager = WebKit.webkit_user_content_manager_new();
            IntPtr view = WebKit.webkit_web_view_new_with_user_content_manager(userContentManager);

            // The first-party UI asks for the mic/camera for voice calls; grant those permission requests.
            GObject.g_signal_connect_data(
                view,
                "permission-request",
                Marshal.GetFunctionPointerForDelegate(PermissionCallback),
                IntPtr.Zero,
                IntPtr.Zero,
                0);

            IntPtr settings = WebKit.webkit_web_view_get_settings(view);
            WebKit.webkit_settings_set_enable_smooth_scrolling(settings, 1);
            WebKit.webkit_settings_set_enable_media_stream(settings, 1);
            WebKit.webkit_settings_set_enable_webrtc(settings, 1);
            WebKit.webkit_settings_set_enable_developer_extras(
                settings,
                Environment.GetEnvironmentVariable("RECHARGE_DEVTOOLS") == "1" ? 1 : 0);

            var background = new GdkRgba
            {
                Red = 0x11 / 255.0,
                Green = 0x11 / 255.0,
                Blue = 0x11 / 255.0,
                Alpha = 1.0,
            };
            WebKit.webkit_web_view_set_background_color(view, ref background);

            var bridge = new BridgeHost(view, options.EvalLog);
            bridge.Attach(userContentManager);

            Gtk.gtk_container_add(window, view);
            Gtk.gtk_widget_show_all(window);

            return new AppShell(window, view, bridge);
        }

        internal void Load(string uri) => WebKit.webkit_web_view_load_uri(View, uri);

        private static void OnDestroy(IntPtr widget, IntPtr userData) => Gtk.gtk_main_quit();

        // The WebView hosts only our own UI, which requests the mic/camera for voice calls — grant it.
        private static int OnPermissionRequest(IntPtr webView, IntPtr request, IntPtr userData)
        {
            WebKit.webkit_permission_request_allow(request);
            return 1; // TRUE: request handled
        }
    }
}

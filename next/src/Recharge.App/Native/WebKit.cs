using System;
using System.Runtime.InteropServices;

namespace Recharge.App.Native
{
    /// <summary>WebKitGTK 4.1 symbols used by the shell.</summary>
    internal static class WebKit
    {
        internal const string Lib = "libwebkit2gtk-4.1.so.0";

        internal const int SnapshotRegionVisible = 0;
        internal const int SnapshotOptionsNone = 0;

        internal const int UserContentInjectTopFrame = 1;
        internal const int UserScriptInjectAtDocumentStart = 0;

        [DllImport(Lib)]
        internal static extern IntPtr webkit_web_context_get_default();

        [DllImport(Lib)]
        internal static extern IntPtr webkit_web_context_get_security_manager(IntPtr context);

        [DllImport(Lib)]
        internal static extern void webkit_security_manager_register_uri_scheme_as_secure(
            IntPtr securityManager,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string scheme);

        [DllImport(Lib)]
        internal static extern void webkit_security_manager_register_uri_scheme_as_cors_enabled(
            IntPtr securityManager,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string scheme);

        [DllImport(Lib)]
        internal static extern void webkit_web_context_register_uri_scheme(
            IntPtr context,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string scheme,
            WebKitUriSchemeRequestCallback callback,
            IntPtr userData,
            IntPtr destroyNotify);

        [DllImport(Lib)]
        internal static extern IntPtr webkit_user_content_manager_new();

        [DllImport(Lib)]
        internal static extern IntPtr webkit_user_script_new(
            [MarshalAs(UnmanagedType.LPUTF8Str)] string source,
            int injectedFrames,
            int injectionTime,
            IntPtr allowList,
            IntPtr blockList);

        [DllImport(Lib)]
        internal static extern void webkit_user_content_manager_add_script(
            IntPtr manager,
            IntPtr script);

        [DllImport(Lib)]
        internal static extern void webkit_user_script_unref(IntPtr script);

        [DllImport(Lib)]
        internal static extern int webkit_user_content_manager_register_script_message_handler(
            IntPtr manager,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string name);

        [DllImport(Lib)]
        internal static extern IntPtr webkit_web_view_new_with_user_content_manager(IntPtr manager);

        [DllImport(Lib)]
        internal static extern IntPtr webkit_web_view_get_settings(IntPtr view);

        [DllImport(Lib)]
        internal static extern void webkit_settings_set_enable_smooth_scrolling(
            IntPtr settings,
            int enabled);

        [DllImport(Lib)]
        internal static extern void webkit_settings_set_enable_developer_extras(
            IntPtr settings,
            int enabled);

        [DllImport(Lib)]
        internal static extern void webkit_web_view_set_background_color(
            IntPtr view,
            ref GdkRgba color);

        [DllImport(Lib)]
        internal static extern void webkit_web_view_load_uri(
            IntPtr view,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string uri);

        [DllImport(Lib)]
        internal static extern void webkit_web_view_get_snapshot(
            IntPtr view,
            int region,
            int options,
            IntPtr cancellable,
            GAsyncReadyCallback callback,
            IntPtr userData);

        [DllImport(Lib)]
        internal static extern IntPtr webkit_web_view_get_snapshot_finish(
            IntPtr view,
            IntPtr result,
            IntPtr error);

        [DllImport(Lib)]
        internal static extern IntPtr webkit_javascript_result_get_js_value(IntPtr jsResult);

        [DllImport(Lib)]
        internal static extern IntPtr webkit_uri_scheme_request_get_uri(IntPtr request);

        [DllImport(Lib)]
        internal static extern void webkit_uri_scheme_request_finish(
            IntPtr request,
            IntPtr stream,
            long streamLength,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string contentType);

        [DllImport(Lib)]
        internal static extern IntPtr webkit_uri_scheme_request_get_http_headers(IntPtr request);

        [DllImport(Lib)]
        internal static extern void webkit_uri_scheme_response_set_status(
            IntPtr response,
            uint statusCode,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string? reasonPhrase);

        [DllImport(Lib)]
        internal static extern IntPtr webkit_uri_scheme_response_new(IntPtr stream, long streamLength);

        [DllImport(Lib)]
        internal static extern void webkit_uri_scheme_response_set_content_type(
            IntPtr response,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string contentType);

        [DllImport(Lib)]
        internal static extern void webkit_uri_scheme_response_set_http_headers(IntPtr response, IntPtr headers);

        [DllImport(Lib)]
        internal static extern void webkit_uri_scheme_request_finish_with_response(IntPtr request, IntPtr response);

        [DllImport(Lib)]
        internal static extern void webkit_uri_scheme_request_finish_error(
            IntPtr request,
            IntPtr error);

        [DllImport(Lib)]
        internal static extern void webkit_web_view_evaluate_javascript(
            IntPtr view,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string script,
            nint length,
            IntPtr worldName,
            IntPtr sourceUri,
            IntPtr cancellable,
            GAsyncReadyCallback callback,
            IntPtr userData);

        [DllImport(Lib)]
        internal static extern uint webkit_get_major_version();

        [DllImport(Lib)]
        internal static extern uint webkit_get_minor_version();

        [DllImport(Lib)]
        internal static extern uint webkit_get_micro_version();
    }

    /// <summary>GTK's GdkRGBA (all fields are doubles).</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct GdkRgba
    {
        internal double Red;
        internal double Green;
        internal double Blue;
        internal double Alpha;
    }
}

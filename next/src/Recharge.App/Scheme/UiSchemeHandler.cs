using System;
using System.IO;
using System.Runtime.InteropServices;
using Recharge.App.Native;

namespace Recharge.App.Scheme
{
    /// <summary>Handles recharge:// requests from the WebView.</summary>
    internal sealed class UiSchemeHandler
    {
        private const string ErrorDomain = "recharge-app";

        private static UiSchemeHandler? _active;
        private static readonly WebKitUriSchemeRequestCallback RequestCallback = OnRequest;

        private readonly string _root;

        private UiSchemeHandler(string root) => _root = root;

        internal static void Register(string root)
        {
            var handler = new UiSchemeHandler(root);
            _active = handler;

            IntPtr context = WebKit.webkit_web_context_get_default();
            IntPtr security = WebKit.webkit_web_context_get_security_manager(context);
            WebKit.webkit_security_manager_register_uri_scheme_as_secure(security, "recharge");
            WebKit.webkit_security_manager_register_uri_scheme_as_cors_enabled(security, "recharge");
            WebKit.webkit_web_context_register_uri_scheme(
                context,
                "recharge",
                RequestCallback,
                IntPtr.Zero,
                IntPtr.Zero);
        }

        private static void OnRequest(IntPtr request, IntPtr userData)
        {
            UiSchemeHandler? handler = _active;
            if (handler is null)
            {
                FinishError(request, 500, "UI scheme is not configured.");
                return;
            }

            IntPtr uriPointer = WebKit.webkit_uri_scheme_request_get_uri(request);
            string uri = Marshal.PtrToStringUTF8(uriPointer) ?? string.Empty;
            if (uri.StartsWith("recharge://maps/", StringComparison.OrdinalIgnoreCase))
            {
                ServeMap(request, uri);
                return;
            }
            if (uri.StartsWith("recharge://bg/", StringComparison.OrdinalIgnoreCase))
            {
                ServeBackground(request, uri);
                return;
            }
            UiPathResult result = UiPathResolver.Resolve(handler._root, uri);

            switch (result.Status)
            {
                case UiPathStatus.Forbidden:
                    FinishError(request, 403, result.Message);
                    return;
                case UiPathStatus.NotFound:
                    FinishError(request, 404, result.Message);
                    return;
            }

            byte[] bytes;
            try
            {
                bytes = File.ReadAllBytes(result.FullPath);
            }
            catch (Exception ex)
            {
                FinishError(request, 500, ex.Message);
                return;
            }

            IntPtr gbytes = GLib.g_bytes_new(bytes, (nuint)bytes.Length);
            IntPtr stream = Gio.g_memory_input_stream_new_from_bytes(gbytes);
            GLib.g_bytes_unref(gbytes);

            WebKit.webkit_uri_scheme_request_finish(
                request,
                stream,
                bytes.LongLength,
                result.MimeType);
            GObject.g_object_unref(stream);
        }

        // Read-only map files: streamed from disk through a GFileInputStream, never copied into a byte[].
        private static void ServeMap(IntPtr request, string uri)
        {
            string? game = Recharge.App.Bridge.GameFinder.Find();
            if (game is null)
            {
                FinishError(request, 404, "The game is not installed.");
                return;
            }
            UiPathResult result = MapPathResolver.Resolve(MapPathResolver.MapsRoot(game), uri);
            if (result.Status == UiPathStatus.Forbidden) { FinishError(request, 403, result.Message); return; }
            if (result.Status == UiPathStatus.NotFound) { FinishError(request, 404, result.Message); return; }
            long length;
            try { length = new FileInfo(result.FullPath).Length; }
            catch (Exception ex) { FinishError(request, 500, ex.Message); return; }
            IntPtr file = Gio.g_file_new_for_path(result.FullPath);
            IntPtr stream = Gio.g_file_read(file, IntPtr.Zero, IntPtr.Zero);
            GObject.g_object_unref(file);
            if (stream == IntPtr.Zero)
            {
                FinishError(request, 500, "Could not open the file.");
                return;
            }
            // The map files live on their own host: let the app's pages (another origin) read them, read-only.
            IntPtr response = WebKit.webkit_uri_scheme_response_new(stream, length);
            WebKit.webkit_uri_scheme_response_set_content_type(response, result.MimeType);
            IntPtr headers = Soup.soup_message_headers_new(Soup.HeadersResponse);
            Soup.soup_message_headers_append(headers, "Access-Control-Allow-Origin", "*");
            WebKit.webkit_uri_scheme_response_set_http_headers(response, headers);
            WebKit.webkit_uri_scheme_request_finish_with_response(request, response);
            GObject.g_object_unref(response);
            GObject.g_object_unref(stream);
        }

        // Read-only background media: pictures and videos from the app's backgrounds folder. A Range request (how a video seeks) gets
        // a 206 with at most ByteRange.MaxChunk bytes; a plain request is streamed from disk.
        private static void ServeBackground(IntPtr request, string uri)
        {
            UiPathResult result = BackgroundPathResolver.Resolve(
                BackgroundPathResolver.Root(Recharge.App.Settings.SettingsStore.DataDir()), uri);
            if (result.Status == UiPathStatus.Forbidden) { FinishError(request, 403, result.Message); return; }
            if (result.Status == UiPathStatus.NotFound) { FinishError(request, 404, result.Message); return; }
            long length;
            try { length = new FileInfo(result.FullPath).Length; }
            catch (Exception ex) { FinishError(request, 500, ex.Message); return; }

            string? rangeHeader = null;
            IntPtr requestHeaders = WebKit.webkit_uri_scheme_request_get_http_headers(request);
            if (requestHeaders != IntPtr.Zero)
                rangeHeader = Marshal.PtrToStringUTF8(Soup.soup_message_headers_get_one(requestHeaders, "Range"));
            ByteRange range = ByteRange.Parse(rangeHeader, length);

            IntPtr stream;
            long streamLength;
            uint status = 200;
            string? contentRange = null;
            if (range.Result == ByteRange.Kind.Partial)
            {
                byte[] chunk;
                try
                {
                    chunk = new byte[range.Length];
                    using var fs = new FileStream(result.FullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                    fs.Seek(range.Start, SeekOrigin.Begin);
                    int got = 0;
                    while (got < chunk.Length)
                    {
                        int n = fs.Read(chunk, got, chunk.Length - got);
                        if (n <= 0) break;
                        got += n;
                    }
                    if (got != chunk.Length) Array.Resize(ref chunk, got);
                }
                catch (Exception ex) { FinishError(request, 500, ex.Message); return; }
                IntPtr gbytes = GLib.g_bytes_new(chunk, (nuint)chunk.Length);
                stream = Gio.g_memory_input_stream_new_from_bytes(gbytes);
                GLib.g_bytes_unref(gbytes);
                streamLength = chunk.LongLength;
                status = 206;
                contentRange = "bytes " + range.Start + "-" + (range.Start + chunk.LongLength - 1) + "/" + length;
            }
            else if (range.Result == ByteRange.Kind.Unsatisfiable)
            {
                IntPtr gbytes = GLib.g_bytes_new(new byte[0], 0);
                stream = Gio.g_memory_input_stream_new_from_bytes(gbytes);
                GLib.g_bytes_unref(gbytes);
                streamLength = 0;
                status = 416;
                contentRange = "bytes */" + length;
            }
            else
            {
                IntPtr file = Gio.g_file_new_for_path(result.FullPath);
                stream = Gio.g_file_read(file, IntPtr.Zero, IntPtr.Zero);
                GObject.g_object_unref(file);
                if (stream == IntPtr.Zero) { FinishError(request, 500, "Could not open the file."); return; }
                streamLength = length;
            }

            IntPtr response = WebKit.webkit_uri_scheme_response_new(stream, streamLength);
            WebKit.webkit_uri_scheme_response_set_content_type(response, result.MimeType);
            if (status != 200) WebKit.webkit_uri_scheme_response_set_status(response, status, null);
            IntPtr headers = Soup.soup_message_headers_new(Soup.HeadersResponse);
            Soup.soup_message_headers_append(headers, "Access-Control-Allow-Origin", "*");
            Soup.soup_message_headers_append(headers, "Accept-Ranges", "bytes");
            if (contentRange != null) Soup.soup_message_headers_append(headers, "Content-Range", contentRange);
            WebKit.webkit_uri_scheme_response_set_http_headers(response, headers);
            WebKit.webkit_uri_scheme_request_finish_with_response(request, response);
            GObject.g_object_unref(response);
            GObject.g_object_unref(stream);
        }

        private static void FinishError(IntPtr request, int code, string message)
        {
            uint domain = GLib.g_quark_from_static_string(ErrorDomain);
            IntPtr error = GLib.g_error_new_literal(domain, code, message);
            WebKit.webkit_uri_scheme_request_finish_error(request, error);
            GLib.g_error_free(error);
        }
    }
}

using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Threading.Tasks;

namespace Recharge.App.Scheme
{
    /// <summary>
    /// A read-only HTTP server on 127.0.0.1 for background videos. WebKitGTK plays video through GStreamer, which only understands
    /// http, https and blob addresses, so a recharge:// address can't be played (it can be shown as a picture, but a video element
    /// fails to load it). The server answers with the same rules as the recharge://bg/ route: the same path checks, Range requests
    /// for seeking, nothing outside the backgrounds folder. The address holds a random token made for this run, so another program
    /// can't guess it; only GET and HEAD are answered.
    /// </summary>
    public sealed class BackgroundHttpServer : IDisposable
    {
        private readonly HttpListener _listener;
        private readonly Func<string> _backgroundsRoot;
        private readonly string _token;

        public int Port { get; }
        public string BaseUrl => "http://127.0.0.1:" + Port + "/" + _token + "/";

        private BackgroundHttpServer(HttpListener listener, int port, string token, Func<string> backgroundsRoot)
        {
            _listener = listener;
            Port = port;
            _token = token;
            _backgroundsRoot = backgroundsRoot;
        }

        private static BackgroundHttpServer? _shared;
        private static readonly object Gate = new object();

        /// <summary>The one server of this run, started on first use.</summary>
        public static BackgroundHttpServer Shared(Func<string> backgroundsRoot)
        {
            lock (Gate) return _shared ??= Start(backgroundsRoot);
        }

        public static BackgroundHttpServer Start(Func<string> backgroundsRoot)
        {
            byte[] raw = RandomNumberGenerator.GetBytes(16);
            string token = Convert.ToHexString(raw).ToLowerInvariant();
            for (int attempt = 0; attempt < 20; attempt++)
            {
                int port = FreePort();
                var listener = new HttpListener();
                listener.Prefixes.Add("http://127.0.0.1:" + port + "/");
                try
                {
                    listener.Start();
                }
                catch (Exception e) when (e is HttpListenerException || e is SocketException)
                {
                    listener.Close();
                    continue;
                }
                var server = new BackgroundHttpServer(listener, port, token, backgroundsRoot);
                _ = Task.Run(server.Loop);
                return server;
            }
            throw new InvalidOperationException("could not start the background media server");
        }

        private static int FreePort()
        {
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            try { return ((IPEndPoint)probe.LocalEndpoint).Port; }
            finally { probe.Stop(); }
        }

        private async Task Loop()
        {
            while (_listener.IsListening)
            {
                HttpListenerContext context;
                try { context = await _listener.GetContextAsync().ConfigureAwait(false); }
                catch (Exception e) when (e is HttpListenerException || e is ObjectDisposedException || e is InvalidOperationException) { return; }
                _ = Task.Run(() => Handle(context));
            }
        }

        /// <summary>What a request path maps to: the recharge://bg/ address it stands for, or null when the token or shape is wrong.</summary>
        public static string? ToSchemeUri(string rawPath, string token)
        {
            string path = rawPath;
            int cut = path.IndexOfAny(new[] { '?', '#' });
            if (cut >= 0) path = path.Substring(0, cut);
            string head = "/" + token + "/";
            if (!path.StartsWith(head, StringComparison.Ordinal)) return null;
            return "recharge://bg/" + path.Substring(head.Length);
        }

        private void Handle(HttpListenerContext context)
        {
            HttpListenerResponse response = context.Response;
            try
            {
                string method = context.Request.HttpMethod;
                if (method != "GET" && method != "HEAD") { Finish(response, 405, "Method not allowed."); return; }
                string? uri = ToSchemeUri(context.Request.RawUrl ?? "", _token);
                if (uri == null) { Finish(response, 404, "Not found."); return; }
                UiPathResult result = BackgroundPathResolver.Resolve(_backgroundsRoot(), uri);
                if (result.Status == UiPathStatus.Forbidden) { Finish(response, 403, result.Message); return; }
                if (result.Status == UiPathStatus.NotFound) { Finish(response, 404, result.Message); return; }

                using var file = new FileStream(result.FullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                long length = file.Length;
                ByteRange range = ByteRange.Parse(context.Request.Headers["Range"], length, long.MaxValue);
                response.ContentType = result.MimeType;
                response.Headers["Accept-Ranges"] = "bytes";
                response.Headers["Access-Control-Allow-Origin"] = "*";
                long start = 0, count = length;
                if (range.Result == ByteRange.Kind.Unsatisfiable)
                {
                    response.StatusCode = 416;
                    response.Headers["Content-Range"] = "bytes */" + length;
                    response.ContentLength64 = 0;
                    response.Close();
                    return;
                }
                if (range.Result == ByteRange.Kind.Partial)
                {
                    start = range.Start;
                    count = range.Length;
                    response.StatusCode = 206;
                    response.Headers["Content-Range"] = "bytes " + range.Start + "-" + range.End + "/" + length;
                }
                response.ContentLength64 = count;
                if (method == "GET")
                {
                    file.Seek(start, SeekOrigin.Begin);
                    var buffer = new byte[64 * 1024];
                    long left = count;
                    while (left > 0)
                    {
                        int n = file.Read(buffer, 0, (int)Math.Min(buffer.Length, left));
                        if (n <= 0) break;
                        response.OutputStream.Write(buffer, 0, n);
                        left -= n;
                    }
                }
                response.Close();
            }
            catch (Exception)
            {
                // the player closed the connection (a seek), or the file went away: nothing to report
                try { response.Abort(); } catch (Exception) { }
            }
        }

        private static void Finish(HttpListenerResponse response, int code, string message)
        {
            response.StatusCode = code;
            response.ContentType = "text/plain; charset=utf-8";
            byte[] body = System.Text.Encoding.UTF8.GetBytes(message);
            response.ContentLength64 = body.Length;
            response.OutputStream.Write(body, 0, body.Length);
            response.Close();
        }

        public void Dispose()
        {
            try { _listener.Close(); } catch (Exception) { }
        }
    }
}

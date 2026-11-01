using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Recharge.Server
{
    /// <summary>
    /// A stand-in for the hub for tests and the demo: GET /api/me for the token "tok-&lt;name&gt;" and GET /api/users/&lt;name&gt;.
    /// It never touches the real hub.
    /// </summary>
    public sealed class FakeHub : IDisposable
    {
        private readonly HttpListener _listener = new HttpListener();
        private readonly Dictionary<string, string> _users = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private readonly object _gate = new object();
        private readonly Dictionary<string, object> _pages = new Dictionary<string, object>(StringComparer.Ordinal);
        private readonly Dictionary<string, Dictionary<string, object>> _userData = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
        private int _meCalls;
        private bool _down;
        private Task _loop = Task.CompletedTask;

        public int Port { get; private set; }
        public string BaseUrl => "http://127.0.0.1:" + Port;
        public int MeCalls => Volatile.Read(ref _meCalls);
        /// <summary>When true every request answers 500 (the hub is having a bad day).</summary>
        public bool Down { get { lock (_gate) return _down; } set { lock (_gate) _down = value; } }

        public static string TokenFor(string name) => "tok-" + name.ToLowerInvariant();

        public FakeHub AddUser(string name)
        {
            lock (_gate) _users[name] = name;
            return this;
        }

        /// <summary>Serves a canned JSON answer for an exact path such as "/api/forum" (the demo and snapshots use it).</summary>
        public FakeHub Page(string path, object body)
        {
            lock (_gate) _pages[path] = body;
            return this;
        }

        /// <summary>Extra fields for GET /api/users/&lt;name&gt; (bio, uploads, colours...).</summary>
        public FakeHub UserData(string name, Dictionary<string, object> fields)
        {
            lock (_gate) _userData[name] = fields;
            return this;
        }

        public FakeHub Start()
        {
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            Port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            _listener.Prefixes.Add("http://127.0.0.1:" + Port + "/");
            _listener.Start();
            _loop = Task.Run(Loop);
            return this;
        }

        private async Task Loop()
        {
            while (true)
            {
                HttpListenerContext ctx;
                try { ctx = await _listener.GetContextAsync().ConfigureAwait(false); }
                catch (Exception e) when (e is HttpListenerException || e is ObjectDisposedException || e is InvalidOperationException) { return; }
                Answer(ctx);
            }
        }

        private void Answer(HttpListenerContext ctx)
        {
            int status = 404;
            object body = new { error = "not found" };
            string path = ctx.Request.Url!.AbsolutePath;
            lock (_gate)
            {
                if (_down) { status = 500; body = new { error = "down" }; }
                else if (path == "/api/me")
                {
                    Interlocked.Increment(ref _meCalls);
                    string? h = ctx.Request.Headers["Authorization"];
                    string? token = h is not null && h.StartsWith("Bearer ", StringComparison.Ordinal) ? h.Substring(7) : null;
                    string? name = null;
                    if (token is not null && token.StartsWith("tok-", StringComparison.Ordinal))
                    {
                        foreach (string u in _users.Values) if (TokenFor(u) == token) name = u;
                    }
                    if (name is null) { status = 401; body = new { error = "not logged in" }; }
                    else { status = 200; body = new { username = name, admin = false }; }
                }
                else if (_pages.TryGetValue(path, out object? page)) { status = 200; body = page; }
                else if (path.StartsWith("/api/users/", StringComparison.Ordinal))
                {
                    string name = Uri.UnescapeDataString(path.Substring("/api/users/".Length));
                    if (_users.TryGetValue(name, out string? real))
                    {
                        status = 200;
                        var fields = new Dictionary<string, object> { ["username"] = real };
                        if (_userData.TryGetValue(name, out Dictionary<string, object>? extra)) foreach (var kv in extra) fields[kv.Key] = kv.Value;
                        body = fields;
                    }
                }
            }
            try
            {
                byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(body);
                ctx.Response.StatusCode = status;
                ctx.Response.ContentType = "application/json";
                ctx.Response.ContentLength64 = bytes.Length;
                ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
                ctx.Response.Close();
            }
            catch (Exception e) when (e is HttpListenerException || e is ObjectDisposedException) { }
        }

        public void Dispose()
        {
            try { _listener.Stop(); } catch (ObjectDisposedException) { }
            try { _loop.Wait(1000); } catch (AggregateException) { }
        }
    }
}

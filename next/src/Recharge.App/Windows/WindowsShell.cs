using System;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;
using Recharge.App.Bridge;
using Recharge.App.Scheme;

namespace Recharge.App.Windows
{
    /// <summary>
    /// The Windows window: a plain Win32 top-level window (user32, no WinForms/WPF) that hosts a WebView2 control. It serves the same
    /// recharge://app, recharge://maps and recharge://bg addresses (through SchemeCore) and gives the pages the same
    /// window.recharge.call bridge as the Linux shell (BridgeHost.UserScript, with a small shim that maps the WebKit message handler
    /// onto chrome.webview.postMessage).
    /// </summary>
    [SupportedOSPlatform("windows")]
    internal sealed class WindowsShell
    {
        // The Linux script posts through window.webkit.messageHandlers.recharge.postMessage; WebView2 offers chrome.webview.postMessage.
        private const string Shim =
            "(function(){ if (!window.webkit) { window.webkit = { messageHandlers: { recharge: { postMessage: function (m) { window.chrome.webview.postMessage(m); } } } }; } })();\n";

        private const string ClassName = "RechargeNextWindow";
        private static readonly Win32.WndProc Proc = WindowProc;
        private static WindowsShell? _self;

        private readonly AppOptions _options;
        private readonly bool _updates;
        private readonly string _uiRoot = Path.Combine(AppContext.BaseDirectory, "ui");
        private readonly BridgeDispatcher _dispatcher = new BridgeDispatcher(Commands.CreateRegistry());
        private readonly UiContext _ui;
        private IntPtr _hwnd;
        private CoreWebView2Environment? _env;
        private CoreWebView2Controller? _controller;
        private bool _ready, _snapshotStarted;
        private int _exitCode;

        private WindowsShell(AppOptions options, bool updates)
        {
            _options = options;
            _updates = updates;
            _ui = new UiContext(this);
        }

        internal static int Run(AppOptions options, bool updates)
        {
            Win32.SetProcessDpiAwarenessContext(Win32.PerMonitorV2);
            var shell = new WindowsShell(options, updates);
            _self = shell;
            return shell.Loop();
        }

        private int Loop()
        {
            SynchronizationContext.SetSynchronizationContext(_ui);
            IntPtr instance = Win32.GetModuleHandleW(null);
            IntPtr bigIcon = IntPtr.Zero, smallIcon = IntPtr.Zero;
            try { Win32.ExtractIconExW(Environment.ProcessPath ?? "", 0, out bigIcon, out smallIcon, 1); } catch (Exception) { }
            var cls = new Win32.WNDCLASSEX
            {
                cbSize = (uint)Marshal.SizeOf<Win32.WNDCLASSEX>(),
                lpfnWndProc = Marshal.GetFunctionPointerForDelegate(Proc),
                hInstance = instance,
                hIcon = bigIcon,
                hIconSm = smallIcon,
                hCursor = Win32.LoadCursorW(IntPtr.Zero, (IntPtr)Win32.IDC_ARROW),
                hbrBackground = IntPtr.Zero,
                lpszClassName = ClassName,
            };
            if (Win32.RegisterClassExW(ref cls) == 0) { Log("RegisterClassEx failed " + Marshal.GetLastWin32Error()); return 4; }

            // Size the client area in device pixels: the option is in 96-dpi units.
            uint dpi = 96;
            var rect = new Win32.RECT { Right = _options.Width, Bottom = _options.Height };
            Win32.AdjustWindowRectExForDpi(ref rect, Win32.WS_OVERLAPPEDWINDOW, false, 0, 96);
            _hwnd = Win32.CreateWindowExW(0, ClassName, "Recharge", Win32.WS_OVERLAPPEDWINDOW | Win32.WS_CLIPCHILDREN,
                Win32.CW_USEDEFAULT, Win32.CW_USEDEFAULT, 0, 0, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
            if (_hwnd == IntPtr.Zero) { Log("CreateWindowEx failed " + Marshal.GetLastWin32Error()); return 4; }
            dpi = Win32.GetDpiForWindow(_hwnd);
            rect = new Win32.RECT { Right = _options.Width * (int)dpi / 96, Bottom = _options.Height * (int)dpi / 96 };
            Win32.AdjustWindowRectExForDpi(ref rect, Win32.WS_OVERLAPPEDWINDOW, false, 0, dpi);
            Win32.SetWindowPos(_hwnd, IntPtr.Zero, 0, 0, rect.Right - rect.Left, rect.Bottom - rect.Top, 0x0002 | 0x0004 | 0x0010); // NOMOVE|NOZORDER|NOACTIVATE
            if (bigIcon != IntPtr.Zero) Win32.SendMessageW(_hwnd, Win32.WM_SETICON, (IntPtr)Win32.ICON_BIG, bigIcon);
            if (smallIcon != IntPtr.Zero) Win32.SendMessageW(_hwnd, Win32.WM_SETICON, (IntPtr)Win32.ICON_SMALL, smallIcon);
            Win32.ShowWindow(_hwnd, Win32.SW_SHOW);
            Win32.UpdateWindow(_hwnd);

            _ = StartWebView();
            if (_options.IsSnapshot) _ = Timeout(_options.TimeoutSeconds * 1000);

            while (Win32.GetMessageW(out Win32.MSG m, IntPtr.Zero, 0, 0) > 0)
            {
                Win32.TranslateMessage(ref m);
                Win32.DispatchMessageW(ref m);
            }
            return _exitCode;
        }

        private async Task StartWebView()
        {
            try
            {
                string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Recharge", "webview");
                Directory.CreateDirectory(data);
                var options = new CoreWebView2EnvironmentOptions();
                options.CustomSchemeRegistrations.Add(new CoreWebView2CustomSchemeRegistration("recharge")
                {
                    TreatAsSecure = true,
                    HasAuthorityComponent = true,
                });
                _env = await CoreWebView2Environment.CreateAsync(null, data, options);
                _controller = await _env.CreateCoreWebView2ControllerAsync(_hwnd);
                _controller.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0x11, 0x11, 0x11);
                CoreWebView2 web = _controller.CoreWebView2;
                bool dev = Environment.GetEnvironmentVariable("RECHARGE_DEVTOOLS") == "1";
                web.Settings.AreDevToolsEnabled = dev;
                web.Settings.AreDefaultContextMenusEnabled = dev;
                web.Settings.AreBrowserAcceleratorKeysEnabled = dev;
                web.Settings.IsStatusBarEnabled = false;
                web.Settings.IsZoomControlEnabled = false;

                _dispatcher.Ready += () => _ui.Post(_ => OnReady(), null);
                _dispatcher.Log += (level, message) =>
                {
                    if (_options.EvalLog) Console.WriteLine("[console." + level + "] " + message);
                };
                if (_updates)
                {
                    _dispatcher.Ready += () =>
                    {
                        try { Recharge.App.Updates.Updater.Confirm(Recharge.App.Settings.SettingsStore.DataDir()); }
                        catch (Exception ex) { Log("update confirm failed: " + ex.Message); }
                    };
                }

                await web.AddScriptToExecuteOnDocumentCreatedAsync(Shim + BridgeHost.UserScript);
                web.AddWebResourceRequestedFilter("recharge://*", CoreWebView2WebResourceContext.All);
                web.WebResourceRequested += OnResource;
                web.WebMessageReceived += OnMessage;
                web.NewWindowRequested += (s, e) =>
                {
                    e.Handled = true; // links to the web open in the default browser, never in a second window
                    if (Uri.TryCreate(e.Uri, UriKind.Absolute, out Uri? u) && (u.Scheme == "http" || u.Scheme == "https"))
                        Win32.ShellExecuteW(IntPtr.Zero, "open", u.AbsoluteUri, null, null, Win32.SW_SHOW);
                };
                web.NavigationStarting += (s, e) =>
                {
                    // the app is recharge://app only; anything else is handed to the browser
                    if (Uri.TryCreate(e.Uri, UriKind.Absolute, out Uri? u) && (u.Scheme == "http" || u.Scheme == "https"))
                    {
                        e.Cancel = true;
                        Win32.ShellExecuteW(IntPtr.Zero, "open", u.AbsoluteUri, null, null, Win32.SW_SHOW);
                    }
                };
                ResizeWebView();

                string route = _options.Route;
                if (route.Length > 0 && !route.StartsWith("#", StringComparison.Ordinal)) route = "#" + route;
                web.Navigate("recharge://app/index.html" + route);
                _controller.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
            }
            catch (Exception ex)
            {
                Log("startup failed: " + ex);
                _exitCode = 4;
                Win32.MessageBoxW(_hwnd, "Recharge could not start its web view.\n\n" +
                    "The Microsoft Edge WebView2 Runtime is required but was not found on this machine.\n" +
                    "Download and install it from:\n" +
                    "https://developer.microsoft.com/en-us/microsoft-edge/webview2/\n" +
                    "Then restart Recharge.", "Recharge", 0x10);
                Win32.PostQuitMessage(4);
            }
        }

        private void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string raw;
            try { raw = e.TryGetWebMessageAsString(); } catch (Exception) { return; }
            _ = Task.Run(async () =>
            {
                try
                {
                    BridgeReply? reply = await _dispatcher.DispatchAsync(raw).ConfigureAwait(false);
                    if (reply is not null)
                    {
                        string script = reply.ToScript();
                        _ui.Post(_ => { try { _controller?.CoreWebView2.ExecuteScriptAsync(script); } catch (Exception) { } }, null);
                    }
                }
                catch (Exception ex) { Log("bridge: " + ex.Message); }
            });
        }

        private void OnResource(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            if (_env is null) return;
            try
            {
                string? range = null;
                if (e.Request.Headers.Contains("Range")) range = e.Request.Headers.GetHeader("Range");
                SchemeAnswer a = SchemeCore.Resolve(_uiRoot, e.Request.Uri, range);
                var headers = new StringBuilder();
                headers.Append("Cache-Control: no-store\r\n");
                if (a.CrossOrigin) headers.Append("Access-Control-Allow-Origin: *\r\nAccept-Ranges: bytes\r\n");
                Stream body;
                if (a.IsFile)
                {
                    headers.Append("Content-Type: ").Append(a.MimeType).Append("\r\n");
                    if (a.ContentRange != null) headers.Append("Content-Range: ").Append(a.ContentRange).Append("\r\n");
                    if (a.Status == 206)
                    {
                        using var fs = new FileStream(a.FullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                        fs.Seek(a.Start, SeekOrigin.Begin);
                        var chunk = new byte[a.Count];
                        int got = 0;
                        while (got < chunk.Length) { int n = fs.Read(chunk, got, chunk.Length - got); if (n <= 0) break; got += n; }
                        body = new MemoryStream(chunk, 0, got);
                    }
                    else body = new FileStream(a.FullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                }
                else
                {
                    headers.Append("Content-Type: text/plain; charset=utf-8\r\n");
                    body = new MemoryStream(Encoding.UTF8.GetBytes(a.Message));
                }
                if (a.Status == 416) body = new MemoryStream();
                e.Response = _env.CreateWebResourceResponse(body, a.Status, Reason(a.Status), headers.ToString());
            }
            catch (Exception ex)
            {
                e.Response = _env.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes(ex.Message)), 500, "Error", "Content-Type: text/plain\r\n");
            }
        }

        private static string Reason(int code) => code switch
        {
            200 => "OK", 206 => "Partial Content", 403 => "Forbidden", 404 => "Not Found", 416 => "Range Not Satisfiable", _ => "Error",
        };

        private void OnReady()
        {
            if (_ready) return;
            _ready = true;
            if (_options.IsSnapshot) _ = Delay(300, () => _ = Snapshot(true));
        }

        private async Task Delay(int ms, Action then) { await Task.Delay(ms); then(); }
        private async Task Timeout(int ms) { await Task.Delay(ms); await Snapshot(false); }

        private async Task Snapshot(bool wasReady)
        {
            if (_snapshotStarted || _controller is null) return;
            _snapshotStarted = true;
            try
            {
                string path = _options.SnapshotPath!;
                string? dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                using (var fs = File.Create(path))
                    await _controller.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs);
                Console.WriteLine((wasReady ? "snapshot: " : "snapshot (not ready): ") + path);
                _exitCode = wasReady ? 0 : 3;
            }
            catch (Exception ex) { Log("snapshot failed: " + ex.Message); _exitCode = 4; }
            Win32.PostQuitMessage(_exitCode);
        }

        private void ResizeWebView()
        {
            if (_controller is null) return;
            Win32.GetClientRect(_hwnd, out Win32.RECT r);
            _controller.Bounds = new System.Drawing.Rectangle(0, 0, r.Right - r.Left, r.Bottom - r.Top);
        }

        private static IntPtr WindowProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
        {
            WindowsShell? s = _self;
            switch (msg)
            {
                case Win32.WM_SIZE:
                    s?.ResizeWebView();
                    return IntPtr.Zero;
                case Win32.WM_SETFOCUS:
                    s?._controller?.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
                    return IntPtr.Zero;
                case Win32.WM_GETMINMAXINFO:
                {
                    uint dpi = Win32.GetDpiForWindow(hwnd);
                    var rect = new Win32.RECT { Right = 960 * (int)dpi / 96, Bottom = 600 * (int)dpi / 96 };
                    Win32.AdjustWindowRectExForDpi(ref rect, Win32.WS_OVERLAPPEDWINDOW, false, 0, dpi);
                    var info = Marshal.PtrToStructure<Win32.MINMAXINFO>(lParam);
                    info.ptMinTrackSize = new Win32.POINT { X = rect.Right - rect.Left, Y = rect.Bottom - rect.Top };
                    Marshal.StructureToPtr(info, lParam, false);
                    return IntPtr.Zero;
                }
                case Win32.WM_DPICHANGED:
                {
                    var suggested = Marshal.PtrToStructure<Win32.RECT>(lParam);
                    Win32.SetWindowPos(hwnd, IntPtr.Zero, suggested.Left, suggested.Top, suggested.Right - suggested.Left,
                        suggested.Bottom - suggested.Top, 0x0004 | 0x0010);
                    return IntPtr.Zero;
                }
                case Win32.WM_CLOSE:
                    s?._controller?.Close();
                    Win32.DestroyWindow(hwnd);
                    return IntPtr.Zero;
                case Win32.WM_DESTROY:
                    Win32.PostQuitMessage(0);
                    return IntPtr.Zero;
                case Win32.WM_APP:
                    s?._ui.Drain();
                    return IntPtr.Zero;
            }
            return Win32.DefWindowProcW(hwnd, msg, wParam, lParam);
        }

        private static void Log(string text)
        {
            try
            {
                string dir = Recharge.App.Settings.SettingsStore.DataDir();
                Directory.CreateDirectory(dir);
                File.AppendAllText(Path.Combine(dir, "shell.log"), DateTime.Now.ToString("s") + " " + text + Environment.NewLine);
            }
            catch (Exception) { }
            Console.Error.WriteLine(text);
        }

        /// <summary>Runs posted work on the window's thread (WebView2 is single-thread-affine), woken through a window message.</summary>
        private sealed class UiContext : SynchronizationContext
        {
            private readonly WindowsShell _shell;
            private readonly ConcurrentQueue<(SendOrPostCallback, object?)> _queue = new();
            internal UiContext(WindowsShell shell) => _shell = shell;

            public override void Post(SendOrPostCallback d, object? state)
            {
                _queue.Enqueue((d, state));
                if (_shell._hwnd != IntPtr.Zero) Win32.PostMessageW(_shell._hwnd, Win32.WM_APP, IntPtr.Zero, IntPtr.Zero);
            }

            internal void Drain()
            {
                while (_queue.TryDequeue(out var item)) item.Item1(item.Item2);
            }
        }
    }
}

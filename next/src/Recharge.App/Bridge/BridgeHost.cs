using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Recharge.App.Native;

namespace Recharge.App.Bridge
{
    /// <summary>Installs the page-side bridge and ferries messages to its dispatcher.</summary>
    internal sealed class BridgeHost
    {
        internal const string UserScript = """
            (function () {
              if (window.recharge) { return; }

              var pending = Object.create(null);
              var nextId = 0;

              window.recharge = {
                call: function (cmd, args) {
                  return new Promise(function (resolve, reject) {
                    var id = ++nextId;
                    pending[id] = { resolve: resolve, reject: reject };
                    try {
                      window.webkit.messageHandlers.recharge.postMessage(JSON.stringify({
                        id: id,
                        cmd: cmd,
                        args: args || {}
                      }));
                    } catch (error) {
                      delete pending[id];
                      reject(error);
                    }
                  });
                },
                ready: function () {
                  try {
                    window.webkit.messageHandlers.recharge.postMessage(JSON.stringify({
                      id: 0,
                      cmd: "__ready",
                      args: {}
                    }));
                  } catch (error) {
                    /* Nothing useful to do if the handler is gone. */
                  }
                }
              };

              function replyError(json) {
                try {
                  var value = JSON.parse(json);
                  if (value && typeof value.error === "string") {
                    return new Error(value.error);
                  }
                } catch (error) {
                  /* Fall through to the raw text. */
                }
                return new Error(json || "Recharge bridge error");
              }

              window.__rechargeReply = function (id, ok, json) {
                var entry = pending[id];
                if (!entry) { return; }
                delete pending[id];
                if (ok) {
                  var value = null;
                  if (json) {
                    try {
                      value = JSON.parse(json);
                    } catch (error) {
                      entry.reject(error);
                      return;
                    }
                  }
                  entry.resolve(value);
                } else {
                  entry.reject(replyError(json));
                }
              };

              ["log", "info", "warn", "error", "debug"].forEach(function (level) {
                var original = console[level];
                console[level] = function () {
                  try {
                    var text = Array.prototype.map.call(arguments, function (item) {
                      if (typeof item === "string") { return item; }
                      try { return JSON.stringify(item); } catch (error) { return String(item); }
                    }).join(" ");
                    window.webkit.messageHandlers.recharge.postMessage(JSON.stringify({
                      id: 0,
                      cmd: "__log",
                      args: { level: level, message: text }
                    }));
                  } catch (error) {
                    /* Logging must never break the page. */
                  }
                  if (typeof original === "function") {
                    return original.apply(console, arguments);
                  }
                };
              });

              function forward(message) {
                try {
                  window.webkit.messageHandlers.recharge.postMessage(JSON.stringify({
                    id: 0,
                    cmd: "__log",
                    args: { level: "error", message: message }
                  }));
                } catch (error) {
                  /* Logging must never break the page. */
                }
              }

              window.addEventListener("error", function (event) {
                var target = event.target;
                if (target && target !== window && (target.src || target.href)) {
                  forward("load failed: " + (target.src || target.href));
                  return;
                }
                forward("uncaught: " + event.message + " at " + event.filename + ":" + event.lineno);
              }, true);

              window.addEventListener("unhandledrejection", function (event) {
                var reason = event.reason;
                forward("unhandled rejection: " + (reason && reason.stack ? reason.stack : String(reason)));
              });
            })();
            """;

        private static BridgeHost? _active;

        private static readonly WebKitScriptMessageCallback MessageReceivedCallback = OnMessageReceived;
        private static readonly GSourceFunc IdleCallback = OnIdle;
        private static readonly GSourceFunc ReadyIdleCallback = OnReadyIdle;

        private readonly IntPtr _view;
        private readonly BridgeDispatcher _dispatcher;
        private readonly bool _evalLog;

        public event Action? Ready;

        internal BridgeHost(IntPtr view, bool evalLog)
        {
            _view = view;
            _evalLog = evalLog;
            _dispatcher = new BridgeDispatcher(Commands.CreateRegistry());
            _dispatcher.Ready += PostReady;
            _dispatcher.Log += OnLog;
            _active = this;
        }

        internal void Attach(IntPtr userContentManager)
        {
            IntPtr script = WebKit.webkit_user_script_new(
                UserScript,
                WebKit.UserContentInjectTopFrame,
                WebKit.UserScriptInjectAtDocumentStart,
                IntPtr.Zero,
                IntPtr.Zero);
            WebKit.webkit_user_content_manager_add_script(userContentManager, script);
            WebKit.webkit_user_script_unref(script);

            IntPtr callback = Marshal.GetFunctionPointerForDelegate(MessageReceivedCallback);
            GObject.g_signal_connect_data(
                userContentManager,
                "script-message-received::recharge",
                callback,
                IntPtr.Zero,
                IntPtr.Zero,
                0);

            // The installed 2.54 header still declares the two-argument entry point.
            WebKit.webkit_user_content_manager_register_script_message_handler(
                userContentManager,
                "recharge");
        }

        private void OnLog(string level, string message)
        {
            if (_evalLog)
            {
                // The dev timing harness (RECHARGE_PERF) gets each of its marks stamped with the process uptime.
                if (message.StartsWith("[perf]", StringComparison.Ordinal))
                {
                    message += " t=" + PerfConfig.UptimeMs();
                }
                Console.WriteLine("[console." + level + "] " + message);
            }
        }

        private void PostReady()
        {
            GCHandle handle = GCHandle.Alloc(this);
            uint source = GLib.g_idle_add(ReadyIdleCallback, GCHandle.ToIntPtr(handle));
            if (source == 0)
            {
                handle.Free();
            }
        }

        private static int OnReadyIdle(IntPtr data)
        {
            GCHandle handle = GCHandle.FromIntPtr(data);
            var host = (BridgeHost?)handle.Target;
            handle.Free();
            host?.Ready?.Invoke();
            return 0;
        }

        private static void OnMessageReceived(IntPtr manager, IntPtr jsValue, IntPtr userData)
        {
            BridgeHost? host = _active;
            if (host is null)
            {
                return;
            }

            // The classic script-message-received signal carries a
            // WebKitJavascriptResult, whose JSCValue we stringify.
            IntPtr value = WebKit.webkit_javascript_result_get_js_value(jsValue);
            IntPtr text = Jsc.jsc_value_to_string(value);
            string raw = text == IntPtr.Zero ? string.Empty : Marshal.PtrToStringUTF8(text) ?? string.Empty;
            if (text != IntPtr.Zero)
            {
                GLib.g_free(text);
            }
            host.Handle(raw);
        }

        private void Handle(string raw)
        {
            _ = Task.Run(async () =>
            {
                BridgeReply? reply;
                try
                {
                    reply = await _dispatcher.DispatchAsync(raw).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("bridge: " + ex.Message);
                    return;
                }

                if (reply is not null)
                {
                    PostScript(reply.ToScript());
                }
            });
        }

        private void PostScript(string script)
        {
            var pending = new PendingScript(_view, script);
            GCHandle handle = GCHandle.Alloc(pending);
            uint source = GLib.g_idle_add(IdleCallback, GCHandle.ToIntPtr(handle));
            if (source == 0)
            {
                handle.Free();
            }
        }

        private static int OnIdle(IntPtr data)
        {
            GCHandle handle = GCHandle.FromIntPtr(data);
            var pending = (PendingScript?)handle.Target;
            handle.Free();
            if (pending is not null)
            {
                WebKit.webkit_web_view_evaluate_javascript(
                    pending.View,
                    pending.Script,
                    -1,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    null!,
                    IntPtr.Zero);
            }
            return 0;
        }

        private sealed class PendingScript
        {
            internal PendingScript(IntPtr view, string script)
            {
                View = view;
                Script = script;
            }

            internal IntPtr View { get; }
            internal string Script { get; }
        }
    }
}

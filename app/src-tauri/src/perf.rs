//! Opt-in command timing (RECHARGE_PERF=1). Off: one cached bool check per command.
//! Log: <app log dir>/perf.log, one JSON line per command: when (s since the first command), name,
//! handler duration in ms, and the thread that ran the handler. Sync commands run entirely inside
//! the handler (so "main" there means the webview's thread was blocked); async commands only spawn.
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::{ipc::Invoke, Manager, Runtime};

fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("RECHARGE_PERF").map_or(false, |v| v != "0" && !v.is_empty()))
}

static LOG: OnceLock<Mutex<std::fs::File>> = OnceLock::new();
static T0: OnceLock<Instant> = OnceLock::new();

pub fn wrap<R: Runtime>(inner: &impl Fn(Invoke<R>) -> bool, inv: Invoke<R>) -> bool {
    if !enabled() {
        return inner(inv);
    }
    let cmd = inv.message.command().to_string();
    let app = inv.message.webview().app_handle().clone();
    let th = std::thread::current().name().unwrap_or("?").to_string();
    let t0 = T0.get_or_init(Instant::now);
    let start = Instant::now();
    let r = inner(inv);
    let line = format!(
        "{{\"k\":\"h\",\"t\":{:.1},\"cmd\":\"{}\",\"ms\":{:.3},\"thread\":\"{}\"}}",
        t0.elapsed().as_secs_f64(), cmd, start.elapsed().as_secs_f64() * 1000.0, th
    );
    let f = LOG.get_or_init(|| {
        let dir = app.path().app_log_dir().unwrap_or_else(|_| std::env::temp_dir());
        let _ = std::fs::create_dir_all(&dir);
        Mutex::new(std::fs::OpenOptions::new().create(true).append(true).open(dir.join("perf.log")).expect("perf.log"))
    });
    if let Ok(mut f) = f.lock() {
        let _ = writeln!(f, "{line}");
    }
    r
}

/// Runs a command's blocking body and, with RECHARGE_PERF=1, logs how long it took and on which thread ("k":"b"; not "main" once the command is off the UI thread).
pub fn timed<T>(cmd: &str, f: impl FnOnce() -> T) -> T {
    if !enabled() {
        return f();
    }
    let th = std::thread::current().name().unwrap_or("?").to_string();
    let t0 = T0.get_or_init(Instant::now);
    let start = Instant::now();
    let r = f();
    if let Some(f) = LOG.get() {
        if let Ok(mut f) = f.lock() {
            let _ = writeln!(f, "{{\"k\":\"b\",\"t\":{:.1},\"cmd\":\"{}\",\"ms\":{:.3},\"thread\":\"{}\"}}", t0.elapsed().as_secs_f64(), cmd, start.elapsed().as_secs_f64() * 1000.0, th);
        }
    }
    r
}

/// Pins the handler's runtime type so generate_handler! can be wrapped.
pub fn typed<F: Fn(Invoke<tauri::Wry>) -> bool + Send + Sync + 'static>(f: F) -> F {
    f
}

//! Progress window: a small tao window with a softbuffer-drawn bar, percent and one line of text
//! (built-in 5x7 bitmap font, no font crate). The event loop runs on its own thread so downloads
//! are never blocked. No window when disabled (--no-ui), when there is no display (Linux), or when
//! window creation fails: the launcher then just logs. Never blocks launching.
//! Self-contained (no crate:: references) so examples/ui_demo.rs can include it.
#![allow(dead_code)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(any(windows, feature = "window"))]
mod gui {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread::JoinHandle;
    use std::time::Duration;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::run_return::EventLoopExtRunReturn;
#[cfg(unix)]
use tao::platform::unix::EventLoopBuilderExtUnix;
#[cfg(windows)]
use tao::platform::windows::EventLoopBuilderExtWindows;
use tao::window::WindowBuilder;

const BG: u32 = 0x141414;
const PANEL: u32 = 0x1c1c1c;
const LINE: u32 = 0x3a3b36; // --line over --bg
const TEXT: u32 = 0xf9ffe4;
const TEXT_DIM: u32 = 0x8f9484;
const GREEN: u32 = 0x41f88d;

#[derive(Clone, Copy)]
pub enum Msg {
    Redraw,
    Quit,
}

pub struct Handle {
    pub proxy: EventLoopProxy<Msg>,
    pub thread: JoinHandle<()>,
}

/// Spawns the window thread; returns once the window exists (or None if creation failed/timed out).
pub fn open_window(title: String, pct: Arc<AtomicU64>) -> Option<Handle> {
    let (tx, rx) = mpsc::channel::<EventLoopProxy<Msg>>();
    let thread = std::thread::Builder::new()
        .name("ui".into())
        .spawn(move || window_thread(title, pct, tx))
        .ok()?;
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(proxy) => Some(Handle { proxy, thread }),
        Err(_) => None, // thread ended without a window (it exits on its own)
    }
}

fn window_thread(text: String, pct: Arc<AtomicU64>, ready: mpsc::Sender<EventLoopProxy<Msg>>) {
    let mut builder = EventLoopBuilder::<Msg>::with_user_event();
    builder.with_any_thread(true);
    let mut el = builder.build();
    let window = match WindowBuilder::new()
        .with_title("Recharge")
        .with_inner_size(tao::dpi::LogicalSize::new(420.0, 120.0))
        .with_resizable(false)
        .with_maximizable(false)
        .build(&el)
    {
        Ok(w) => Arc::new(w),
        Err(_) => return,
    };
    if let Some(m) = window.current_monitor().or_else(|| el.primary_monitor()) {
        let (ms, mp, ws) = (m.size(), m.position(), window.outer_size());
        window.set_outer_position(tao::dpi::PhysicalPosition::new(
            mp.x + (ms.width as i32 - ws.width as i32) / 2,
            mp.y + (ms.height as i32 - ws.height as i32) / 2,
        ));
    }
    let Ok(context) = softbuffer::Context::new(window.clone()) else { return };
    let Ok(mut surface) = softbuffer::Surface::new(&context, window.clone()) else { return };
    if ready.send(el.create_proxy()).is_err() {
        return;
    }
    window.request_redraw();
    el.run_return(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Msg::Quit) => *flow = ControlFlow::Exit,
            Event::UserEvent(Msg::Redraw) => window.request_redraw(),
            Event::WindowEvent { event: WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }, .. } => {
                window.request_redraw()
            }
            Event::RedrawRequested(_) => {
                let size = window.inner_size();
                let (Some(w), Some(h)) = (std::num::NonZeroU32::new(size.width), std::num::NonZeroU32::new(size.height)) else {
                    return;
                };
                if surface.resize(w, h).is_err() {
                    return;
                }
                if let Ok(mut buf) = surface.buffer_mut() {
                    let s = window.scale_factor().round().max(1.0) as usize;
                    draw(&mut buf, size.width as usize, size.height as usize, s, &text, pct.load(Ordering::Relaxed) as usize);
                    let _ = buf.present();
                }
            }
            _ => {}
        }
    });
}

// ---- drawing ----

struct Canvas<'a> {
    px: &'a mut [u32],
    w: usize,
    h: usize,
}

impl Canvas<'_> {
    fn rect(&mut self, x: usize, y: usize, w: usize, h: usize, c: u32) {
        for yy in y..(y + h).min(self.h) {
            for xx in x..(x + w).min(self.w) {
                self.px[yy * self.w + xx] = c;
            }
        }
    }
    fn text(&mut self, x: usize, y: usize, scale: usize, s: &str, c: u32) -> usize {
        let mut cx = x;
        for ch in s.chars() {
            let g = glyph(ch);
            for (col, bits) in g.iter().enumerate() {
                for row in 0..7 {
                    if bits >> row & 1 == 1 {
                        self.rect(cx + col * scale, y + row * scale, scale, scale, c);
                    }
                }
            }
            cx += 6 * scale;
        }
        cx - x
    }
}

fn draw(px: &mut [u32], w: usize, h: usize, s: usize, text: &str, pct: usize) {
    let mut c = Canvas { px, w, h };
    c.rect(0, 0, w, h, BG);
    let pad = 20 * s;
    // status line (font scale 2 logical => 2*s px per dot)
    c.text(pad, 22 * s, 2 * s, text, TEXT);
    // bar
    let (bx, by, bw, bh) = (pad, 62 * s, w.saturating_sub(2 * pad), 14 * s);
    c.rect(bx, by, bw, bh, LINE);
    c.rect(bx + s, by + s, bw.saturating_sub(2 * s), bh - 2 * s, PANEL);
    let fill = (bw.saturating_sub(4 * s)) * pct.min(100) / 100;
    c.rect(bx + 2 * s, by + 2 * s, fill, bh - 4 * s, GREEN);
    // percent, right aligned under the bar
    let label = format!("{pct}%");
    let lw = label.len() * 6 * s;
    c.text((bx + bw).saturating_sub(lw), by + bh + 8 * s, s, &label, TEXT_DIM);
}

/// 5x7 font, ASCII 0x20..=0x5F (lowercase is drawn as uppercase); columns, bit0 = top row.
fn glyph(ch: char) -> [u8; 5] {
    let c = ch.to_ascii_uppercase() as u32;
    if !(0x20..=0x5f).contains(&c) {
        return [0x7f, 0x41, 0x41, 0x41, 0x7f];
    }
    FONT[(c - 0x20) as usize]
}

#[rustfmt::skip]
const FONT: [[u8; 5]; 64] = [
    [0x00,0x00,0x00,0x00,0x00],[0x00,0x00,0x5F,0x00,0x00],[0x00,0x07,0x00,0x07,0x00],[0x14,0x7F,0x14,0x7F,0x14],
    [0x24,0x2A,0x7F,0x2A,0x12],[0x23,0x13,0x08,0x64,0x62],[0x36,0x49,0x55,0x22,0x50],[0x00,0x05,0x03,0x00,0x00],
    [0x00,0x1C,0x22,0x41,0x00],[0x00,0x41,0x22,0x1C,0x00],[0x14,0x08,0x3E,0x08,0x14],[0x08,0x08,0x3E,0x08,0x08],
    [0x00,0x50,0x30,0x00,0x00],[0x08,0x08,0x08,0x08,0x08],[0x00,0x60,0x60,0x00,0x00],[0x20,0x10,0x08,0x04,0x02],
    [0x3E,0x51,0x49,0x45,0x3E],[0x00,0x42,0x7F,0x40,0x00],[0x42,0x61,0x51,0x49,0x46],[0x21,0x41,0x45,0x4B,0x31],
    [0x18,0x14,0x12,0x7F,0x10],[0x27,0x45,0x45,0x45,0x39],[0x3C,0x4A,0x49,0x49,0x30],[0x01,0x71,0x09,0x05,0x03],
    [0x36,0x49,0x49,0x49,0x36],[0x06,0x49,0x49,0x29,0x1E],[0x00,0x36,0x36,0x00,0x00],[0x00,0x56,0x36,0x00,0x00],
    [0x08,0x14,0x22,0x41,0x00],[0x14,0x14,0x14,0x14,0x14],[0x00,0x41,0x22,0x14,0x08],[0x02,0x01,0x51,0x09,0x06],
    [0x32,0x49,0x79,0x41,0x3E],[0x7E,0x11,0x11,0x11,0x7E],[0x7F,0x49,0x49,0x49,0x36],[0x3E,0x41,0x41,0x41,0x22],
    [0x7F,0x41,0x41,0x22,0x1C],[0x7F,0x49,0x49,0x49,0x41],[0x7F,0x09,0x09,0x09,0x01],[0x3E,0x41,0x49,0x49,0x7A],
    [0x7F,0x08,0x08,0x08,0x7F],[0x00,0x41,0x7F,0x41,0x00],[0x20,0x40,0x41,0x3F,0x01],[0x7F,0x08,0x14,0x22,0x41],
    [0x7F,0x40,0x40,0x40,0x40],[0x7F,0x02,0x0C,0x02,0x7F],[0x7F,0x04,0x08,0x10,0x7F],[0x3E,0x41,0x41,0x41,0x3E],
    [0x7F,0x09,0x09,0x09,0x06],[0x3E,0x41,0x51,0x21,0x5E],[0x7F,0x09,0x19,0x29,0x46],[0x46,0x49,0x49,0x49,0x31],
    [0x01,0x01,0x7F,0x01,0x01],[0x3F,0x40,0x40,0x40,0x3F],[0x1F,0x20,0x40,0x20,0x1F],[0x3F,0x40,0x38,0x40,0x3F],
    [0x63,0x14,0x08,0x14,0x63],[0x07,0x08,0x70,0x08,0x07],[0x61,0x51,0x49,0x45,0x43],[0x00,0x7F,0x41,0x41,0x00],
    [0x02,0x04,0x08,0x10,0x20],[0x00,0x41,0x41,0x7F,0x00],[0x04,0x02,0x01,0x02,0x04],[0x40,0x40,0x40,0x40,0x40],
];
}

#[cfg(any(windows, feature = "window"))]
use gui::Handle;
#[cfg(any(windows, feature = "window"))]
fn open(title: &str, pct: &Arc<AtomicU64>) -> Option<Handle> {
    gui::open_window(title.to_string(), pct.clone())
}
#[cfg(any(windows, feature = "window"))]
fn close(h: Handle) {
    let _ = h.proxy.send_event(gui::Msg::Quit);
    let _ = h.thread.join();
}
#[cfg(any(windows, feature = "window"))]
fn redraw(h: &Handle, _pct: u64) {
    let _ = h.proxy.send_event(gui::Msg::Redraw);
}

// Linux without the `window` feature (the default: tao would link GTK3 at load time): zenity helper.
#[cfg(not(any(windows, feature = "window")))]
type Handle = (std::process::Child, std::process::ChildStdin);
#[cfg(not(any(windows, feature = "window")))]
fn open(title: &str, _pct: &Arc<AtomicU64>) -> Option<Handle> {
    use std::process::{Command, Stdio};
    let mut c = Command::new("zenity")
        .args(["--progress", "--no-cancel", "--auto-close", "--width=360", "--title=Recharge"])
        .arg(format!("--text={title}"))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdin = c.stdin.take()?;
    Some((c, stdin))
}
#[cfg(not(any(windows, feature = "window")))]
fn close(mut h: Handle) {
    drop(h.1); // EOF closes the window
    let _ = h.0.kill();
    let _ = h.0.wait();
}
#[cfg(not(any(windows, feature = "window")))]
fn redraw(h: &Handle, pct: u64) {
    use std::io::Write;
    // ChildStdin is written through a shared ref via &Handle.1
    let mut w = &h.1;
    let _ = writeln!(w, "{pct}");
}

pub struct Progress {
    enabled: bool,
    done: AtomicU64,
    total: AtomicU64,
    last_pct: AtomicU64,
    shown_pct: Arc<AtomicU64>,
    ui: Mutex<Option<Handle>>,
}

impl Progress {
    pub fn new(enabled: bool) -> Progress {
        Progress {
            enabled,
            done: 0.into(),
            total: 0.into(),
            last_pct: u64::MAX.into(),
            shown_pct: Arc::new(0.into()),
            ui: Mutex::new(None),
        }
    }

    /// Called once real work is known; opens the window only then.
    pub fn begin(&self, total_bytes: u64, title: &str) {
        self.total.store(total_bytes.max(1), Ordering::Relaxed);
        if !self.enabled || !have_display() {
            return;
        }
        if let Some(h) = open(title, &self.shown_pct) {
            *self.ui.lock().unwrap() = Some(h);
        }
    }

    pub fn add(&self, bytes: u64) {
        let done = self.done.fetch_add(bytes, Ordering::Relaxed) + bytes;
        let pct = (done * 100 / self.total.load(Ordering::Relaxed).max(1)).min(100);
        if self.last_pct.swap(pct, Ordering::Relaxed) != pct {
            self.shown_pct.store(pct, Ordering::Relaxed);
            if let Some(h) = self.ui.lock().unwrap().as_ref() {
                redraw(h, pct);
            }
        }
    }

    pub fn finish(&self) {
        if let Some(h) = self.ui.lock().unwrap().take() {
            close(h);
        }
    }
}

impl Drop for Progress {
    fn drop(&mut self) {
        self.finish();
    }
}

fn have_display() -> bool {
    if cfg!(all(unix, not(target_os = "macos"))) {
        std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
    } else {
        true
    }
}


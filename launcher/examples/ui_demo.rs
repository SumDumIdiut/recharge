//! Drives the progress window 0 -> 100% over 3 s. `cargo run --release --example ui_demo`
#[path = "../src/ui.rs"]
mod ui;

fn main() {
    let p = ui::Progress::new(true);
    p.begin(100, "Updating Recharge...");
    for _ in 0..100 {
        p.add(1);
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    p.finish();
}

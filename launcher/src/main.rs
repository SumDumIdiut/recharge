//! Recharge launcher: installs itself, keeps app/ up to date from the hub (staged, hash-verified,
//! with rollback) and starts the app. Contract/behaviour notes live in the module docs.
mod install;
mod log;
mod manifest;
mod old;
mod run;
mod state;
mod ui;
mod update;

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, ExitCode};
use update::Ctx;

#[derive(Default)]
struct Opts {
    repair: bool,
    uninstall: bool,
    yes: bool,
    /// With --uninstall: also delete settings, mods, skins and map saves.
    delete_data: bool,
    /// Dry run: list the old installs a first run would remove, change nothing.
    scan_old: bool,
    no_ui: bool,
    check: bool,
    /// Download an update into app.new/ but neither swap nor launch (the running app polls this).
    stage: bool,
    /// Wait for this pid to exit before swapping/launching (the app restarting itself).
    wait_pid: Option<u32>,
    version: bool,
    channel: Option<String>,
    root: Option<PathBuf>,
    /// Everything we do not recognise goes to the app untouched.
    pass: Vec<OsString>,
}

fn parse(args: &[OsString]) -> Result<Opts, String> {
    let mut o = Opts::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.to_str().unwrap_or("") {
            "--repair" => o.repair = true,
            "--uninstall" => o.uninstall = true,
            "--yes" | "-y" => o.yes = true,
            "--delete-data" => o.delete_data = true,
            "--scan-old" => o.scan_old = true,
            "--no-ui" => o.no_ui = true,
            "--check" => o.check = true,
            "--stage" => o.stage = true,
            "--wait-pid" => o.wait_pid = Some(it.next().and_then(|p| p.to_str()?.parse().ok()).ok_or("--wait-pid needs a pid")?),
            "--version" => o.version = true,
            "--channel" => {
                let c = it.next().and_then(|c| c.to_str()).unwrap_or("");
                if c != "stable" && c != "beta" {
                    return Err("--channel needs stable or beta".into());
                }
                o.channel = Some(c.into());
            }
            // Hidden: tests and portable installs.
            "--root" => o.root = Some(it.next().ok_or("--root needs a path")?.into()),
            "--" => {
                o.pass.extend(it.by_ref().cloned());
            }
            _ => o.pass.push(a.clone()),
        }
    }
    Ok(o)
}

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let o = match parse(&args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("recharge-launcher: {e}");
            return ExitCode::from(2);
        }
    };
    if o.version {
        println!("recharge-launcher {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let root = o.root.clone().unwrap_or_else(install::default_root);
    let exe = std::env::current_exe().unwrap_or_default();

    if o.scan_old {
        for i in old::scan(&root, &exe) {
            println!("would remove {}", i.describe());
        }
        return ExitCode::SUCCESS;
    }
    if o.uninstall {
        if !install::is_uninstall_copy() {
            // Run from a temp copy so no file in the root is locked by the process deleting it.
            return match install::uninstall_via_copy(&root, &exe, &args, o.yes) {
                Ok(c) => ExitCode::from(c as u8),
                Err(e) => {
                    eprintln!("uninstall: {e}");
                    ExitCode::FAILURE
                }
            };
        }
        log::init_at(&std::env::temp_dir().join("recharge-uninstall.log"));
        log!("uninstalling {}", root.display());
        if let Some(pid) = o.wait_pid {
            run::wait_exit(pid, std::time::Duration::from_secs(30)); // the app that asked for this
        }
        let res = install::uninstall(&root, o.yes, o.delete_data);
        install::schedule_self_delete();
        return match res {
            Ok(()) => {
                println!("Recharge removed.");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("uninstall: {e}");
                ExitCode::FAILURE
            }
        };
    }
    if o.check {
        return check(&o, &root);
    }

    // First run from anywhere else (Downloads, a USB stick...): install, then continue as installed.
    if !install::is_installed(&root, &exe) {
        log::init(&root);
        // A fresh download replaces every older install first (before we write anything of our own:
        // the old NSIS uninstaller deletes the Uninstall\Recharge registry key).
        old::cleanup(&root, &exe);
        let installed = match install::install_self(&root, &exe) {
            Ok(p) => p,
            Err(e) => return fatal(&format!("Could not install Recharge to {}: {e}", root.display())),
        };
        return match Command::new(installed).args(&args).status() {
            Ok(s) => ExitCode::from(s.code().unwrap_or(1) as u8),
            Err(e) => fatal(&format!("Could not start the installed launcher: {e}")),
        };
    }

    log::init(&root);
    let _ = std::fs::remove_file(exe.with_extension("old")); // left by a launcher self-update
    let channel = resolve_channel(&o, &root);
    let ctx = Ctx {
        root: root.clone(),
        base: base_url(),
        platform: update::platform_id(),
        channel,
        repair: o.repair,
        progress: ui::Progress::new(!o.no_ui),
    };
    let mut st = state::State::load(&root);

    if o.stage {
        return stage_only(&ctx, &mut st);
    }
    if let Some(pid) = o.wait_pid {
        // The app is restarting itself into an update: its files must be free before we swap.
        if !run::wait_exit(pid, std::time::Duration::from_secs(30)) {
            log!("pid {pid} still running after 30s, continuing anyway");
        }
    }

    let online = match update::prepare(&ctx, &mut st) {
        Ok(online) => online,
        Err(e) => {
            // Staging failed (bad hash, disk full...): app/ is untouched, so launch what we have.
            log!("update failed, keeping installed version: {e}");
            ctx.progress.finish();
            false
        }
    };

    if online && std::env::var_os("RECHARGE_LAUNCHER_REEXEC").is_none() {
        match update::update_launcher(&ctx, &exe) {
            Ok(true) => {
                log!("launcher updated, restarting");
                return match Command::new(&exe).args(&args).env("RECHARGE_LAUNCHER_REEXEC", "1").status() {
                    Ok(s) => ExitCode::from(s.code().unwrap_or(1) as u8),
                    Err(e) => fatal(&format!("Could not restart updated launcher: {e}")),
                };
            }
            Ok(false) => {}
            Err(e) => log!("launcher self-update failed: {e}"),
        }
    }

    let Some(cur) = st.current.clone() else {
        return fatal("Recharge is not installed yet and the update server could not be reached. Check your connection and try again.");
    };
    if st.pending.is_some() {
        // Fresh swap: refresh start-menu / uninstall entries (icon and version may have changed).
        install::refresh_shortcut(&root, &cur.version);
    } else {
        install::ensure_shortcuts(&root, &cur.version); // reinstall over leftovers, deleted shortcut
    }

    let mut child = match run::launch(&root, &exe, &cur, &ctx.channel, &o.pass) {
        Ok(c) => c,
        Err(e) => {
            log!("failed to start app: {e}");
            return recover(&ctx, &mut st, &exe, &o.pass);
        }
    };
    if st.pending.is_none() {
        return ExitCode::SUCCESS; // nothing to verify: let the app run on its own
    }
    if std::env::var_os("RECHARGE_LAUNCHER_NO_HEALTHCHECK").is_some() {
        st.pending = None;
        let _ = st.save(&root);
        return ExitCode::SUCCESS;
    }
    if run::health_check(&root, &mut child, cur.build) {
        log!("build {} confirmed healthy", cur.build);
        st.pending = None;
        let _ = st.save(&root);
        run::clean_markers(&root, cur.build);
        ExitCode::SUCCESS
    } else {
        recover(&ctx, &mut st, &exe, &o.pass)
    }
}

/// --stage: prepare an update in app.new/ and report; safe while the app runs (app/ is untouched).
fn stage_only(ctx: &Ctx, st: &mut state::State) -> ExitCode {
    match update::stage_only(ctx, st) {
        Ok(Some(build)) => println!("staged {build}"),
        Ok(None) => println!("up to date"),
        Err(e) => {
            log!("stage failed: {e}");
            println!("stage failed: {e}");
            return ExitCode::from(3);
        }
    }
    ExitCode::SUCCESS
}

/// New build failed: swap the old one back and start it. Exit code 1 so scripts can see it happened.
fn recover(ctx: &Ctx, st: &mut state::State, exe: &std::path::Path, pass: &[OsString]) -> ExitCode {
    match update::rollback(ctx, st) {
        Ok(()) => {
            let prev = st.current.clone().unwrap();
            if let Err(e) = run::launch(&ctx.root, exe, &prev, &ctx.channel, pass) {
                log!("could not start previous version: {e}");
            }
        }
        Err(e) => log!("rollback impossible: {e}"),
    }
    ExitCode::FAILURE
}

fn resolve_channel(o: &Opts, root: &std::path::Path) -> String {
    let file = root.join("channel.txt");
    if let Some(c) = &o.channel {
        let _ = std::fs::write(&file, c); // --channel sticks until changed again
        return c.clone();
    }
    match std::fs::read_to_string(&file).map(|s| s.trim().to_string()).as_deref() {
        Ok("beta") => "beta".into(),
        _ => "stable".into(),
    }
}

fn base_url() -> String {
    std::env::var("RECHARGE_UPDATE_BASE")
        .unwrap_or_else(|_| update::DEFAULT_BASE.into())
        .trim_end_matches('/')
        .to_string()
}

/// --check: print what a normal start would do, change nothing.
fn check(o: &Opts, root: &std::path::Path) -> ExitCode {
    let ctx = Ctx {
        root: root.into(),
        base: base_url(),
        platform: update::platform_id(),
        channel: resolve_channel(&Opts { channel: o.channel.clone(), ..Default::default() }, root),
        repair: o.repair,
        progress: ui::Progress::new(false),
    };
    let st = state::State::load(root);
    let installed = st.current.as_ref().map(|c| format!("{} (build {})", c.version, c.build)).unwrap_or_else(|| "none".into());
    println!("installed: {installed}  channel: {}", ctx.channel);
    let m = match update::fetch_manifest(&ctx) {
        Ok(m) => m,
        Err(e) => {
            println!("offline or manifest unavailable: {e}");
            return ExitCode::from(3);
        }
    };
    let plat = match update::platform(&ctx, &m) {
        Ok(p) => p,
        Err(e) => {
            println!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let plan = update::make_plan(&ctx, &st, plat);
    println!("available: {} (build {})", m.version, m.build);
    if st.bad_builds.contains(&m.build) {
        println!("build {} failed its health check earlier and would be skipped", m.build);
    } else if plan.is_noop() {
        println!("up to date");
    } else {
        println!("would update: {} file(s) to download ({} bytes), {} to remove, {} unchanged", plan.fetch.len(), plan.fetch_bytes(), plan.extra.len(), plan.keep.len());
        for f in &plan.fetch {
            println!("  fetch {}", f.path);
        }
    }
    ExitCode::SUCCESS
}

/// Errors with no console (double-clicked): also show a dialog when a helper is available.
fn fatal(msg: &str) -> ExitCode {
    eprintln!("Recharge: {msg}");
    log::write(msg);
    #[cfg(unix)]
    if std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some() {
        let _ = Command::new("zenity").args(["--error", "--title=Recharge", &format!("--text={msg}")]).status();
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let ps = format!("Add-Type -AssemblyName PresentationFramework;[void][System.Windows.MessageBox]::Show('{}','Recharge')", msg.replace('\'', ""));
        let _ = Command::new("powershell").args(["-NoProfile", "-Command", &ps]).creation_flags(0x0800_0000).status();
    }
    ExitCode::FAILURE
}

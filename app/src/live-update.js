// Tells the user when newer code has been downloaded, and reloads into it.
const tauri = window.__TAURI__;

// One banner at a time; a launcher update (needs a restart) replaces the live-code one.
function makeBanner(kind, text) {
  const banner = document.createElement('div');
  banner.id = 'live-update-banner';
  banner.dataset.kind = kind;
  banner.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;gap:10px;align-items:center;white-space:nowrap;' +
    'padding:8px 12px;box-shadow:0 4px 18px rgba(0,0,0,.45);background:var(--panel,#1a1a1a);border:1px solid var(--green,#3ddc84);color:var(--text,#eee);font:inherit;';
  const span = document.createElement('span');
  span.textContent = text;
  banner.appendChild(span);
  return banner;
}

function showLauncherBanner() {
  const old = document.getElementById('live-update-banner');
  if (old?.dataset.kind === 'launcher' || old?.dataset.kind === 'failed') return;
  old?.remove();
  const banner = makeBanner('launcher', 'Update ready');
  const restart = document.createElement('button');
  restart.className = 'btn btn-primary';
  restart.textContent = 'Restart';
  restart.style.cssText = 'white-space:nowrap;padding:6px 14px;';
  restart.onclick = async () => {
    restart.disabled = true;
    try {
      await tauri.core.invoke('launcher_restart', { repair: false });
    } catch (err) {
      restart.disabled = false;
      banner.firstChild.textContent = `Couldn't restart: ${String(err)}`;
    }
  };
  const later = document.createElement('button');
  later.className = 'btn';
  later.textContent = 'Later';
  later.style.cssText = 'white-space:nowrap;padding:6px 14px;';
  later.onclick = () => banner.remove();
  banner.append(restart, later);
  document.body.appendChild(banner);
}

// The last "Restart to update" did not take: say why, never a silent no-op.
function showFailureBanner(reason) {
  document.getElementById('live-update-banner')?.remove();
  const banner = makeBanner('failed', `Update didn't apply - ${reason}`);
  banner.style.whiteSpace = 'normal';
  banner.style.maxWidth = '560px';
  const retry = document.createElement('button');
  retry.className = 'btn btn-primary';
  retry.textContent = 'Try again';
  retry.style.cssText = 'white-space:nowrap;padding:6px 14px;';
  retry.onclick = async () => {
    retry.disabled = true;
    try {
      await tauri.core.invoke('launcher_restart', { repair: false });
    } catch (err) {
      retry.disabled = false;
      banner.firstChild.textContent = `Update didn't apply - ${String(err)}`;
    }
  };
  const log = document.createElement('button');
  log.className = 'btn';
  log.textContent = 'Open log';
  log.style.cssText = 'white-space:nowrap;padding:6px 14px;';
  log.onclick = () => tauri.core.invoke('launcher_open_log').catch((err) => { banner.firstChild.textContent = String(err); });
  const close = document.createElement('button');
  close.className = 'btn';
  close.textContent = 'Dismiss';
  close.style.cssText = 'white-space:nowrap;padding:6px 14px;';
  close.onclick = () => banner.remove();
  banner.append(retry, log, close);
  document.body.appendChild(banner);
}

function showBanner() {
  if (document.getElementById('live-update-banner')) return;
  const banner = makeBanner('live', 'Recharge updated.');
  const reload = document.createElement('button');
  reload.className = 'btn btn-primary';
  reload.textContent = 'Reload';
  reload.style.cssText = 'white-space:nowrap;padding:6px 14px;';
  reload.onclick = () => location.reload();
  const later = document.createElement('button');
  later.className = 'btn';
  later.textContent = 'Later';
  later.style.cssText = 'white-space:nowrap;padding:6px 14px;';
  later.onclick = () => banner.remove();
  banner.append(reload, later);
  document.body.appendChild(banner);
}

tauri?.event?.listen?.('live-updated', showBanner);
tauri?.event?.listen?.('launcher-update-ready', showLauncherBanner);
tauri?.event?.listen?.('launcher-update-failed', (e) => showFailureBanner(String(e?.payload ?? 'see the launcher log')));
tauri?.core?.invoke?.('launcher_update_failure').then((r) => { if (r) showFailureBanner(r); }).catch(() => {});
// An update staged before this page loaded (reload, or the check ran during startup).
tauri?.core?.invoke?.('launcher_info').then((i) => { if (i?.managed && i.ready) showLauncherBanner(); }).catch(() => {});

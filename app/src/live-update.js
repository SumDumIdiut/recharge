// Tells the user when newer code has been downloaded, and reloads into it.
const tauri = window.__TAURI__;

function showBanner() {
  if (document.getElementById('live-update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'live-update-banner';
  banner.style.cssText =
    'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:9999;display:flex;gap:14px;align-items:center;' +
    'padding:12px 18px;background:var(--panel,#1a1a1a);border:1px solid var(--green,#3ddc84);color:var(--text,#eee);font:inherit;';
  banner.innerHTML = '<span>Recharge updated.</span>';
  const reload = document.createElement('button');
  reload.className = 'btn btn-primary';
  reload.textContent = 'Reload';
  reload.onclick = () => location.reload();
  const later = document.createElement('button');
  later.className = 'btn';
  later.textContent = 'Later';
  later.onclick = () => banner.remove();
  banner.append(reload, later);
  document.body.appendChild(banner);
}

tauri?.event?.listen?.('live-updated', showBanner);

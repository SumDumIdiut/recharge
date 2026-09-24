
function escapeForHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const normPath = (p) => String(p).replace(/^\\\\\?\\/, '').toLowerCase();

export async function renderInstallList(listEl, opts = {}) {
  const { invoke } = window.__TAURI__.core;
  if (!listEl) return null;

  let installs;
  try {
    installs = await invoke('detect_all_igtap_installs');
  } catch (err) {
    listEl.innerHTML = `<div class="home-install-sub">${escapeForHtml(String(err))}</div>`;
    opts.onError?.(err);
    return null;
  }

  const active = await invoke('detect_igtap_install').catch(() => null);
  if (active && !installs.some((i) => normPath(i.path) === normPath(active.path))) {
    installs = [active, ...installs];
  }

  if (installs.length === 0) {
    listEl.innerHTML = opts.emptyHtml ?? '';
    opts.onEmpty?.();
    return null;
  }

  listEl.innerHTML = '';
  for (const install of installs) {
    const isActive = active && normPath(install.path) === normPath(active.path);
    const row = document.createElement('div');
    row.className = 'home-install-row' + (isActive ? ' home-install-row-active' : '');
    row.innerHTML = `
      <div>
        <div class="home-install-label">IGTAP (${install.variant})</div>
        <div class="home-install-sub">${escapeForHtml(install.path)}</div>
      </div>
      <button class="btn${isActive ? ' btn-primary' : ''}" ${isActive ? 'disabled' : ''}>${isActive ? 'Selected' : 'Select'}</button>
    `;
    if (!isActive) {
      row.querySelector('button').onclick = async () => {
        try {
          await invoke('set_game_path', { path: install.path });
          opts.onSelect?.(install);
        } catch (err) {
          opts.onSelectError?.(err, install);
        }
        renderInstallList(listEl, opts);
      };
    }
    listEl.appendChild(row);
  }

  opts.onRendered?.(installs, active);
  return active;
}

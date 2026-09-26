// The Games list at the bottom of the Installation panel: older IGTAP builds
// from the Recharge Library, downloadable and playable from here.
let games = [];
const busy = new Map(); // game id -> progress text while installing/starting
let started = false;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function kindLabel(g) {
  if (g.type === 'webgl') return 'Web build';
  return g.platform === 'windows' ? 'Windows build' : g.platform === 'linux' ? 'Linux build' : 'Standalone build';
}

function render() {
  const el = document.getElementById('home-games');
  if (!el) return;
  if (!games.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML =
    '<div class="home-panel-title" style="margin-top:18px;">Games</div><div class="home-install-list">' +
    games
      .map((g) => {
        const id = escapeHtml(g.id);
        let action;
        if (busy.has(g.id)) {
          action = `<button class="btn" disabled>${escapeHtml(busy.get(g.id) || 'Working…')}</button>`;
        } else if (g.installed && !g.unplayableReason) {
          action = `<button class="btn btn-primary" onclick="window.__gamePlay('${id}')">Play</button>
                    <button class="btn" onclick="window.__gameRemove('${id}', '${escapeHtml(g.name).replace(/'/g, "\\'")}')">Remove</button>`;
        } else if (g.installed) {
          action = `<button class="btn" onclick="window.__gameRemove('${id}', '${escapeHtml(g.name).replace(/'/g, "\\'")}')">Remove</button>`;
        } else {
          action = `<button class="btn" onclick="window.__gameInstall('${id}')">Download${g.size ? ` (${formatSize(g.size)})` : ''}</button>`;
        }
        const note = g.unplayableReason ? `<div class="home-install-sub">${escapeHtml(g.unplayableReason)}</div>` : '';
        return `
      <div class="home-install-row">
        <div>
          <div class="home-install-label">${escapeHtml(g.name)}</div>
          <div class="home-install-sub">${escapeHtml(kindLabel(g))}${g.installed ? ' \u00b7 installed' : ''}</div>
          ${note}
        </div>
        <div style="display:flex;gap:8px;">${action}</div>
      </div>`;
      })
      .join('') +
    '</div>';
}

async function load() {
  const { invoke } = window.__TAURI__.core;
  try {
    games = await invoke('list_library_games');
  } catch {
    games = []; // offline, or an app build without the Games backend - just hide the section
  }
  render();
}

async function run(id, command, startText) {
  const { invoke } = window.__TAURI__.core;
  busy.set(id, startText);
  render();
  try {
    await invoke(command, { id });
  } catch (err) {
    alert(String(err));
  } finally {
    busy.delete(id);
    await load();
  }
}

window.__gameInstall = (id) => run(id, 'install_library_game', 'Starting…');

window.__gamePlay = async (id) => {
  const { invoke } = window.__TAURI__.core;
  busy.set(id, 'Starting…');
  render();
  try {
    await invoke('play_library_game', { id });
    await new Promise((r) => setTimeout(r, 1500)); // the window opens by itself; keep the label up so the click registers
  } catch (err) {
    alert(String(err));
  } finally {
    busy.delete(id);
    render();
  }
};

window.__gameRemove = async (id, name) => {
  if (!confirm(`Remove "${name}" from this computer? You can download it again later.`)) return;
  const { invoke } = window.__TAURI__.core;
  try {
    await invoke('uninstall_library_game', { id });
  } catch (err) {
    alert(String(err));
  }
  await load();
};

export async function initHomeGames() {
  if (!started) {
    started = true;
    window.__TAURI__.event.listen('game-progress', (e) => {
      const { id, text } = e.payload;
      if (text) busy.set(id, text);
      render();
    });
  }
  await load();
}

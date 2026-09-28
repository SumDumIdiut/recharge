import { escapeHtml } from '../ui.js';

let games = [];
let loadError = null;
const busy = new Map(); // game id -> progress text while installing/starting
let unlisten = null;

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
  const list = document.getElementById('games-list');
  if (!list) return;
  if (loadError) {
    list.innerHTML = `<div class="empty-state">Couldn't reach the Recharge Library. Check your connection and reopen this tab.</div>`;
    return;
  }
  if (!games.length) {
    list.innerHTML = '<div class="empty-state">No games published yet.</div>';
    return;
  }
  list.innerHTML = games
    .map((g) => {
      const working = busy.has(g.id);
      let action;
      if (working) {
        action = `<span class="browse-card-meta">${escapeHtml(busy.get(g.id) || 'Working…')}</span>`;
      } else if (g.installed && g.unplayableReason) {
        // Downloaded, but built for another OS: keep the files, offer removal only.
        action = `<button class="btn" onclick="window.__gameRemove('${escapeHtml(g.id)}', '${escapeHtml(g.name).replace(/'/g, "\\'")}')">Remove</button>`;
      } else if (g.installed) {
        action = `<button class="btn btn-primary" onclick="window.__gamePlay('${escapeHtml(g.id)}')">Play</button>
                  <button class="btn" onclick="window.__gameRemove('${escapeHtml(g.id)}', '${escapeHtml(g.name).replace(/'/g, "\\'")}')">Remove</button>`;
      } else {
        action = `<button class="btn btn-primary" onclick="window.__gameInstall('${escapeHtml(g.id)}')">Download${g.size ? ` (${formatSize(g.size)})` : ''}</button>`;
      }
      return `
    <div class="browse-card">
      <div class="browse-card-info">
        <div class="browse-card-name">${escapeHtml(g.name)}</div>
        <div class="browse-card-meta">${escapeHtml(kindLabel(g))}${g.installed ? ' \u00b7 Installed' : ''}</div>
        ${g.description ? `<div class="browse-card-desc" style="padding:0;">${escapeHtml(g.description)}</div>` : ''}
        ${g.unplayableReason ? `<div class="browse-card-desc" style="padding:0;">${escapeHtml(g.unplayableReason)}${g.installed ? "" : " You can still download it."}</div>` : ''}
      </div>
      <div class="browse-card-actions">
        <div class="browse-card-actions-right" style="gap:10px;">${action}</div>
      </div>
    </div>`;
    })
    .join('');
}

async function load() {
  const { invoke } = window.__TAURI__.core;
  try {
    games = await invoke('list_library_games');
    loadError = null;
  } catch (err) {
    games = [];
    loadError = String(err);
  }
  render();
}

async function run(id, startText, command) {
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

window.__gameInstall = (id) => run(id, 'Starting…', 'install_library_game');

window.__gamePlay = async (id) => {
  const { invoke } = window.__TAURI__.core;
  busy.set(id, 'Starting…');
  render();
  try {
    await invoke('play_library_game', { id });
    // The window opens by itself; leave the label up for a moment so the click registers.
    await new Promise((r) => setTimeout(r, 1500));
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

export async function init() {
  unlisten ??= await window.__TAURI__.event.listen('game-progress', (e) => {
    const { id, text } = e.payload;
    if (text) busy.set(id, text);
    render();
  });
  await load();
}

export async function onShow() {
  await load();
}

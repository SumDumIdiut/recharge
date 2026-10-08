import { initHome, refreshInstallStatus } from './home.js';
import './live-update.js';
import { maybeShowUpdatedBanner } from './whatsnew-banner.js';
import { startBackgroundTimer } from './theme.js';

const _tabLoaded = {};
let curTab = 'home';
let navGeneration = 0; // bumped on every navigate(), so a slow load that's since been left can't clobber wherever the user is now

const LIVE_TABS = new Set(['mods', 'maps', 'skins', 'games']);

// Loads/refreshes a tab's content after it's already visible, so switching to
// it is never blocked on the fetch, the script import or its own refresh.
async function loadTab(tab, target, token) {
  if (!_tabLoaded[tab]) {
    target.innerHTML = '<div class="empty-state">Loading…</div>';
    const res = await fetch('/' + tab + '/view.html');
    const html = await res.text();
    if (token !== navGeneration) return;
    target.innerHTML = html;
    _tabLoaded[tab] = true;
    const mod = await import('/' + tab + '/script.js');
    if (token !== navGeneration) return;
    if (mod.init) await mod.init();
    return;
  }
  if (LIVE_TABS.has(tab)) {
    const mod = await import('/' + tab + '/script.js');
    if (token !== navGeneration) return;
    if (mod.onShow) await mod.onShow();
  }
}

window.navigate = function navigate(tab) {
  if (tab === curTab) return;
  const target = document.getElementById('view-' + tab);
  if (!target) return;

  document.getElementById('view-' + curTab)?.classList.remove('v-on');
  target.classList.add('v-on');
  curTab = tab;
  try { localStorage.setItem('rechargeCurrentTab', tab); } catch {}

  document.getElementById('crumb-bar').hidden = tab === 'home';

  if (tab === 'home') {
    refreshInstallStatus({ log: false });
    return;
  }
  loadTab(tab, target, ++navGeneration);
};

window.goHome = () => window.navigate('home');

// Amplifier, the map editor: the old one. It fills the window over whatever
// page is open. (The v2 editor has been removed.)
let oldAmplifierRoot = null;
window.chooseAmplifier = () => openOldAmplifier();
window.__amplifierOldClose = () => {
  if (oldAmplifierRoot) { oldAmplifierRoot.remove(); oldAmplifierRoot = null; }
};
async function openOldAmplifier() {
  if (oldAmplifierRoot && oldAmplifierRoot.isConnected) return;
  const root = document.createElement('div');
  root.className = 'map-maker';
  root.dataset.amplifier = 'old';
  document.body.appendChild(root);
  oldAmplifierRoot = root;
  const m = await import('/maps/editor.js');
  await m.mountEditor(root);
}

function showToast(html) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = html;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}

window.addEventListener('session-expired', (e) => showToast(e.detail || 'Your login expired - log in again.'));

async function refreshTab(tab) {
  delete _tabLoaded[tab];
  if (tab === curTab) await ensureTab(tab);
}

window.__TAURI__.event.listen('hub-beam-installed', (event) => {
  const { kind, name } = event.payload;
  showToast(`Installed <strong>${name}</strong> from the Recharge Library`);
  if (kind === 'background' || kind === 'playlist') {
    window.dispatchEvent(new Event('backgrounds-changed'));
    return;
  }
  refreshTab(kind === 'mods' ? 'mods' : kind === 'skins' ? 'skins' : 'maps');
});

(function initGlobalLoaderProgress() {
  const el = document.getElementById('global-progress');
  const textEl = document.getElementById('global-progress-text');
  const fillEl = document.getElementById('global-progress-fill');
  if (!el) return;

  window.__TAURI__.event.listen('loader-progress', (event) => {
    const text = event.payload;
    el.hidden = false;
    textEl.textContent = text;
    const match = text.match(/^(\d+)\/(\d+):/);
    fillEl.style.width = match ? (parseInt(match[1], 10) / parseInt(match[2], 10)) * 100 + '%' : '0%';
  });

  window.__TAURI__.event.listen('loader-install-finished', (event) => {
    const ok = event.payload;
    textEl.textContent = ok ? 'RechargeLoader: done' : 'RechargeLoader: install failed - see Settings';
    fillEl.style.width = ok ? '100%' : fillEl.style.width;
    setTimeout(() => { el.hidden = true; }, ok ? 2000 : 4000);
  });
})();

window.addEventListener('keydown', async (e) => {
  if (e.key !== 'F11') return;
  e.preventDefault();
  const { getCurrentWindow } = window.__TAURI__.window;
  const win = getCurrentWindow();
  const isFullscreen = await win.isFullscreen();
  await win.setFullscreen(!isFullscreen);
});

initHome();
startBackgroundTimer();
maybeShowUpdatedBanner();

try {
  const savedTab = localStorage.getItem('rechargeCurrentTab');
  if (savedTab && savedTab !== 'home') window.navigate(savedTab);
} catch {}

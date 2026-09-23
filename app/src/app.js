import { initHome, refreshInstallStatus } from './home.js';

const _tabLoaded = {};
let curTab = 'home';

const LIVE_TABS = new Set(['mods', 'maps', 'skins']);

async function ensureTab(tab) {
  if (tab === 'home') return;
  if (!_tabLoaded[tab]) {
    const res = await fetch('/' + tab + '/view.html');
    document.getElementById('view-' + tab).innerHTML = await res.text();
    _tabLoaded[tab] = true;
    const mod = await import('/' + tab + '/script.js');
    if (mod.init) await mod.init();
    return;
  }
  if (LIVE_TABS.has(tab)) {
    const mod = await import('/' + tab + '/script.js');
    if (mod.onShow) await mod.onShow();
  }
}

window.navigate = async function navigate(tab) {
  if (tab === curTab) return;
  await ensureTab(tab);

  document.getElementById('view-' + curTab)?.classList.remove('v-on');
  document.getElementById('view-' + tab)?.classList.add('v-on');
  curTab = tab;
  try { localStorage.setItem('rechargeCurrentTab', tab); } catch {}

  document.getElementById('crumb-bar').hidden = tab === 'home';

  if (tab === 'home') refreshInstallStatus({ log: false });
};

window.goHome = () => window.navigate('home');

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

async function refreshTab(tab) {
  delete _tabLoaded[tab];
  if (tab === curTab) await ensureTab(tab);
}

window.__TAURI__.event.listen('hub-beam-installed', (event) => {
  const { kind, name } = event.payload;
  showToast(`Installed <strong>${name}</strong> from the Recharge Library`);
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

try {
  const savedTab = localStorage.getItem('rechargeCurrentTab');
  if (savedTab && savedTab !== 'home') window.navigate(savedTab);
} catch {}

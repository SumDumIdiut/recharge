import { initHome, refreshInstallStatus } from './home.js';

const _tabLoaded = {};
let curTab = 'home';

async function ensureTab(tab) {
  if (tab === 'home' || _tabLoaded[tab]) return;
  const res = await fetch('/' + tab + '/view.html');
  document.getElementById('view-' + tab).innerHTML = await res.text();
  _tabLoaded[tab] = true;
  const mod = await import('/' + tab + '/script.js');
  if (mod.init) mod.init();
}

window.navigate = async function navigate(tab) {
  if (tab === curTab) return;
  await ensureTab(tab);

  document.getElementById('view-' + curTab)?.classList.remove('v-on');
  document.getElementById('view-' + tab)?.classList.add('v-on');
  curTab = tab;

  document.getElementById('crumb-bar').hidden = tab === 'home';

  // A path picked in Settings > Browse (or a Settings visit in general)
  // should be reflected the moment you're back, not just after restarting.
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

// A tab already loaded once is cached (see ensureTab) and won't re-fetch its
// view/re-run init on its own - drop the cache entry so a beamed install is
// reflected next time the tab is opened, or immediately if it's the one
// currently on screen.
async function refreshTab(tab) {
  delete _tabLoaded[tab];
  if (tab === curTab) await ensureTab(tab);
}

// A "Beam to Client" click on the recharge-hub web viewer hits a local HTTP
// endpoint this app runs (see src-tauri/src/commands/hub.rs), which installs
// the mod/map and emits this event once done.
window.__TAURI__.event.listen('hub-beam-installed', (event) => {
  const { kind, name } = event.payload;
  showToast(`Installed <strong>${name}</strong> from the Recharge Library`);
  refreshTab(kind === 'mods' ? 'mods' : 'maps');
});

window.addEventListener('keydown', async (e) => {
  if (e.key !== 'F11') return;
  e.preventDefault();
  const { getCurrentWindow } = window.__TAURI__.window;
  const win = getCurrentWindow();
  const isFullscreen = await win.isFullscreen();
  await win.setFullscreen(!isFullscreen);
});

initHome();

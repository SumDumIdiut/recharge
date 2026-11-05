import { h } from '../dom.js';
import { call, describeError, type GameInfo } from '../bridge.js';
import { button } from '../components/button.js';
import { toast } from '../components/toast.js';
import { openGameFolder, pickFolder, setGamePath, getSettings, type LoaderStatus } from './api.js';
import { panel, row, wrap, type Section } from './ui.js';

const LOADER_WORDS: Record<string, string> = {
  installed: 'Installed',
  notinstalled: 'Not installed',
  outdated: 'Update available',
  broken: 'Needs repair',
  foreign: 'Another mod tool found',
  off: 'Installed (vanilla build selected)',
};

/** The patcher's errors start with a short code ("busy: ...", "io: ..."); show just the sentence. */
function plainError(error: unknown): string {
  return describeError(error).replace(/^(busy|io|foreign|shape):\s*/i, '');
}

function loaderRow(): HTMLElement {
  const status = h('span', { className: 'path-value', text: 'Checking…' });
  const detail = h('div', { className: 'setting-hint' });
  const actions = h('div', { className: 'settings-row-wrap' });
  const explain = h('div', { className: 'setting-hint' });
  explain.textContent =
    'Install adds the Recharge mod loader to your IGTAP game. It replaces the old Recharge loader if you have one, and brings maps, skins and multiplayer into the game itself. ' +
    'Repair puts the loader files back if something is missing or changed. Uninstall removes the loader and restores your original game file exactly as it was. ' +
    'IGTAP has to be closed for any of these.';
  let busy = false;
  let key = '';
  let hasBackup = false;

  const run = async (command: string, done: string): Promise<void> => {
    if (busy) return;
    busy = true;
    apply();
    try {
      const result = await call<LoaderStatus>(command);
      toast(done, 'success');
      show(result);
    } catch (error) {
      toast(plainError(error), 'error');
    } finally {
      busy = false;
      apply();
    }
  };
  const mk = (label: string, command: string, done: string, kind: 'primary' | 'secondary' | 'danger'): HTMLButtonElement =>
    button(label, { kind, onClick: () => void run(command, done) });
  const install = mk('Install', 'loader.install', 'RechargeLoader installed.', 'primary');
  const repair = mk('Repair', 'loader.repair', 'RechargeLoader repaired.', 'secondary');
  const uninstall = mk('Uninstall', 'loader.uninstall', 'RechargeLoader removed. Your original game file is back.', 'danger');
  actions.append(install, repair, uninstall);

  function apply(): void {
    const installed = key === 'installed' || key === 'off';
    install.textContent = key === 'outdated' ? 'Update' : 'Install';
    install.disabled = busy || !(key === 'notinstalled' || key === 'outdated');
    repair.disabled = busy || !(installed || key === 'broken' || key === 'outdated');
    uninstall.disabled = busy || !(installed || key === 'outdated' || (key === 'broken' && hasBackup));
  }

  function show(s: LoaderStatus): void {
    key = String(s.state || '').toLowerCase();
    hasBackup = !!s.hasBackup;
    status.textContent = s.legacy && key === 'outdated' ? 'Old loader installed' : LOADER_WORDS[key] || s.state || 'Unknown';
    status.classList.toggle('is-missing', key !== 'installed' && key !== 'off');
    detail.textContent = s.detail || '';
    actions.hidden = false;
    apply();
  }

  void (async () => {
    const found = await call<GameInfo>('game.find').catch(() => null);
    if (!found || !found.path) {
      status.textContent = 'IGTAP not found';
      status.classList.add('is-missing');
      actions.hidden = true;
      return;
    }
    try {
      show(await call<LoaderStatus>('loader.status'));
    } catch (error) {
      status.textContent = 'Unavailable';
      status.classList.add('is-missing');
      detail.textContent = plainError(error);
      actions.hidden = true;
    }
  })();

  const control = h('div', { className: 'path-box' }, status);
  const outer = row('RechargeLoader', 'The mod loader inside the game.', wrap(control, actions));
  const copy = outer.querySelector('.setting-copy');
  copy?.appendChild(detail);
  copy?.appendChild(explain);
  return outer;
}

export function gameSection(): Section {
  let current: string | null = null;
  const value = h('span', { className: 'path-value', text: 'Looking for IGTAP…' });
  const note = h('div', { className: 'setting-hint' });
  const field = h('input', { className: 'settings-input', attrs: { type: 'text', placeholder: '/path/to/IGTAP', spellcheck: 'false', 'aria-label': 'Game folder' } });
  const error = h('div', { className: 'settings-error', hidden: true });

  async function refresh(): Promise<void> {
    const [info, saved] = await Promise.all([
      call<GameInfo>('game.find').catch(() => ({ path: null }) as GameInfo),
      getSettings().catch(() => null),
    ]);
    current = info && info.path ? info.path : null;
    value.textContent = current || 'IGTAP not found';
    value.title = current || '';
    value.classList.toggle('is-missing', !current);
    note.textContent = saved && saved.gamePath ? 'Chosen by you.' : 'Found automatically in your Steam libraries.';
    reset.hidden = !(saved && saved.gamePath);
  }

  async function apply(path: string | null): Promise<void> {
    error.hidden = true;
    try {
      await setGamePath(path);
      field.value = '';
      await refresh();
      toast(path ? 'Game folder saved.' : 'Using the detected game folder.', 'success');
    } catch (e) {
      error.textContent = describeError(e);
      error.hidden = false;
    }
  }

  const browse = button('Change…', {
    kind: 'secondary',
    icon: 'folder',
    onClick: () => {
      void pickFolder(current || undefined).then(
        (result) => {
          if (result.path) void apply(result.path);
        },
        (e) => {
          error.textContent = describeError(e) + '. Type the folder below instead.';
          error.hidden = false;
        }
      );
    },
  });
  const open = button('Open folder', {
    kind: 'ghost',
    icon: 'folder',
    onClick: () => void openGameFolder().catch((e) => toast(describeError(e), 'error')),
  });
  const reset = button('Use detected', { kind: 'ghost', onClick: () => void apply(null) });
  reset.hidden = true;
  const use = button('Use this path', { kind: 'secondary', onClick: () => void apply(field.value.trim()) });
  field.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') void apply(field.value.trim());
  });

  const location = row('IGTAP location', '', wrap(h('div', { className: 'path-box' }, value), browse, open, reset));
  location.querySelector('.setting-copy')?.appendChild(note);
  const typed = row('Type a path', 'If the folder chooser is not available, enter the folder here.', wrap(field, use));
  typed.querySelector('.setting-copy')?.appendChild(error);
  void refresh();
  return { node: panel('Game', location, typed, loaderRow()) };
}

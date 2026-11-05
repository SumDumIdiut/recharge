import { h } from '../dom.js';
import { call, describeError } from '../bridge.js';
import { switchControl, setSwitch } from '../settings/ui.js';
import { button } from './button.js';
import { toast } from './toast.js';

interface GunState {
  installed: boolean;
  running: boolean;
  appliesOn: string;
  settings: { enabled: boolean; gun: string; breakTiles: boolean; leftMouseFires: boolean; recoilPercent: number };
  guns: string[];
  unlocks: Record<string, boolean>;
}

/** The Gun mod's settings, shown in its item view. They are written to the mod's config and apply the next time the game starts. */
export function gunSettingsSection(): HTMLElement {
  const section = h('section', { className: 'detail-gun' });
  section.appendChild(h('h3', { className: 'detail-h', text: 'Gun settings' }));
  const body = h('div', { className: 'gun-body' }, h('p', { className: 'dim', text: 'Loading…' }));
  section.appendChild(body);

  const row = (label: string, hint: string, control: HTMLElement): HTMLElement =>
    h('div', { className: 'gun-row' }, h('div', { className: 'gun-label' }, h('span', { text: label }), h('span', { className: 'dim', text: hint })), control);

  function paint(state: GunState): void {
    const s = state.settings;
    const locked = state.running;
    const enabled = switchControl('Gun enabled', s.enabled, (on) => setSwitch(enabled, on));
    const breakTiles = switchControl('Bullets break blocks', s.breakTiles, (on) => setSwitch(breakTiles, on));
    const left = switchControl('Left mouse button fires', s.leftMouseFires, (on) => setSwitch(left, on));
    const gun = h('select', { className: 'select', attrs: { 'aria-label': 'Gun' } }) as HTMLSelectElement;
    for (const name of state.guns) gun.appendChild(h('option', { text: name, attrs: name === s.gun ? { value: name, selected: 'selected' } : { value: name } }));
    const recoil = h('input', { className: 'input gun-num', attrs: { type: 'number', min: '0', max: '10000', step: '1', value: String(s.recoilPercent), 'aria-label': 'Recoil percent' } }) as HTMLInputElement;
    for (const control of [enabled, breakTiles, left, gun, recoil]) (control as HTMLButtonElement).disabled = locked;

    const save = button('Save', { kind: 'primary', disabled: locked });
    const status = h('p', { className: 'detail-status dim', attrs: { role: 'status' } });
    save.addEventListener('click', () => {
      save.disabled = true;
      call<GunState>('gun.setSettings', {
        enabled: enabled.getAttribute('aria-checked') === 'true',
        gun: gun.value,
        breakTiles: breakTiles.getAttribute('aria-checked') === 'true',
        leftMouseFires: left.getAttribute('aria-checked') === 'true',
        recoilPercent: Math.round(Number(recoil.value)),
      }).then((next) => {
        toast('Gun settings saved. They apply the next time the game starts.', 'success');
        paint(next);
      }, (error) => {
        save.disabled = false;
        status.className = 'detail-status error';
        status.textContent = describeError(error);
      });
    });

    const unlocked = Object.keys(state.unlocks).filter((key) => state.unlocks[key]);
    const relock = button('Re-lock the gun', { kind: 'danger', disabled: locked || unlocked.length === 0, title: 'Makes the Unlock gun box buyable again (a backup of the record is kept)' });
    let confirming = false;
    relock.addEventListener('click', () => {
      if (!confirming) {
        confirming = true;
        relock.querySelector('span')!.textContent = 'Click again to re-lock';
        window.setTimeout(() => { confirming = false; const label = relock.querySelector('span'); if (label) label.textContent = 'Re-lock the gun'; }, 4000);
        return;
      }
      relock.disabled = true;
      call('gun.relock', { slot: 'all' }).then(() => {
        toast('The gun is locked again.', 'success');
        void load();
      }, (error) => {
        relock.disabled = false;
        status.className = 'detail-status error';
        status.textContent = describeError(error);
      });
    });

    body.replaceChildren(
      h('p', { className: 'dim', text: locked ? 'IGTAP is running. Close the game to change these.' : 'Changes apply ' + state.appliesOn + '.' }),
      row('Enabled', 'Turn the gun off without removing the mod', enabled),
      row('Gun', 'Which of the five guns you start with', gun),
      row('Bullets break blocks', 'Blocks, spikes and objects until the level reloads', breakTiles),
      row('Left mouse fires', 'Otherwise only the hotbar keys fire', left),
      row('Recoil', 'Percent of normal, 0 to 10000', recoil),
      h('div', { className: 'detail-actions' }, save, relock),
      status
    );
  }

  function load(): Promise<void> {
    return call<GunState>('gun.settings').then(
      (state) => { if (state.installed) paint(state); else body.replaceChildren(h('p', { className: 'dim', text: 'Install the Gun mod to change its settings.' })); },
      (error) => body.replaceChildren(h('p', { className: 'dim', text: 'Gun settings are not available (' + describeError(error) + ').' }))
    );
  }
  void load();
  return section;
}

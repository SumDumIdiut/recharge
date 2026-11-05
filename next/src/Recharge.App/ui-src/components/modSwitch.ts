import { h } from '../dom.js';
import { call, describeError } from '../bridge.js';
import { switchControl } from '../settings/ui.js';
import { isEmbeddedMod, type Item } from '../lib/library.js';
import { toast } from './toast.js';

/** True for an installed mod you can turn on and off (not the built-in ones). */
export function canToggleMod(item: Item): boolean {
  return item.kind === 'mods' && !!item.installed && !!item.installed.folder && !isEmbeddedMod(item);
}

/**
 * The on/off switch for an installed mod. It flips at once, asks the app to enable or disable the mod, and puts the
 * switch back with a plain message when that fails (for example while the game is running).
 * onDone runs after a successful toggle so the page can reload what is installed.
 */
export function modSwitch(item: Item, onDone: (enabled: boolean) => void, label = true): HTMLElement | null {
  if (!canToggleMod(item) || !item.installed) return null;
  const folder = item.installed.folder as string;
  const wrap = h('span', { className: 'mod-switch' });
  const text = h('span', { className: 'mod-switch-label' });
  const paint = (on: boolean) => { text.textContent = on ? 'On' : 'Off'; wrap.classList.toggle('is-on', on); };
  const sw = switchControl('Turn ' + item.name + ' on or off', item.installed.enabled !== false, (next) => {
    sw.disabled = true;
    sw.setAttribute('aria-checked', next ? 'true' : 'false');
    paint(next);
    call('library.setModEnabled', { folder, id: item.modId || item.id, enabled: next }).then(() => {
      sw.disabled = false;
      toast(item.name + (next ? ' is on' : ' is off'), 'success');
      onDone(next);
    }, (error) => {
      sw.disabled = false;
      sw.setAttribute('aria-checked', next ? 'false' : 'true');
      paint(!next);
      const message = describeError(error);
      toast(/running/i.test(message) ? 'Close the game first, then switch ' + item.name + '.' : 'Could not switch ' + item.name + ': ' + message, 'error');
    });
  });
  paint(item.installed.enabled !== false);
  // inside a card link: a click on the switch must not open the card
  wrap.addEventListener('click', (event) => { event.stopPropagation(); event.preventDefault(); if (event.target === wrap || event.target === text) sw.click(); });
  wrap.appendChild(sw);
  if (label) wrap.appendChild(text);
  return wrap;
}

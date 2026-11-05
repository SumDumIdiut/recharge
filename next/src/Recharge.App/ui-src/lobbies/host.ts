import { h } from '../dom.js';
import { button } from '../components/button.js';
import { selectControl } from '../components/select.js';
import { modal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { call, describeError } from '../bridge.js';
import { currentUser } from '../account/session.js';
import { counter, field, formError, textInput } from '../community/forms.js';
import type { InstalledData } from '../lib/library.js';
import { ensureRechargeLoader } from './loaderGuard.js';
import { hostProblem, hostRequest, LOBBY_NAME_MAX, type HostChoice } from './model.js';

const BASE = '@base';
const HARD = '@hard';

/** The host dialog: a lobby name and what to play (the base game, its hard B-side, or an installed map), then start the game hosting it. */
export function openHostDialog(installed: InstalledData | null): void {
  const me = currentUser();
  const name = textInput(me ? me.username + "'s lobby" : 'My lobby', 'Lobby name', LOBBY_NAME_MAX);
  const maps = (installed?.maps ?? []).slice().sort((a, b) => (a.name || a.folder).localeCompare(b.name || b.folder));
  const options = [{ value: BASE, label: 'Base game' }, { value: HARD, label: 'Base game: Hard (B-side)' }]
    .concat(maps.map((m) => ({ value: 'map:' + m.folder, label: m.name || m.folder })));
  const what = selectControl(options, { value: BASE });
  const select = what.querySelector('select') as HTMLSelectElement;
  const error = formError();

  const form = h('form', { className: 'compose host-form', attrs: { novalidate: 'novalidate' } });
  const nameField = field('Lobby name', name);
  nameField.appendChild(counter(name, LOBBY_NAME_MAX));
  form.appendChild(nameField);
  form.appendChild(field('Play', what, maps.length ? 'Players without the map are offered it when they join.' : 'Install maps from the Library to host them.'));
  form.appendChild(error.element);
  const start = button('Host and start game', { kind: 'primary', type: 'submit', icon: 'play' });
  form.appendChild(h('div', { className: 'compose-actions' }, start));

  let busy = false;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    const picked = select.value.startsWith('map:') ? maps.find((m) => 'map:' + m.folder === select.value) ?? null : null;
    const choice: HostChoice = { name: name.value, map: picked ? { folder: picked.folder, name: picked.name, hubId: picked.hubId } : null, hard: select.value === HARD };
    const problem = hostProblem(choice);
    if (problem) { error.show(problem); return; }
    busy = true;
    start.disabled = true;
    error.show(null);
    void ensureRechargeLoader('Hosting from Recharge').then((ok) => {
      if (!ok) { busy = false; start.disabled = false; return undefined; }
      return call<{ launched?: boolean; intent?: { ok?: boolean; error?: string } }>('game.launch', hostRequest(choice)).then((reply) => {
        if (reply && reply.intent && reply.intent.ok === false) throw new Error(reply.intent.error || 'the game could not host');
        (overlay.querySelector('.modal-head .icon-btn') as HTMLElement | null)?.click();
        toast(reply && reply.launched ? 'Starting the game. Your lobby opens when it loads.' : 'Lobby opened in the game.', 'success');
      }).catch((failure) => {
        busy = false;
        start.disabled = false;
        error.show(describeError(failure));
      });
    });
  });

  const overlay = modal({ title: 'Host a lobby', body: form, actions: [{ label: 'Cancel' }] });
  name.focus();
  name.select();
}

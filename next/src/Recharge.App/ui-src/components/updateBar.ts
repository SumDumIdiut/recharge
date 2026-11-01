import { h } from '../dom.js';
import { icon } from '../icons.js';
import { describeError } from '../bridge.js';
import { button } from './button.js';
import { toast } from './toast.js';
import { updateBegin, updateRestart, updateStatus, type UpdateStatus } from '../settings/api.js';
import { barMessage, shouldShowBar } from '../lib/updateInfo.js';

const POLL_MS = 60_000;

/**
 * The "Recharge x is ready - Restart to update" bar above the page. Starts the app's automatic update checks, then watches the
 * status; the user can dismiss it (it comes back for a newer build). Outside the app (no bridge) it stays hidden.
 */
export function initUpdateBar(host: HTMLElement): void {
  let dismissed = 0;
  const bar = h('div', { className: 'update-bar', attrs: { role: 'status', hidden: 'hidden' } });
  const text = h('span', { className: 'update-bar-text' });
  const restart = button('Restart to update', {
    kind: 'primary',
    icon: 'refresh',
    onClick: () => {
      restart.disabled = true;
      void updateRestart().catch((e) => {
        restart.disabled = false;
        toast('Could not restart: ' + describeError(e), 'error');
      });
    },
  });
  const close = h('button', { className: 'icon-btn update-bar-close', attrs: { type: 'button', title: 'Dismiss', 'aria-label': 'Dismiss' } });
  close.appendChild(icon('x', 16));
  bar.append(icon('download', 18), text, restart, close);
  host.insertBefore(bar, host.querySelector('#topbar')?.nextSibling ?? host.firstChild);

  let current: UpdateStatus | null = null;
  function render(): void {
    const show = shouldShowBar(current, dismissed);
    bar.hidden = !show;
    if (show) text.textContent = barMessage(current);
  }
  close.addEventListener('click', () => {
    if (current && current.ready) dismissed = current.ready.build;
    render();
  });

  async function poll(): Promise<void> {
    try {
      current = await updateStatus();
    } catch {
      current = null;
    }
    render();
  }
  void updateBegin().then(
    (s) => {
      current = s;
      render();
    },
    () => undefined
  );
  window.setInterval(() => void poll(), POLL_MS);
  window.addEventListener('recharge-update-changed', () => void poll());
}

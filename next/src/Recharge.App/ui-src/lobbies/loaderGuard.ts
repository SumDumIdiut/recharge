import { h } from '../dom.js';
import { call, describeError } from '../bridge.js';
import { modal } from '../components/modal.js';
import { toast } from '../components/toast.js';

interface LoaderModeReply { modded?: boolean; loader?: string; canModded?: boolean; detail?: string }

/**
 * Hosting or joining a lobby from Recharge sends the game an instruction over the app link, and only RechargeLoader 2 listens for it.
 * Resolves true when the game folder has it (or when that can't be told, so the launch reports its own problem); otherwise shows a
 * dialog and resolves true only after "Install loader" succeeded, false on Cancel.
 */
export async function ensureRechargeLoader(what: string): Promise<boolean> {
  let mode: LoaderModeReply;
  try {
    mode = await call<LoaderModeReply>('loader.mode', {});
  } catch {
    return true;
  }
  if (mode.loader === 'next' && mode.canModded !== false) return true;

  return new Promise<boolean>((resolve) => {
    let outcome = false;
    let installing = false;
    const body = h('div', { className: 'loader-guard' });
    const old = mode.loader === 'legacy';
    body.appendChild(h('p', {
      text: what + ' needs Recharge’s own loader in your game. ' +
        (old ? 'Your game still has the loader from the previous Recharge app, which can’t take instructions from this app, so the game would open to a black screen.'
             : mode.loader === 'next' ? 'The loader in your game is incomplete.' : 'Your game doesn’t have a loader installed yet.'),
    }));
    body.appendChild(h('p', {
      className: 'setting-hint',
      text: 'Installing replaces the old loader, keeps your mods and saves, and can be undone from Settings → Game (Uninstall restores the original game file). IGTAP has to be closed.',
    }));
    const overlay = modal({
      title: 'Recharge’s loader is needed',
      body,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Install loader',
          kind: 'primary',
          onClick: () => {
            if (installing) return false;
            installing = true;
            void call('loader.install').then(() => {
              outcome = true;
              toast('RechargeLoader installed.', 'success');
              (overlay.querySelector('.modal-head .icon-btn') as HTMLElement | null)?.click();
            }, (error) => {
              installing = false;
              toast(describeError(error).replace(/^(busy|io|foreign|shape):\s*/i, ''), 'error');
            });
            return false;
          },
        },
      ],
      onClose: () => resolve(outcome),
    });
  });
}

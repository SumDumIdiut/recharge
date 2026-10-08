import { isLoggedIn } from './auth.js';

// Opens the login dialog (home.js owns it); falls back to the Account tab.
export function openAccount() {
  if (typeof window.__homeAccountBadgeClick === 'function') window.__homeAccountBadgeClick();
  else window.navigate?.('account');
}

// Upload buttons are always visible; this is what they call first. Returns true when the
// user is logged in. Otherwise shows "Log in to upload ..." with an Open Account button.
export function requireLogin(what = 'content') {
  if (isLoggedIn()) return true;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Log in to upload">
      <div class="modal-title">Log in to upload</div>
      <div class="modal-body"><p>Log in to upload ${what} to the Recharge hub.</p></div>
      <div class="modal-actions">
        <button class="btn" data-act="cancel" type="button">Cancel</button>
        <button class="btn btn-primary" data-act="open" type="button">Open Account</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);
  overlay.querySelector('[data-act="open"]').addEventListener('click', () => { close(); openAccount(); });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  return false;
}

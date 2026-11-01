/** The topbar account chip, its menu, and the log in / register dialog. */
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { modal } from '../components/modal.js';
import { button } from '../components/button.js';
import { tabs } from '../components/tabs.js';
import { toast } from '../components/toast.js';
import { describeError } from '../bridge.js';
import { currentUser, onSession, refreshSession, signIn, signOut, signUp, validateCredentials, type Me } from './session.js';
import { authorName } from '../components/itemCard.js';
import { playerAvatar } from '../community/people.js';
import { profileRoute } from '../community/format.js';

export type AuthMode = 'login' | 'register';

/** Open the log in / register dialog. `done` runs after a successful sign-in. */
export function openAuthModal(initial: AuthMode = 'login', done?: (me: Me) => void): void {
  let mode: AuthMode = initial;
  const body = h('form', { className: 'auth-form', attrs: { novalidate: 'novalidate' } });

  const username = h('input', { className: 'input', attrs: { type: 'text', placeholder: 'Username', autocomplete: 'username', 'aria-label': 'Username', spellcheck: 'false' } });
  const password = h('input', { className: 'input', attrs: { type: 'password', placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' } });
  const error = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
  const hint = h('p', { className: 'dim auth-hint' });
  const submit = button('Log in', { kind: 'primary', type: 'submit' });

  const switcher = tabs([{ value: 'login', label: 'Log in' }, { value: 'register', label: 'Register' }], {
    value: mode,
    onChange: (value) => { mode = value as AuthMode; paint(); username.focus(); },
  });

  function paint(): void {
    const registering = mode === 'register';
    submit.querySelector('span')!.textContent = registering ? 'Create account' : 'Log in';
    password.setAttribute('autocomplete', registering ? 'new-password' : 'current-password');
    hint.textContent = registering
      ? 'Pick a username and a password of at least 4 characters. Your account lives on the Recharge hub.'
      : 'Use your Recharge hub account. Your login is remembered on this computer until you log out.';
    error.hidden = true;
  }

  let busy = false;
  body.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    const problem = validateCredentials(username.value, password.value, mode === 'register');
    if (problem) { error.textContent = problem; error.hidden = false; return; }
    busy = true;
    submit.disabled = true;
    error.hidden = true;
    const run = mode === 'register' ? signUp : signIn;
    run(username.value.trim(), password.value).then((me) => {
      closeModal();
      toast(mode === 'register' ? 'Welcome, ' + me.username + '.' : 'Logged in as ' + me.username + '.', 'success');
      if (done) done(me);
    }, (failure) => {
      error.textContent = describeError(failure);
      error.hidden = false;
      busy = false;
      submit.disabled = false;
      password.focus();
    });
  });

  body.appendChild(switcher);
  body.appendChild(username);
  body.appendChild(password);
  body.appendChild(error);
  body.appendChild(hint);
  const actions = h('div', { className: 'auth-actions' });
  actions.appendChild(submit);
  body.appendChild(actions);
  paint();

  const overlay = modal({ title: 'Your Recharge account', body, actions: [{ label: 'Cancel' }] });
  username.focus();
  function closeModal(): void {
    (overlay.querySelector('.modal-head .icon-btn') as HTMLElement | null)?.click();
  }
}

/** Turn the topbar button into the account chip and keep it in step with the session. */
export function initAccountChip(chip: HTMLElement): void {
  let menu: HTMLElement | null = null;

  function closeMenu(): void {
    if (menu) { menu.remove(); menu = null; }
    document.removeEventListener('mousedown', onAway, true);
    document.removeEventListener('keydown', onKey, true);
    chip.setAttribute('aria-expanded', 'false');
  }
  function onAway(event: Event): void {
    if (menu && !menu.contains(event.target as Node) && !chip.contains(event.target as Node)) closeMenu();
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.stopPropagation(); closeMenu(); chip.focus(); }
  }

  function openMenu(me: Me): void {
    closeMenu();
    menu = h('div', { className: 'account-menu', attrs: { role: 'menu' } });
    menu.appendChild(h('a', { className: 'account-item', attrs: { href: profileRoute(me.username), role: 'menuitem' }, text: 'Profile', on: { click: () => closeMenu() } }));
    menu.appendChild(h('button', {
      className: 'account-item', attrs: { type: 'button', role: 'menuitem' }, text: 'Log out',
      on: { click: () => { closeMenu(); signOut().then(() => toast('Logged out.', 'info'), (e) => toast(describeError(e), 'error')); } },
    }));
    document.body.appendChild(menu);
    const box = chip.getBoundingClientRect();
    menu.style.top = Math.round(box.bottom + 6) + 'px';
    menu.style.right = Math.max(8, Math.round(window.innerWidth - box.right)) + 'px';
    chip.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onAway, true);
    document.addEventListener('keydown', onKey, true);
    (menu.querySelector('.account-item') as HTMLElement).focus();
  }

  function paint(me: Me | null): void {
    closeMenu();
    chip.replaceChildren();
    chip.classList.toggle('is-signed-in', !!me);
    if (!me) {
      chip.title = 'Log in or register';
      chip.setAttribute('aria-label', 'Log in');
      chip.appendChild(h('span', { className: 'chip-avatar' }, icon('user', 20)));
      chip.appendChild(h('span', { className: 'chip-name', text: 'Log in' }));
      return;
    }
    chip.title = 'Signed in as ' + me.username;
    chip.setAttribute('aria-label', 'Account menu for ' + me.username);
    chip.appendChild(playerAvatar({
      username: me.username, avatar_url: typeof me.avatar_url === 'string' ? me.avatar_url : null,
      frame: me.frame || 'none', frame_colors: me.frame_colors || [], name_color: me.name_color ?? null,
    }, 28));
    chip.appendChild(authorName(me.username, me.name_color ?? null, 'chip-name'));
  }

  chip.setAttribute('aria-haspopup', 'true');
  chip.addEventListener('click', (event) => {
    event.preventDefault();
    const me = currentUser();
    if (!me) openAuthModal('login');
    else if (menu) closeMenu();
    else openMenu(me);
  });
  onSession(paint);
  paint(currentUser());
  void refreshSession();
}

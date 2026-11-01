import { h } from '../dom.js';
import { button } from '../components/button.js';
import { openAuthModal } from '../account/index.js';
import { currentUser, onSession } from '../account/session.js';
import { panel, row, type Section } from './ui.js';

export function accountSection(): Section {
  const who = h('span', { className: 'path-value', text: 'Not signed in' });
  const links = h('div', { className: 'settings-links' });
  const paint = (): void => {
    const me = currentUser();
    who.textContent = me ? 'Signed in as ' + me.username : 'Not signed in';
    links.replaceChildren();
    if (!me) {
      links.append(
        button('Log in', { kind: 'primary', icon: 'user', onClick: () => openAuthModal('login') }),
        button('Create an account', { kind: 'secondary', onClick: () => openAuthModal('register') })
      );
    } else {
      links.append(
        button('Your profile', { kind: 'primary', icon: 'user', onClick: () => { window.location.hash = '#/community/players/' + encodeURIComponent(me.username); } }),
        button('Community', { kind: 'secondary', icon: 'community', onClick: () => { window.location.hash = '#/community'; } })
      );
    }
  };
  paint();
  const off = onSession(paint);
  return { node: panel('Account', row('Account', 'Your Recharge hub account.', who), links), dispose: off };
}

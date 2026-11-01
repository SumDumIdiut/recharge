/** Friends & Messages: the two Community tabs. */
import { h } from '../dom.js';
import { emptyState } from '../components/emptyState.js';
import { openAuthModal } from '../account/index.js';
import { currentUser } from '../account/session.js';
import type { View } from '../community/forum.js';
import { friendsView } from './friends.js';
import { messagesView } from './messages.js';

export { friendsView, messagesView };

/** The social stylesheet, loaded the first time one of these tabs opens. */
export function ensureSocialStyles(): Promise<void> {
  if (document.querySelector('link[data-social]')) return Promise.resolve();
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'social/social.css';
    link.dataset.social = '1';
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });
}

/** The tab for signed-out visitors. */
export function signInView(what: string): View {
  const root = h('div', { className: 'social' });
  root.appendChild(emptyState('users', 'Sign in to use ' + what, 'Friends and messages come with your Recharge account.', {
    label: 'Sign in',
    onClick: () => openAuthModal('login'),
  }));
  return { element: root, ready: Promise.resolve() };
}

export function socialTab(tab: 'friends' | 'messages', withUser?: string): View {
  if (!currentUser()) return signInView(tab === 'friends' ? 'friends' : 'messages');
  return tab === 'friends' ? friendsView() : messagesView(withUser);
}

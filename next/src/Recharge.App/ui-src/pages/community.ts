import { pageTemplate } from '../components/page.js';
import { tabs } from '../components/tabs.js';
import { go } from '../navigation.js';
import { buildRoute } from '../router.js';
import type { PageModule, ParsedRoute } from '../router.js';
import { onSession, sessionReady } from '../account/session.js';
import { openAuthModal } from '../account/index.js';
import { forumList, type View } from '../community/forum.js';
import { threadView } from '../community/thread.js';
import { playersList } from '../community/players.js';
import { profileView } from '../community/profile.js';
import { ensureSocialStyles, socialTab } from '../social/index.js';
import { unreadBadge } from '../social/unread.js';

const TABS = [
  { value: 'forum', label: 'Forum', icon: 'forum' },
  { value: 'players', label: 'Players', icon: 'users' },
  { value: 'friends', label: 'Friends', icon: 'user' },
  { value: 'messages', label: 'Messages', icon: 'forum' },
];

let view: View | null = null;
let stopSession: (() => void) | null = null;
let stopBadge: (() => void) | null = null;

function viewFor(route: ParsedRoute, repaint: () => void): View {
  if (route.name === 'community-thread') return threadView(Number(route.params.id));
  if (route.name === 'community-profile') return profileView(route.params.username, repaint);
  if (route.params.tab === 'friends') return socialTab('friends');
  if (route.params.tab === 'messages') return socialTab('messages', route.params.user);
  return route.params.tab === 'players' ? playersList() : forumList();
}

const TITLES: Record<string, string> = {
  forum: 'Ask questions, report bugs and share ideas.',
  players: 'The people who make things for IGTAP.',
  friends: 'See who is online, and who wants to play.',
  messages: 'Talk to your friends.',
};

export const communityPage: PageModule = {
  title: 'Community',

  async mount(el, route): Promise<void> {
    const tab = ['players', 'friends', 'messages'].includes(route.params.tab) ? route.params.tab : 'forum';
    if (tab === 'friends' || tab === 'messages') await ensureSocialStyles();
    const page = pageTemplate({
      title: 'Community',
      subtitle: TITLES[tab],
      tabs: tabs(TABS, { value: tab, onChange: (value) => go(buildRoute('/community/' + value)) }),
    });
    el.appendChild(page);
    stopBadge?.();
    const messagesTab = el.querySelector('.tab[data-value="messages"]') as HTMLElement | null;
    stopBadge = messagesTab ? unreadBadge(messagesTab, 'tab-badge') : null;

    await sessionReady();

    let token = 0;
    const paint = (): Promise<void> => {
      const mine = ++token;
      view?.dispose?.();
      view = viewFor(route, () => { void paint(); });
      page.content.replaceChildren(view.element);
      return view.ready.then(() => { if (mine !== token) return; });
    };
    // Signing in or out changes what you can do (and see) on every page here, so repaint.
    stopSession?.();
    stopSession = onSession(() => { if (el.isConnected) void paint(); });

    if (route.query.login === '1') openAuthModal(route.query.mode === 'register' ? 'register' : 'login');
    await paint();
  },

  unmount(): void {
    stopBadge?.();
    stopBadge = null;
    stopSession?.();
    stopSession = null;
    view?.dispose?.();
    view = null;
  },

  filter(query: string): void {
    view?.filter?.(query);
  },
};

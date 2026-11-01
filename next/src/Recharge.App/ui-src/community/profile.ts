/** A player's profile page. Editing happens in Settings, Profile. */
import { h } from '../dom.js';
import { call, describeError } from '../bridge.js';
import { button } from '../components/button.js';
import { emptyState, errorState } from '../components/emptyState.js';
import { toast } from '../components/toast.js';
import { currentUser } from '../account/session.js';
import { HubError, hubJson } from './api.js';
import { normalizeProfile, safeHref, type Profile } from './format.js';
import { socialJson, userPath } from '../social/api.js';
import { go } from '../navigation.js';
import { extFromHub } from '../profile/hubmap.js';
import { renderProfile } from '../profile/page.js';
import { primeStyle } from '../profile/store.js';
import { sanitize, type Ext } from '../profile/schema.js';
import type { View } from './forum.js';

interface SocialProfile { profile?: unknown; restricted?: boolean; friendCount?: number; friends?: string[] }

function openLink(href: string): void {
  const safe = safeHref(href);
  if (safe) call('open.url', { url: safe }).catch((e) => toast(describeError(e), 'error'));
}

export function profileView(username: string, onChanged: () => void): View {
  void onChanged;
  const root = h('div', { className: 'profile-wrap' });
  let disposed = false;

  async function load(): Promise<void> {
    try {
      const [hubJsonReply, social] = await Promise.all([
        hubJson('GET', '/api/users/' + encodeURIComponent(username)),
        socialJson<SocialProfile>('GET', '/api/profile/' + userPath(username)).catch((): SocialProfile | null => null),
      ]);
      if (disposed) return;
      const profile = normalizeProfile(hubJsonReply);
      if (!profile) throw new Error('The hub sent something unexpected.');
      paint(profile, social);
    } catch (error) {
      if (disposed) return;
      root.replaceChildren(h('a', { className: 'back-link', attrs: { href: '#/community/players' }, text: '< All players' }));
      if (error instanceof HubError && error.status === 404) {
        root.appendChild(emptyState('user', 'No such player', 'There is nobody called "' + username + '".'));
      } else {
        root.appendChild(errorState('This profile could not be loaded (' + describeError(error) + ').', () => { void load(); }));
      }
    }
  }

  function paint(profile: Profile, social: SocialProfile | null): void {
    const me = currentUser();
    const isMe = !!me && me.username.toLowerCase() === profile.author.username.toLowerCase();
    const ext: Ext = social && social.profile ? sanitize(social.profile) : extFromHub(profile);
    if (isMe && social && social.profile) primeStyle(profile.author.username, { name: ext.name, avatar: ext.avatar, accent: ext.theme.accent });
    let actions: HTMLElement | null = null;
    if (isMe) actions = h('div', { className: 'profile-friend-actions' }, button('Edit profile', { kind: 'secondary', icon: 'sparkles', onClick: () => go('#/settings/profile') }));
    else if (me) actions = friendActions(profile.author.username);
    const page = renderProfile({
      hub: profile, ext, restricted: !!(social && social.restricted),
      friendCount: typeof social?.friendCount === 'number' ? social.friendCount : null,
      friends: Array.isArray(social?.friends) ? social!.friends!.filter((n) => typeof n === 'string') : [],
    }, { open: openLink, actions });
    root.replaceChildren(h('a', { className: 'back-link', attrs: { href: '#/community/players' }, text: '< All players' }), page);
  }

  return { element: root, ready: load(), dispose(): void { disposed = true; } };
}

type FriendLists = { friends?: Array<{ username: string }>; incoming?: Array<{ username: string }>; outgoing?: Array<{ username: string }>; blocked?: Array<{ username: string }> };

/** Add friend / Accept request / Request sent / Friends + Message, from the social server's friend lists. */
function friendActions(username: string): HTMLElement {
  const box = h('div', { className: 'profile-friend-actions' });
  const same = (a: string) => a.toLowerCase() === username.toLowerCase();
  const paint = (lists: FriendLists | null) => {
    box.replaceChildren();
    if (!lists) {
      box.appendChild(button('Add friend', { kind: 'primary', icon: 'plus', onClick: add }));
      return;
    }
    if (lists.blocked?.some((b) => same(b.username))) {
      box.appendChild(button('Blocked', { kind: 'secondary', disabled: true, title: 'Unblock them from Community, Friends' }));
    } else if (lists.friends?.some((f) => same(f.username))) {
      box.appendChild(button('Friends', { kind: 'secondary', icon: 'check', disabled: true }));
      box.appendChild(button('Message', { kind: 'primary', onClick: () => go('#/community/messages/' + encodeURIComponent(username)) }));
    } else if (lists.incoming?.some((r) => same(r.username))) {
      box.appendChild(button('Accept request', { kind: 'primary', icon: 'check', onClick: () => act('/api/friends/accept', 'You and ' + username + ' are friends') }));
    } else if (lists.outgoing?.some((r) => same(r.username))) {
      box.appendChild(button('Request sent', { kind: 'secondary', disabled: true }));
    } else {
      box.appendChild(button('Add friend', { kind: 'primary', icon: 'plus', onClick: add }));
    }
  };
  const refresh = () => socialJson<FriendLists>('GET', '/api/friends').then(paint, () => paint(null));
  const act = (path: string, done: string) => {
    socialJson<{ status?: string }>('POST', path, { username }).then(() => { toast(done, 'success'); return refresh(); },
      (error) => toast(describeError(error), 'error'));
  };
  function add(): void {
    socialJson<{ status?: string }>('POST', '/api/friends/request', { username }).then((reply) => {
      toast(reply.status === 'friends' ? 'You are now friends with ' + username : 'Request sent to ' + username, 'success');
      return refresh();
    }, (error) => toast(describeError(error), 'error'));
  }
  paint(null);
  void refresh();
  return box;
}

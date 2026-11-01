/** The friend list with presence, requests, add-by-username and blocks. */
import { h } from '../dom.js';
import { go } from '../navigation.js';
import { button } from '../components/button.js';
import { emptyState, errorState } from '../components/emptyState.js';
import { modal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { describeError } from '../bridge.js';
import { playerAvatar } from '../community/people.js';
import { authorName } from '../components/itemCard.js';
import { hubAuthor } from '../community/hubUsers.js';
import { profileRoute } from '../community/format.js';
import type { View } from '../community/forum.js';
import { socialJson, userPath } from './api.js';
import { feedConnected, openFeed, type FeedEvent } from './events.js';
import { isJoinable, messagesRoute, normalizeFriends, presenceLabel, stateOf, validateUsername, type Friend, type FriendsData } from './model.js';

/** The person's own picture and frame, at list size: the hub's record (picture, frame) with their profile look on top. */
function personAvatar(name: string): HTMLElement {
  const slot = h('span', { className: 'social-avatar' }, playerAvatar({ username: name, avatar_url: '/api/users/' + encodeURIComponent(name) + '/avatar', frame: 'none', frame_colors: [] }, 32));
  void hubAuthor(name).then((author) => {
    if (author && slot.isConnected) slot.replaceChildren(playerAvatar(author, 32));
  });
  return slot;
}

/** The name as a profile link, in the hub name colour, then in the person's own name style once their look is known. */
function personName(name: string): HTMLElement {
  const link = h('a', { className: 'social-name', attrs: { href: profileRoute(name) } }, authorName(name, null, 'author'));
  void hubAuthor(name).then((author) => {
    if (author && author.name_color && link.isConnected) link.replaceChildren(authorName(name, author.name_color, 'author'));
  });
  return link;
}

function presenceDot(friend: Friend): HTMLElement {
  return h('span', { className: 'presence-dot is-' + friend.state, title: presenceLabel(friend.state, friend.detail) });
}

export function friendsView(): View {
  const root = h('div', { className: 'social friends' });
  let data: FriendsData = { friends: [], incoming: [], outgoing: [], blocked: [] };
  let disposed = false;
  let loaded = false;
  let reload = 0;
  let sequence = 0;
  let showBlocked = false;

  const addError = h('p', { className: 'form-error', attrs: { role: 'alert' }, hidden: true });
  const input = h('input', { className: 'input', attrs: { type: 'text', placeholder: 'Add a friend by username', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Username' } });
  const send = button('Send request', { kind: 'primary', icon: 'plus', type: 'submit' });
  const form = h('form', { className: 'social-add' }, input, send);
  const status = h('span', { className: 'social-live dim' });
  const body = h('div', { className: 'social-body' });
  root.append(h('div', { className: 'social-bar' }, form, status), addError, body);

  function paintStatus(): void {
    const on = feedConnected();
    status.replaceChildren(h('span', { className: 'live-dot' + (on ? ' is-live' : '') }), on ? 'Live' : 'Connecting...');
  }

  async function act(label: string, run: () => Promise<unknown>, done?: string): Promise<void> {
    try {
      await run();
      if (done) toast(done, 'success');
      await load();
    } catch (error) {
      toast(label + ': ' + describeError(error), 'error');
    }
  }

  function row(friend: Friend): HTMLElement {
    const item = h('div', { className: 'social-row' });
    item.appendChild(personAvatar(friend.username));
    const text = h('div', { className: 'social-text' });
    text.appendChild(personName(friend.username));
    text.appendChild(h('div', { className: 'social-sub' }, presenceDot(friend), presenceLabel(friend.state, friend.detail)));
    item.appendChild(text);
    const actions = h('div', { className: 'social-actions' });
    if (isJoinable(friend.state, friend.join)) {
      actions.appendChild(button('Join', { kind: 'primary', icon: 'play', onClick: () => go(friend.state === 'lobby' ? '#/lobbies' : '#/maps') }));
    }
    actions.appendChild(button('Message', { icon: 'forum', onClick: () => go(messagesRoute(friend.username)) }));
    actions.appendChild(button('Remove', { kind: 'ghost', onClick: () => confirmThen('Remove ' + friend.username + '?', friend.username + ' will no longer see when you are online.', 'Remove', () => act('Could not remove', () => socialJson('DELETE', '/api/friends/' + userPath(friend.username)), 'Removed ' + friend.username)) }));
    actions.appendChild(button('Block', { kind: 'danger', onClick: () => confirmThen('Block ' + friend.username + '?', 'You will stop seeing each other everywhere: the friend list, presence and messages.', 'Block', () => act('Could not block', () => socialJson('POST', '/api/blocks', { username: friend.username }), 'Blocked ' + friend.username)) }));
    item.appendChild(actions);
    return item;
  }

  function confirmThen(title: string, text: string, label: string, run: () => void): void {
    modal({ title, body: text, actions: [{ label: 'Cancel', kind: 'secondary' }, { label, kind: 'danger', onClick: () => { run(); } }] });
  }

  function section(title: string, count: number, ...children: Node[]): HTMLElement {
    const box = h('section', { className: 'social-section' });
    box.appendChild(h('h2', { className: 'social-heading' }, title, h('span', { className: 'social-count', text: String(count) })));
    box.append(...children);
    return box;
  }

  function personRow(name: string, ...actions: HTMLElement[]): HTMLElement {
    const item = h('div', { className: 'social-row' });
    item.appendChild(personAvatar(name));
    item.appendChild(h('div', { className: 'social-text' }, personName(name)));
    item.appendChild(h('div', { className: 'social-actions' }, ...actions));
    return item;
  }

  function paint(): void {
    body.replaceChildren();
    if (data.incoming.length > 0) {
      body.appendChild(section('Requests', data.incoming.length, ...data.incoming.map((p) => personRow(p.username,
        button('Accept', { kind: 'primary', icon: 'check', onClick: () => void act('Could not accept', () => socialJson('POST', '/api/friends/accept', { username: p.username }), 'You and ' + p.username + ' are friends')} ),
        button('Decline', { kind: 'ghost', onClick: () => void act('Could not decline', () => socialJson('POST', '/api/friends/decline', { username: p.username })) })))));
    }
    if (data.outgoing.length > 0) {
      body.appendChild(section('Sent requests', data.outgoing.length, ...data.outgoing.map((p) => personRow(p.username,
        h('span', { className: 'dim', text: 'Waiting' }),
        button('Cancel', { kind: 'ghost', onClick: () => void act('Could not cancel', () => socialJson('DELETE', '/api/friends/' + userPath(p.username))) })))));
    }
    const online = data.friends.filter((f) => f.state !== 'offline').length;
    if (data.friends.length === 0) {
      body.appendChild(emptyState('users', 'No friends yet', 'Add someone by username above. They will see your request here.'));
    } else {
      const sorted = data.friends.slice().sort((a, b) => Number(b.state !== 'offline') - Number(a.state !== 'offline') || a.username.localeCompare(b.username));
      body.appendChild(section('Friends', data.friends.length, h('p', { className: 'dim social-note', text: online + ' online' }), ...sorted.map(row)));
    }
    if (data.blocked.length > 0) {
      const toggle = button(showBlocked ? 'Hide' : 'Show', { kind: 'ghost', onClick: () => { showBlocked = !showBlocked; paint(); } });
      const rows = showBlocked ? data.blocked.map((p) => personRow(p.username, button('Unblock', { onClick: () => void act('Could not unblock', () => socialJson('DELETE', '/api/blocks/' + userPath(p.username)), 'Unblocked ' + p.username) }))) : [];
      body.appendChild(section('Blocked', data.blocked.length, toggle, ...rows));
    }
  }

  async function load(): Promise<void> {
    const mine = ++sequence;
    try {
      const next = normalizeFriends(await socialJson('GET', '/api/friends'));
      if (disposed || mine !== sequence) return;
      data = next;
      loaded = true;
      paint();
    } catch (error) {
      if (disposed || mine !== sequence) return;
      if (!loaded) body.replaceChildren(errorState('Friends could not be loaded (' + describeError(error) + ').', () => { void load(); }));
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = input.value.trim();
    const problem = validateUsername(name);
    addError.hidden = !problem;
    addError.textContent = problem || '';
    if (problem) return;
    send.disabled = true;
    socialJson<{ status?: string }>('POST', '/api/friends/request', { username: name }).then((reply) => {
      input.value = '';
      toast(reply.status === 'friends' ? 'You are now friends with ' + name : 'Request sent to ' + name, 'success');
      return load();
    }).catch((error) => {
      addError.hidden = false;
      addError.textContent = describeError(error);
    }).finally(() => { send.disabled = false; });
  });

  const stop = openFeed((event: FeedEvent) => {
    if (disposed) return;
    if (event.type === 'presence') {
      const name = String(event.username || '');
      const friend = data.friends.find((f) => f.username.toLowerCase() === name.toLowerCase());
      if (friend) {
        friend.state = stateOf(event.state);
        friend.detail = String(event.detail || '');
        friend.join = String(event.join || '');
        paint();
      }
    } else if (event.type === 'friends' || event.type === 'reset' || event.type === 'connected') {
      window.clearTimeout(reload);
      reload = window.setTimeout(() => void load(), 150);
    }
    if (event.type === 'connected' || event.type === 'disconnected') paintStatus();
  });
  paintStatus();

  return {
    element: root,
    ready: load(),
    dispose(): void { disposed = true; window.clearTimeout(reload); stop(); },
  };
}

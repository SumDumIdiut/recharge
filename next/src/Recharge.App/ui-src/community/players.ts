/** The player directory. */
import { h } from '../dom.js';
import { emptyState, errorState } from '../components/emptyState.js';
import { describeError } from '../bridge.js';
import { hubJson } from './api.js';
import { monthYear, normalizePlayers, profileRoute, uploadsSummary, type Player } from './format.js';
import { playerAvatar } from './people.js';
import { authorName } from '../components/itemCard.js';
import type { View } from './forum.js';

function playerCard(player: Player): HTMLElement {
  const card = h('a', { className: 'player-card', attrs: { href: profileRoute(player.author.username), 'aria-label': player.author.username } });
  card.appendChild(playerAvatar(player.author, 64));
  const body = h('div', { className: 'player-body' });
  body.appendChild(authorName(player.author.username, player.author.name_color, 'player-name'));
  const made = uploadsSummary(player.uploads);
  body.appendChild(h('div', { className: made ? 'player-made' : 'player-made dim', text: made || 'Nothing published yet' }));
  const joined = monthYear(player.createdAt);
  if (joined) body.appendChild(h('div', { className: 'dim', text: 'Joined ' + joined }));
  card.appendChild(body);
  return card;
}

export function playersList(): View {
  const root = h('div', { className: 'players' });
  const note = h('p', { className: 'dim players-note' });
  const grid = h('div', { className: 'player-grid' });
  root.append(note, grid);
  let query = '';
  let sequence = 0;
  let disposed = false;
  let timer = 0;

  async function load(): Promise<void> {
    const mine = ++sequence;
    try {
      const path = '/api/users' + (query ? '?q=' + encodeURIComponent(query) : '');
      const { players, total } = normalizePlayers(await hubJson('GET', path));
      if (disposed || mine !== sequence) return;
      grid.replaceChildren();
      if (players.length === 0) {
        grid.appendChild(emptyState('users', 'No players found', query ? 'No one has a name that matches "' + query + '".' : 'Nobody has signed up yet.'));
        note.textContent = '';
        return;
      }
      for (const player of players) grid.appendChild(playerCard(player));
      note.textContent = query
        ? players.length + ' of ' + total + ' players match'
        : players.length < total ? 'Showing ' + players.length + ' of ' + total + ' players. Search to find someone else.' : total + (total === 1 ? ' player' : ' players');
    } catch (error) {
      if (disposed || mine !== sequence) return;
      grid.replaceChildren(errorState('The players could not be loaded (' + describeError(error) + ').', () => { void load(); }));
    }
  }

  return {
    element: root,
    ready: load(),
    filter(text: string): void {
      window.clearTimeout(timer);
      const value = text.trim().slice(0, 40);
      if (value === query) return;
      timer = window.setTimeout(() => { query = value; void load(); }, 150);
    },
    dispose(): void { disposed = true; window.clearTimeout(timer); },
  };
}


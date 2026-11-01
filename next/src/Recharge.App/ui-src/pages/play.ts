import { h } from '../dom.js';
import { icon } from '../icons.js';
import { call, describeError } from '../bridge.js';
import { go } from '../navigation.js';
import { pageTemplate } from '../components/page.js';
import { emptyState } from '../components/emptyState.js';

export interface PlayRouteParams {
  map: string;
  modded: string;
}

export const playPage = {
  title: 'Launching…',

  mount(el: HTMLElement, route: { params: PlayRouteParams; query: Record<string, string> }): void {
    const page = pageTemplate({ title: 'Launching…' });
    const mapFolder = route.params.map;
    const modded = route.params.modded === 'true';

    const status = h('div', { className: 'play-status' });
    status.appendChild(icon('gamepad', 30));
    status.appendChild(h('h2', { className: 'play-title', text: 'Launching IGTAP…' }));
    const detail = h('p', { className: 'play-detail', text: 'Loading map ' + mapFolder + '.' });
    status.appendChild(detail);
    page.content.appendChild(status);
    el.appendChild(page);

    // Launch the game with the play.map intent, which loads the map once the game connects.
    void call('game.launch', {
      intent: { kind: 'play.map', args: { folder: mapFolder } },
      modded,
    }).then((reply: unknown) => {
      const r = reply as { launched?: boolean; error?: string };
      if (r.launched === false) {
        detail.textContent = 'IGTAP is already running - sending map load…';
      } else {
        detail.textContent = 'Map loading…';
      }
    }, (error: unknown) => {
      const msg = describeError(error);
      page.content.replaceChildren(
        emptyState('alert', 'Could not launch the game', msg, {
          label: 'Go home',
          kind: 'primary',
          onClick: () => go('#/home'),
        })
      );
    });
  },

  unmount(): void {
    // Nothing to clean up.
  },
};

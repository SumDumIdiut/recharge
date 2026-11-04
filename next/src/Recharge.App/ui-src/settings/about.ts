import { h } from '../dom.js';
import { call, describeError, type AppInfo } from '../bridge.js';
import { panel, type Section } from './ui.js';

export function aboutSection(): Section {
  const list = h('dl', { className: 'about-list' });
  const add = (label: string, value: string): void => {
    list.appendChild(h('dt', { text: label }));
    list.appendChild(h('dd', { text: value }));
  };
  const node = panel('About', list);
  add('App', '…');
  void call<AppInfo>('app.info').then(
    (info) => {
      list.replaceChildren();
      add('App', info.name || 'Recharge');
      add('Version', info.version || 'unknown');
      add('.NET', info.dotnet || 'unknown');
      add('Web engine', info.engine || 'unknown');
    },
    (error) => {
      list.replaceChildren();
      add('App', 'unavailable (' + describeError(error) + ')');
    }
  );
  node.appendChild(h('p', { className: 'credits', text: 'Recharge by Flipped and contributors. Thanks to everyone who makes maps, mods and skins.' }));
  return { node };
}

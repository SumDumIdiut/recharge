import { h } from '../dom.js';

/** Placeholder cards shown while real library data is on its way. */
export function skeletonCards(n = 8): HTMLElement {
  const root = h('div', {
    className: 'card-grid skeleton-grid',
    attrs: { 'aria-busy': 'true', 'aria-label': 'Loading items' },
  });
  for (let index = 0; index < n; index += 1) {
    const card = h('div', { className: 'skeleton-card', attrs: { 'aria-hidden': 'true' } });
    card.appendChild(h('div', { className: 'skeleton-media' }));
    card.appendChild(h('div', { className: 'skeleton-line skeleton-line-lg' }));
    card.appendChild(h('div', { className: 'skeleton-line' }));
    root.appendChild(card);
  }
  return root;
}

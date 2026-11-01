import { h } from '../dom.js';
import { icon } from '../icons.js';
import { button, type ButtonKind } from './button.js';

export interface EmptyAction {
  label: string;
  kind?: ButtonKind;
  onClick: () => void;
}

/** A friendly empty state with a hand-drawn icon and an optional action. */
export function emptyState(
  iconName: string,
  title: string,
  text: string,
  action?: EmptyAction
): HTMLElement {
  const root = h('div', { className: 'empty-state' });
  const badge = h('div', { className: 'empty-icon' });
  badge.appendChild(icon(iconName, 30));
  root.appendChild(badge);
  root.appendChild(h('h2', { className: 'empty-title', text: title }));
  root.appendChild(h('p', { className: 'empty-text', text }));
  if (action) {
    root.appendChild(
      button(action.label, {
        kind: action.kind || 'primary',
        onClick: action.onClick,
      })
    );
  }
  return root;
}

/** An error state with a retry button. */
export function errorState(text: string, retry: () => void): HTMLElement {
  const root = h('div', { className: 'empty-state error-state' });
  const badge = h('div', { className: 'empty-icon' });
  badge.appendChild(icon('alert', 30));
  root.appendChild(badge);
  root.appendChild(h('h2', { className: 'empty-title', text: 'Something went wrong' }));
  root.appendChild(h('p', { className: 'empty-text', text }));
  root.appendChild(button('Try again', { kind: 'secondary', icon: 'refresh', onClick: retry }));
  return root;
}

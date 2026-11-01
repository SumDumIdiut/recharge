import { h } from '../dom.js';
import { icon } from '../icons.js';

export type ToastKind = 'info' | 'success' | 'error';

function container(): HTMLElement {
  let existing = document.getElementById('toast-container');
  if (existing) return existing;
  const root = h('div', {
    className: 'toast-container',
    attrs: { id: 'toast-container', 'aria-live': 'polite', 'aria-atomic': 'false' },
  });
  document.body.appendChild(root);
  return root;
}

/** A short-lived message at the bottom right. */
export function toast(text: string, kind: ToastKind = 'info'): HTMLElement {
  const node = h('div', {
    className: 'toast toast-' + kind,
    attrs: { role: 'status' },
  });
  node.appendChild(icon(kind === 'success' ? 'check' : kind === 'error' ? 'alert' : 'sparkles', 18));
  node.appendChild(h('span', { className: 'toast-text', text }));
  let timer = 0;
  const dismiss = () => {
    window.clearTimeout(timer);
    if (node.parentNode) node.parentNode.removeChild(node);
  };
  node.addEventListener('click', dismiss);
  container().appendChild(node);
  timer = window.setTimeout(dismiss, 4200);
  return node;
}

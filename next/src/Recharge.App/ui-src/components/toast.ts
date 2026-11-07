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

/** A short-lived message at the bottom right. Pass `onClick` to make it act on a click (it still dismisses). */
export function toast(text: string, kind: ToastKind = 'info', onClick?: () => void): HTMLElement {
  const node = h('div', {
    className: 'toast toast-' + kind + (onClick ? ' toast-clickable' : ''),
    attrs: { role: 'status' },
  });
  node.appendChild(icon(kind === 'success' ? 'check' : kind === 'error' ? 'alert' : 'sparkles', 18));
  node.appendChild(h('span', { className: 'toast-text', text }));
  let timer = 0;
  const dismiss = () => {
    window.clearTimeout(timer);
    if (node.parentNode) node.parentNode.removeChild(node);
  };
  node.addEventListener('click', () => { if (onClick) { try { onClick(); } catch (e) { console.error('toast action failed', e); } } dismiss(); });
  container().appendChild(node);
  timer = window.setTimeout(dismiss, onClick ? 6000 : 4200);
  return node;
}

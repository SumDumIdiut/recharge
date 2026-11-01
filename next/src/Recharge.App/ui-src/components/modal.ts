import { h } from '../dom.js';
import { icon } from '../icons.js';
import { button, type ButtonKind } from './button.js';

export interface ModalAction {
  label: string;
  kind?: ButtonKind;
  /** Return false to keep the modal open. */
  onClick?: () => boolean | void;
}

export interface ModalOptions {
  title: string;
  body: Node | string;
  actions?: ModalAction[];
  onClose?: () => void;
}

const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled]):not(.dd-native)',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** A modal dialog with a focus trap, Esc to close, and a click-away backdrop. */
export function modal(options: ModalOptions): HTMLElement {
  const previous = document.activeElement as HTMLElement | null;
  const overlay = h('div', { className: 'modal-overlay', attrs: { role: 'presentation' } });
  const dialog = h('div', {
    className: 'modal',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title, tabindex: '-1' },
  });

  const head = h('div', { className: 'modal-head' });
  head.appendChild(h('h2', { className: 'modal-title', text: options.title }));
  const close = h('button', {
    className: 'icon-btn',
    title: 'Close',
    attrs: { type: 'button', 'aria-label': 'Close dialog' },
  });
  close.appendChild(icon('x', 18));
  head.appendChild(close);
  dialog.appendChild(head);

  const body = h('div', { className: 'modal-body' });
  if (typeof options.body === 'string') body.textContent = options.body;
  else body.appendChild(options.body);
  dialog.appendChild(body);

  const actions = h('div', { className: 'modal-actions' });
  function dismiss(): void {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.removeEventListener('keydown', onKey, true);
    if (options.onClose) options.onClose();
    if (previous && previous.focus) previous.focus();
  }

  function actionButton(action: ModalAction): HTMLElement {
    return button(action.label, {
      kind: action.kind || 'secondary',
      onClick: () => {
        const keep = action.onClick ? action.onClick() === false : false;
        if (!keep) dismiss();
      },
    });
  }

  if (options.actions && options.actions.length > 0) {
    for (const action of options.actions) actions.appendChild(actionButton(action));
  } else {
    actions.appendChild(actionButton({ label: 'Close' }));
  }
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  close.addEventListener('click', dismiss);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) dismiss();
  });

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(dialog.querySelectorAll(FOCUSABLE)) as HTMLElement[];
    if (items.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  const initial = dialog.querySelector(FOCUSABLE) as HTMLElement | null;
  (initial || dialog).focus();
  return overlay;
}

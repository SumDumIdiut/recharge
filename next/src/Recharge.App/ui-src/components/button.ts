import { h } from '../dom.js';
import { icon } from '../icons.js';

export type ButtonKind = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonOptions {
  kind?: ButtonKind;
  icon?: string;
  title?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
  onClick?: (event: MouseEvent) => void;
}

/** A small button in one of the four app styles. */
export function button(label: string, options: ButtonOptions = {}): HTMLButtonElement {
  const button = h('button', {
    className: 'btn btn-' + (options.kind || 'secondary'),
    attrs: {
      type: options.type || 'button',
      ...(options.title ? { title: options.title } : {}),
      ...(options.disabled ? { disabled: 'disabled' } : {}),
    },
  });
  if (options.icon) button.appendChild(icon(options.icon, 18));
  button.appendChild(h('span', { text: label }));
  if (options.onClick) button.addEventListener('click', options.onClick);
  return button;
}

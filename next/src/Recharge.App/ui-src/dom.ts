export type ElementOptions = {
  className?: string;
  text?: string;
  title?: string;
  hidden?: boolean;
  attrs?: Record<string, string>;
  dataset?: Record<string, string>;
  on?: Record<string, EventListener>;
};

type Child = Node | string | number | null | undefined | false;

/**
 * Build an element without innerHTML. Strings become text nodes, so all
 * user-provided data stays inert. Attributes are set explicitly.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options?: ElementOptions,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options) {
    if (options.className) element.className = options.className;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.title !== undefined) element.title = options.title;
    if (options.hidden) element.hidden = true;
    if (options.attrs) {
      for (const [name, value] of Object.entries(options.attrs)) {
        element.setAttribute(name, value);
      }
    }
    if (options.dataset) {
      for (const [name, value] of Object.entries(options.dataset)) {
        element.dataset[name] = value;
      }
    }
    if (options.on) {
      for (const [name, listener] of Object.entries(options.on)) {
        element.addEventListener(name, listener);
      }
    }
  }
  append(element, children);
  return element;
}

export function append(parent: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(element: HTMLElement): void {
  while (element.firstChild) element.removeChild(element.firstChild);
}

export function iconButton(label: string, children: Node | Node[], onClick: () => void, className = ''): HTMLButtonElement {
  const button = h('button', {
    className: 'icon-btn ' + className,
    title: label,
    attrs: { type: 'button', 'aria-label': label },
  });
  if (Array.isArray(children)) {
    for (const child of children) button.appendChild(child);
  } else {
    button.appendChild(children);
  }
  button.addEventListener('click', onClick);
  return button;
}

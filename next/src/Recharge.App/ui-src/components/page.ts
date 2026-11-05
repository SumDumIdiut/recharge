import { h } from '../dom.js';
import { icon } from '../icons.js';

export interface PageTemplateOptions {
  title: string;
  subtitle?: string;
  actions?: Node[];
  tabs?: HTMLElement;
  filters?: HTMLElement;
  sidePanel?: HTMLElement;
  onPanelClose?: () => void;
}

export interface PageTemplateElement extends HTMLElement {
  content: HTMLElement;
  panelSlot: HTMLElement;
  setSidePanel(panel: HTMLElement | null): void;
}

/**
 * The shared page frame: a solid sticky bar (green title, actions, optional tabs and filters), the
 * content area, and an optional 380 px side panel.
 */
export function pageTemplate(options: PageTemplateOptions): PageTemplateElement {
  const root = document.createElement('article') as PageTemplateElement;
  root.className = 'page-template';

  const bar = h('div', { className: 'page-bar' });
  const header = h('header', { className: 'page-head' });
  const titles = h('div', { className: 'page-titles' });
  titles.appendChild(h('h1', { className: 'page-title', text: options.title }));
  // Pages pass a subtitle, but the header shows the title alone (kept compact, as asked); screen readers still get it.
  if (options.subtitle) root.setAttribute('aria-description', options.subtitle);
  header.appendChild(titles);

  // Tabs share the title row, so the bar stays one line high; narrow windows wrap them below.
  if (options.tabs) {
    const row = h('div', { className: 'page-tabs' });
    row.appendChild(options.tabs);
    header.appendChild(row);
  }

  const actionRow = h('div', { className: 'page-actions' });
  for (const action of options.actions || []) actionRow.appendChild(action);
  if (actionRow.childNodes.length > 0) header.appendChild(actionRow);
  bar.appendChild(header);

  if (options.filters) {
    const row = h('div', { className: 'page-filters' });
    row.appendChild(options.filters);
    bar.appendChild(row);
  }
  root.appendChild(bar);

  // The sticky side panel sits below the bar: publish the bar's height as a variable.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => root.style.setProperty('--page-bar-h', bar.offsetHeight + 'px')).observe(bar);
  }

  const body = h('div', { className: 'page-body' });
  const content = h('div', { className: 'page-content' });
  body.appendChild(content);

  const panelSlot = h('aside', { className: 'page-panel', attrs: { 'aria-label': 'Details' } });
  panelSlot.hidden = true;
  body.appendChild(panelSlot);
  root.appendChild(body);

  root.content = content;
  root.panelSlot = panelSlot;
  root.setSidePanel = (panel: HTMLElement | null) => {
    if (!panel) {
      panelSlot.hidden = true;
      panelSlot.replaceChildren();
      root.classList.remove('has-panel');
      return;
    }
    panelSlot.replaceChildren();
    const close = h('button', {
      className: 'btn btn-secondary panel-close',
      title: 'Back to the list (Esc)',
      attrs: { type: 'button', 'aria-label': 'Back to the list' },
    });
    close.appendChild(icon('chevron-left', 18));
    close.appendChild(h('span', { text: 'Back' }));
    close.addEventListener('click', () => {
      if (options.onPanelClose) options.onPanelClose();
      else root.setSidePanel(null);
    });
    panelSlot.appendChild(close);
    panelSlot.appendChild(panel);
    panelSlot.hidden = false;
    root.classList.add('has-panel');
    const focusable = panelSlot.querySelector('button, [href], input, select, textarea') as HTMLElement | null;
    if (focusable) focusable.focus();
  };

  if (options.sidePanel) root.setSidePanel(options.sidePanel);

  root.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !root.classList.contains('has-panel')) return;
    event.preventDefault();
    event.stopPropagation();
    if (options.onPanelClose) options.onPanelClose();
    else root.setSidePanel(null);
  });

  return root;
}

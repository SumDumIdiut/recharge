/** "Source code on GitHub": a button on a mod's page that opens its repository in the browser. */
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { call, describeError } from '../bridge.js';
import { button } from './button.js';
import { toast } from './toast.js';
import { githubRepoUrl, repoLabel } from '../lib/sourceUrl.js';
import type { Item } from '../lib/library.js';

/** The repository address to show for an item: only mods carry one, and only a valid github.com address counts. */
export function sourceUrlOf(item: Pick<Item, 'kind' | 'sourceUrl'>): string | null {
  return item.kind === 'mods' ? githubRepoUrl(item.sourceUrl) : null;
}

/** The button, or null when the item has no source repository. */
export function sourceCodeLink(item: Pick<Item, 'kind' | 'sourceUrl'>): HTMLElement | null {
  const url = sourceUrlOf(item);
  if (!url) return null;
  const link = button('Source code on GitHub', {
    kind: 'secondary',
    icon: 'github',
    title: repoLabel(url),
    onClick: () => { call('open.url', { url }).catch((error) => toast(describeError(error), 'error')); },
  });
  link.classList.add('detail-source');
  return link;
}

function openRepo(url: string): void {
  call('open.url', { url }).catch((error) => toast(describeError(error), 'error'));
}

/**
 * A small clickable GitHub symbol for a mod with a source repository (cards and the item's title row), or null. Cards are links
 * themselves, so the click opens the repository and goes no further.
 */
export function sourceBadge(item: Pick<Item, 'kind' | 'sourceUrl'>, size = 16): HTMLElement | null {
  const url = sourceUrlOf(item);
  if (!url) return null;
  const mark = h('button', { className: 'source-badge', attrs: { type: 'button', 'aria-label': 'Source code on GitHub: ' + repoLabel(url) }, title: 'Source code on GitHub: ' + repoLabel(url) });
  mark.appendChild(icon('github', size));
  mark.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); openRepo(url); });
  return mark;
}

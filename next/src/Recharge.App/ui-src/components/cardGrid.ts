import { h } from '../dom.js';

/** A fixed-ratio image box. The real src is attached when the card scrolls near. */
export function lazyImage(src: string, alt: string, ratio = '16 / 9'): HTMLElement {
  const box = h('div', { className: 'media-box' });
  box.style.aspectRatio = ratio;
  const image = h('img', {
    attrs: {
      alt,
      decoding: 'async',
      loading: 'lazy',
    },
  });
  image.dataset.src = src;
  box.appendChild(image);
  return box;
}

type LazyImage = HTMLImageElement & { dataset: DOMStringMap };

function attachLazy(root: HTMLElement): void {
  const images = Array.from(root.querySelectorAll('img[data-src]')) as LazyImage[];
  if (images.length === 0) return;

  if (typeof IntersectionObserver === 'undefined') {
    for (const image of images) load(image);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const image = entry.target as LazyImage;
        load(image);
        observer.unobserve(image);
      }
    },
    { root: null, rootMargin: '240px 0px', threshold: 0.01 }
  );
  for (const image of images) observer.observe(image);
}

function load(image: LazyImage): void {
  const src = image.dataset.src;
  if (!src) return;
  delete image.dataset.src;
  image.addEventListener('error', () => image.classList.add('is-broken'), { once: true });
  image.src = src;
}

export interface CardGridOptions {
  minWidth?: number;
  chunk?: number;
  empty?: HTMLElement;
}

/**
 * A responsive card grid that appends about 60 cards per frame and loads
 * images lazily, so a thousand results do not block the window.
 */
export function cardGrid<T>(
  items: T[],
  renderCard: (item: T, index: number) => HTMLElement,
  options: CardGridOptions = {}
): HTMLElement {
  const root = h('div', { className: 'card-grid' });
  root.style.setProperty('--card-min', (options.minWidth || 220) + 'px');

  if (items.length === 0) {
    if (options.empty) root.appendChild(options.empty);
    return root;
  }

  const size = options.chunk || 60;
  let index = 0;

  function frame(): void {
    if (index >= items.length) return;
    if (!root.isConnected && index > 0) return;
    const end = Math.min(items.length, index + size);
    const fragment = document.createDocumentFragment();
    for (; index < end; index += 1) {
      const card = renderCard(items[index], index);
      attachLazy(card);
      fragment.appendChild(card);
    }
    root.appendChild(fragment);
    if (index < items.length) requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
  return root;
}

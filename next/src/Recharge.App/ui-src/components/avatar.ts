import { h } from '../dom.js';

/** Round initials avatar, or an image when a URL is available. */
export function avatar(name: string, color: string, url?: string): HTMLElement {
  const root = h('span', {
    className: 'avatar',
    title: name,
    attrs: { role: 'img', 'aria-label': name },
  });
  if (url) {
    const image = h('img', { attrs: { src: url, alt: name, decoding: 'async', loading: 'lazy' } });
    image.addEventListener('error', () => {
      image.remove();
      root.textContent = initials(name);
    });
    root.appendChild(image);
  } else {
    root.textContent = initials(name);
  }
  root.style.setProperty('--avatar-color', color);
  return root;
}

function initials(name: string): string {
  const parts = String(name || '?')
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return '?';
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
  return (first + last).toUpperCase();
}

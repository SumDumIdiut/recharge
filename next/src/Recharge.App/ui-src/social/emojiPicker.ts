/** Reusable emoji popover: category tabs, custom-art tab with upload, caret-safe pick callback. */
import { h } from '../dom.js';
import { CUSTOM_EMOJIS, EMOJI_CATEGORIES, onCustomEmojis, setCustomEmojis, type CustomEmoji } from './emojis.js';
import { listEmojis, uploadEmoji } from './api.js';

const SHORT_RE = /^[a-z0-9_]{2,32}$/;
const EMOJI_TYPES = ['image/png', 'image/gif', 'image/webp'];
const EMOJI_MAX = 256 * 1024;

export interface EmojiPopover {
  button: HTMLButtonElement;
  open(anchor?: HTMLElement): void;
  close(returnFocus?: boolean): void;
  isOpen(): boolean;
  dispose(): void;
}

let active: EmojiPopover | null = null;
let seq = 0;

export function emojiPopover(onPick: (value: string, custom?: CustomEmoji) => void, label = 'Choose emoji'): EmojiPopover {
  const uid = 'emoji-' + (++seq);
  const names = [...EMOJI_CATEGORIES.map((c) => c.name), 'Custom'];
  let tabName = names[0] || 'Custom';
  let anchor: HTMLElement | null = null;
  let opened = false;

  const button = h('button', {
    className: 'emoji-btn',
    title: label,
    attrs: { type: 'button', 'aria-label': label, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
  }, h('span', { attrs: { 'aria-hidden': 'true' }, text: '🙂' }));

  const tabs = h('div', { className: 'emoji-tabs', attrs: { role: 'tablist', 'aria-label': 'Emoji categories' } });
  const grid = h('div', { className: 'emoji-grid', attrs: { id: uid + '-grid', role: 'group' } });
  const fileInput = h('input', { className: 'emoji-upload-file', attrs: { type: 'file', accept: 'image/png,image/gif,image/webp', 'aria-label': 'Emoji image (PNG, GIF or WebP, up to 256 KB)' } });
  const shortInput = h('input', { className: 'input emoji-upload-short', attrs: { type: 'text', placeholder: 'shortcode', maxlength: '32', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Emoji shortcode (2-32 letters, numbers or underscores)' } });
  const addBtn = h('button', { className: 'btn emoji-upload-add', text: 'Add', attrs: { type: 'button' } });
  const note = h('p', { className: 'emoji-upload-msg', attrs: { role: 'alert' }, hidden: true });
  const uploadBox = h('div', { className: 'emoji-upload', attrs: { 'aria-label': 'Upload a custom emoji' } },
    h('div', { className: 'emoji-upload-title', text: 'Upload emoji' }),
    h('div', { className: 'emoji-upload-row' }, fileInput),
    h('div', { className: 'emoji-upload-row' }, shortInput, addBtn),
    note);
  const panel = h('div', { className: 'emoji-pop', attrs: { role: 'dialog', 'aria-label': label }, hidden: true }, tabs, grid, uploadBox);
  document.body.appendChild(panel);

  const tabButtons = new Map<string, HTMLButtonElement>();

  function pickerValue(custom: CustomEmoji): string { return ':' + custom.shortcode + ':'; }

  function renderGrid(): void {
    grid.replaceChildren();
    grid.setAttribute('aria-label', tabName + ' emoji');
    uploadBox.hidden = tabName !== 'Custom';
    if (tabName === 'Custom') {
      if (CUSTOM_EMOJIS.length === 0) {
        grid.appendChild(h('p', { className: 'emoji-empty dim', text: 'No custom emoji yet' }));
        return;
      }
      for (const custom of CUSTOM_EMOJIS) {
        const value = pickerValue(custom);
        const item = h('button', {
          className: 'emoji-item emoji-item-custom',
          title: value,
          attrs: { type: 'button', 'aria-label': value },
        }, h('img', { attrs: { src: custom.url, alt: '', decoding: 'async' } }));
        item.addEventListener('click', () => pick(value, custom));
        grid.appendChild(item);
      }
      return;
    }
    const category = EMOJI_CATEGORIES.find((c) => c.name === tabName);
    for (const value of category ? category.emojis : []) {
      const item = h('button', {
        className: 'emoji-item',
        title: value,
        attrs: { type: 'button', 'aria-label': value },
      }, h('span', { attrs: { 'aria-hidden': 'true' }, text: value }));
      item.addEventListener('click', () => pick(value));
      grid.appendChild(item);
    }
  }

  function select(name: string, focusTab = false): void {
    tabName = name;
    for (const [key, tab] of tabButtons) {
      const on = key === name;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    renderGrid();
    if (focusTab) tabButtons.get(name)?.focus();
  }

  names.forEach((name, i) => {
    const tab = h('button', {
      className: 'emoji-tab',
      attrs: { type: 'button', role: 'tab', id: uid + '-tab-' + i, 'aria-controls': uid + '-grid' },
      text: name,
    });
    tab.addEventListener('click', () => select(name));
    tab.addEventListener('keydown', (event: KeyboardEvent) => {
      const at = names.indexOf(name);
      let next = at;
      if (event.key === 'ArrowRight') next = (at + 1) % names.length;
      else if (event.key === 'ArrowLeft') next = (at - 1 + names.length) % names.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = names.length - 1;
      else return;
      event.preventDefault();
      select(names[next], true);
    });
    tabButtons.set(name, tab);
    tabs.appendChild(tab);
  });
  select(tabName);

  function place(a: HTMLElement): void {
    const r = a.getBoundingClientRect();
    panel.hidden = false;
    const pw = panel.offsetWidth || 320;
    const ph = panel.offsetHeight || 280;
    let left = r.left;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (left < 8) left = 8;
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
  }

  function pick(value: string, custom?: CustomEmoji): void {
    onPick(value, custom);
    close();
  }

  function say(text: string, good = false): void {
    note.textContent = text;
    note.classList.toggle('is-good', good);
    note.hidden = !text;
  }

  async function addCustom(): Promise<void> {
    const sc = shortInput.value.trim().toLowerCase();
    const file = fileInput.files?.[0];
    if (!SHORT_RE.test(sc)) { say('Shortcode: 2-32 letters, numbers or underscores.'); shortInput.focus(); return; }
    if (!file) { say('Choose a PNG, GIF or WebP image first.'); fileInput.focus(); return; }
    if (!EMOJI_TYPES.includes(file.type)) { say('Only PNG, GIF and WebP images are accepted.'); fileInput.focus(); return; }
    if (file.size > EMOJI_MAX) { say('Images must be 256 KB or less.'); fileInput.focus(); return; }
    addBtn.disabled = true;
    say('Uploading...');
    try {
      await uploadEmoji(sc, file);
      setCustomEmojis(await listEmojis());   // refresh the shared set for this picker and all open views
      fileInput.value = '';
      shortInput.value = '';
      say('Added :' + sc + ':', true);
    } catch (err) {
      say(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      addBtn.disabled = false;
    }
  }

  addBtn.addEventListener('click', () => void addCustom());
  shortInput.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') { event.preventDefault(); void addCustom(); }
  });
  fileInput.addEventListener('change', () => { note.hidden = true; });
  const offEmojiChanges = onCustomEmojis(() => { if (opened) select(tabName); });

  const api: EmojiPopover = {
    button,
    open(a: HTMLElement = button): void {
      if (active && active !== api) active.close();
      if (anchor && anchor !== a) anchor.setAttribute('aria-expanded', 'false');
      anchor = a;
      a.setAttribute('aria-haspopup', 'dialog');
      a.setAttribute('aria-expanded', 'true');
      opened = true;
      active = api;
      select(tabName);
      place(a);
      const first = grid.querySelector<HTMLElement>('.emoji-item') || tabButtons.get(tabName);
      first?.focus();
    },
    close(returnFocus = false): void {
      if (!opened) return;
      opened = false;
      panel.hidden = true;
      if (active === api) active = null;
      if (anchor) anchor.setAttribute('aria-expanded', 'false');
      if (returnFocus) anchor?.focus();
    },
    isOpen(): boolean { return opened; },
    dispose(): void {
      api.close();
      offEmojiChanges();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      panel.remove();
    },
  };

  function onPointerDown(event: PointerEvent): void {
    if (!opened) return;
    const target = event.target as Node | null;
    if (target && (panel.contains(target) || (anchor && anchor.contains(target)))) return;
    api.close();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (opened && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      api.close(true);
    }
  }

  button.addEventListener('click', () => { if (opened) api.close(true); else api.open(button); });
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  return api;
}

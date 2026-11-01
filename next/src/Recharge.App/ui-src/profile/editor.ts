/** The Settings, Profile tab: controls on the left, the live profile on the right. */
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { describeError } from '../bridge.js';
import { button } from '../components/button.js';
import { modal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { openAuthModal } from '../account/index.js';
import { currentUser, onSession, refreshSession } from '../account/session.js';
import { hubJson } from '../community/api.js';
import { normalizeProfile, type Profile } from '../community/format.js';
import { playerAvatar } from '../community/people.js';
import { socialJson, userPath } from '../social/api.js';
import { nameStyle } from '../lib/library.js';
import { panel, type Section } from '../settings/ui.js';
import { go } from '../navigation.js';
import type { Ctx } from './controls.js';
import { extFromHub, hubFields } from './hubmap.js';
import { CATEGORIES, resetCategory, type Env } from './panels.js';
import { renderProfile } from './page.js';
import { styleName } from './render.js';
import { primeStyle } from './store.js';
import { sameProfile, sanitize, wireSize, LIMITS, type Ext } from './schema.js';

const HISTORY_LIMIT = 100;

/** Unsaved work survives leaving the tab (or Settings) and coming back, until the app closes. */
let stash: { user: string; draft: string; undo: string[]; redo: string[] } | null = null;

function signedOut(): Section {
  const box = h('div', { className: 'settings-links' },
    button('Log in', { kind: 'primary', icon: 'user', onClick: () => openAuthModal('login') }),
    button('Create an account', { kind: 'secondary', onClick: () => openAuthModal('register') }));
  const node = panel('Profile', h('p', { className: 'dim', text: 'Sign in to style your profile: name effects, avatar frames, banners, themes, a showcase and more.' }), box);
  return { node };
}

export function profileSection(): Section {
  const holder = h('div', { className: 'pe-holder' });
  let inner: Section | null = null;
  const mount = (): void => {
    inner?.dispose?.();
    inner = currentUser() ? profileEditor() : signedOut();
    holder.replaceChildren(inner.node);
  };
  mount();
  let who = currentUser()?.username ?? '';
  const off = onSession(() => {
    const now = currentUser()?.username ?? '';
    if (now !== who) { who = now; mount(); }
  });
  return { node: holder, dispose: () => { off(); inner?.dispose?.(); } };
}

function profileEditor(): Section {
  const me = currentUser()!;
  const root = h('div', { className: 'pe' });
  root.appendChild(h('div', { className: 'pe-loading dim', text: 'Loading your profile...' }));
  let disposed = false;
  let teardown: (() => void) | null = null;
  void load();
  return { node: root, dispose(): void { disposed = true; teardown?.(); } };

  async function load(): Promise<void> {
    try {
      const [hubReply, social] = await Promise.all([
        hubJson('GET', '/api/users/' + encodeURIComponent(me.username)),
        socialJson<{ profile?: unknown }>('GET', '/api/profile/' + userPath(me.username)).then((r) => ({ ok: true as const, r }), () => ({ ok: false as const, r: null })),
      ]);
      if (disposed) return;
      const hub = normalizeProfile(hubReply);
      if (!hub) throw new Error('The hub sent something unexpected.');
      const fromServer = social.ok && social.r && social.r.profile ? sanitize(social.r.profile) : extFromHub(hub);
      teardown = start(root, me.username, hub, fromServer, social.ok);
    } catch (error) {
      if (disposed) return;
      root.replaceChildren(h('p', { className: 'form-error', text: 'Your profile could not be loaded (' + describeError(error) + ').' }), button('Try again', { kind: 'secondary', icon: 'refresh', onClick: () => { root.replaceChildren(h('div', { className: 'pe-loading dim', text: 'Loading your profile...' })); void load(); } }));
    }
  }
}

function start(root: HTMLElement, username: string, hub: Profile, loaded: Ext, socialUp: boolean): () => void {
  let saved: Ext = JSON.parse(JSON.stringify(loaded));
  let draft: Ext = JSON.parse(JSON.stringify(loaded));
  let undo: string[] = [];
  let redo: string[] = [];
  if (stash && stash.user === username) {
    draft = sanitize(JSON.parse(stash.draft));
    undo = stash.undo; redo = stash.redo;
    toast('Restored your unsaved profile changes.', 'info');
  }
  stash = null;
  // #/settings/profile?cat=banner opens a category directly; ?q=glow starts with a search (used by the snapshots).
  const hashQuery = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  let activeCat = CATEGORIES.some((c) => c.id === hashQuery.get('cat')) ? hashQuery.get('cat')! : 'presets';
  let query = (hashQuery.get('q') ?? '').slice(0, 60);
  let lastKey = '';
  let lastAt = 0;
  let busy = false;
  let frame = 0;
  let live = true;

  const snapshot = (): string => JSON.stringify(draft);
  const dirty = (): boolean => !sameProfile(draft, saved);

  /* ---------- state changes ---------- */

  function change(fn: (e: Ext) => void, key?: string): void {
    const before = snapshot();
    const next = JSON.parse(before) as Ext;
    fn(next);
    const clean = sanitize(next);
    if (JSON.stringify(clean) === before) return;
    const now = Date.now();
    if (!(key && key === lastKey && now - lastAt < 900)) {
      undo.push(before);
      if (undo.length > HISTORY_LIMIT) undo.shift();
    }
    redo = [];
    lastKey = key ?? '';
    lastAt = now;
    draft = clean;
    refresh();
  }

  function replace(next: Ext): void {
    const before = snapshot();
    const clean = sanitize(next);
    if (JSON.stringify(clean) === before) return;
    undo.push(before);
    if (undo.length > HISTORY_LIMIT) undo.shift();
    redo = [];
    lastKey = '';
    draft = clean;
    rebuild();
    refresh();
  }

  function stepHistory(from: string[], to: string[]): void {
    const previous = from.pop();
    if (previous === undefined) return;
    to.push(snapshot());
    draft = sanitize(JSON.parse(previous));
    lastKey = '';
    rebuild();
    refresh();
  }
  const doUndo = (): void => stepHistory(undo, redo);
  const doRedo = (): void => stepHistory(redo, undo);

  const ctx: Ctx = { get: () => draft, change, rebuild: () => rebuild() };
  const env: Env = { ctx, hub: () => hub, replace, picturesChanged: () => refresh() };

  /* ---------- layout ---------- */

  const search = h('input', { className: 'input pe-search', attrs: { type: 'search', placeholder: 'Search options (glow, banner, privacy...)', 'aria-label': 'Search profile options' } });
  const undoBtn = button('Undo', { kind: 'ghost', title: 'Undo (Ctrl+Z)', onClick: doUndo });
  const redoBtn = button('Redo', { kind: 'ghost', title: 'Redo (Ctrl+Shift+Z)', onClick: doRedo });
  const resetBtn = button('Reset section', { kind: 'ghost', title: 'Put this section back to the defaults (you can undo it)', onClick: () => replace(resetCategory(draft, activeCat)) });
  const discardBtn = button('Discard changes', { kind: 'ghost', onClick: () => { replace(JSON.parse(JSON.stringify(saved))); } });
  const saveBtn = button('Save profile', { kind: 'primary', icon: 'check', onClick: () => { void save(); } });
  const state = h('span', { className: 'pe-state' });
  const sizeNote = h('span', { className: 'pe-size dim' });
  const errorBox = h('p', { className: 'form-error pe-error', attrs: { role: 'alert' }, hidden: true });
  const toolbar = h('div', { className: 'pe-toolbar' }, search, h('div', { className: 'pe-tools' }, undoBtn, redoBtn, resetBtn), h('div', { className: 'pe-tools pe-save' }, state, discardBtn, saveBtn));

  const nav = h('div', { className: 'pe-cats', attrs: { role: 'tablist', 'aria-label': 'Profile options' } });
  for (const cat of CATEGORIES) {
    const b = h('button', { className: 'pe-cat', attrs: { type: 'button', role: 'tab' }, dataset: { cat: cat.id } }, icon(cat.icon, 16), h('span', { text: cat.label }));
    b.addEventListener('click', () => { activeCat = cat.id; search.value = ''; query = ''; rebuild(); });
    nav.appendChild(b);
  }
  const body = h('div', { className: 'pe-body' });
  const left = h('div', { className: 'pe-left panel' }, nav, body);
  const previewHost = h('div', { className: 'pe-preview-host' });
  const chipHost = h('div', { className: 'pe-chipdemo' });
  const right = h('div', { className: 'pe-right' }, h('div', { className: 'pe-right-head' }, h('h3', { className: 'pe-group-title', text: 'Live preview' }), sizeNote), previewHost, h('h3', { className: 'pe-group-title', text: 'In lists and posts' }), chipHost);
  const note = socialUp ? null : h('p', { className: 'form-error', text: 'The social server could not be reached, so the extended profile cannot be saved right now.' });
  root.replaceChildren(...([toolbar, errorBox, note, h('div', { className: 'pe-main' }, left, right)].filter(Boolean) as Node[]));

  /* ---------- rendering ---------- */

  function visibleCats(): typeof CATEGORIES {
    return query ? CATEGORIES : CATEGORIES.filter((c) => c.id === activeCat);
  }

  function rebuild(): void {
    const keep = body.scrollTop;
    body.replaceChildren();
    for (const cat of visibleCats()) {
      const wrap = h('div', { className: 'pe-cat-body', dataset: { cat: cat.id } });
      if (query) wrap.appendChild(h('h2', { className: 'pe-cat-title', text: cat.label }));
      for (const g of cat.build(env)) wrap.appendChild(g);
      body.appendChild(wrap);
    }
    if (query) applySearch();
    for (const b of Array.from(nav.children) as HTMLElement[]) {
      const on = !query && b.dataset.cat === activeCat;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    resetBtn.disabled = !!query;
    body.scrollTop = keep;
  }

  function applySearch(): void {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    let any = false;
    for (const wrap of Array.from(body.querySelectorAll<HTMLElement>('.pe-cat-body'))) {
      let catAny = false;
      for (const g of Array.from(wrap.querySelectorAll<HTMLElement>('.pe-group'))) {
        let groupAny = false;
        const title = g.dataset.group ?? '';
        for (const r of Array.from(g.querySelectorAll<HTMLElement>('.pe-row'))) {
          const text = (r.dataset.search ?? '') + ' ' + title + ' ' + (wrap.querySelector('.pe-cat-title')?.textContent ?? '').toLowerCase();
          const ok = terms.every((t) => text.includes(t));
          r.hidden = !ok;
          if (ok) groupAny = true;
        }
        g.hidden = !groupAny;
        if (groupAny) catAny = true;
      }
      wrap.hidden = !catAny;
      if (catAny) any = true;
    }
    if (!any) body.appendChild(h('p', { className: 'dim pe-none', text: 'No options match "' + query + '".' }));
  }

  function paintPreview(): void {
    previewHost.replaceChildren(renderProfile(
      { hub, ext: draft, preview: true, friendCount: 0, friends: [] },
      { open: () => undefined, presence: 'online' }
    ));
    const legacy = nameStyle(hub.author.name_color);
    const chip = h('span', { className: 'person' });
    chip.appendChild(playerAvatar(hub.author, 28, { style: draft.avatar, presence: 'online' }));
    const nm = h('span', { className: 'author', text: username });
    styleName(nm, draft.name, { compact: true, legacy: { color: legacy.color, background: legacy.background } });
    chip.appendChild(nm);
    const post = h('div', { className: 'pe-fakepost' }, chip, h('span', { className: 'dim', text: ' replied in ' }), h('strong', { text: 'Level design tips' }));
    const card = h('div', { className: 'pe-fakecard' }, h('span', { className: 'dim', text: 'by ' }), (() => { const a = h('span', { className: 'author', text: username }); styleName(a, draft.name, { compact: true, legacy: { color: legacy.color, background: legacy.background } }); return a; })());
    chipHost.replaceChildren(post, card);
  }

  function refresh(): void {
    undoBtn.disabled = undo.length === 0;
    redoBtn.disabled = redo.length === 0;
    const d = dirty();
    state.textContent = d ? 'Unsaved changes' : 'All changes saved';
    state.classList.toggle('is-dirty', d);
    saveBtn.disabled = busy || !d;
    discardBtn.disabled = busy || !d;
    sizeNote.textContent = Math.round(wireSize(draft) / 102.4) / 10 + ' KB of ' + LIMITS.bytes / 1024 + ' KB';
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { if (live) paintPreview(); });
  }

  /* ---------- search, keys, leaving ---------- */

  search.value = query;
  search.addEventListener('input', () => { query = search.value.trim(); rebuild(); });

  function onKey(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const target = event.target as HTMLElement | null;
    const typing = target && (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && ['text', 'search', 'url'].includes((target as HTMLInputElement).type)));
    if (typing) return;
    const k = event.key.toLowerCase();
    if (k === 'z' && !event.shiftKey) { event.preventDefault(); doUndo(); }
    else if ((k === 'z' && event.shiftKey) || k === 'y') { event.preventDefault(); doRedo(); }
    else if (k === 's') { event.preventDefault(); void save(); }
  }

  function onLinkClick(event: MouseEvent): void {
    if (!dirty() || busy) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href^="#/"]');
    if (!anchor) return;
    const target = anchor.getAttribute('href') ?? '';
    if (target.startsWith('#/settings/profile')) return;
    event.preventDefault();
    event.stopPropagation();
    askLeave(target);
  }

  function askLeave(target: string): void {
    const body = h('p', { text: 'You changed your profile but have not saved it. Save it before you go?' });
    modal({
      title: 'Unsaved profile changes', body,
      actions: [
        { label: 'Keep editing', kind: 'secondary' },
        { label: 'Leave without saving', kind: 'danger', onClick: () => { saved = JSON.parse(JSON.stringify(draft)); go(target); } },
        { label: 'Save and leave', kind: 'primary', onClick: () => { void save().then((ok) => { if (ok) go(target); }); } },
      ],
    });
  }

  document.addEventListener('click', onLinkClick, true);
  document.addEventListener('keydown', onKey);

  /* ---------- saving ---------- */

  async function save(): Promise<boolean> {
    if (busy || !dirty()) return !dirty();
    busy = true;
    refresh();
    errorBox.hidden = true;
    const hubBody = hubFields(draft);
    let socialDone = false;
    try {
      await socialJson('PUT', '/api/profile', draft);
      socialDone = true;
      await hubJson('PUT', '/api/me/profile', { ...hubBody });
      await refreshSession();
      saved = JSON.parse(JSON.stringify(draft));
      primeStyle(username, { name: draft.name, avatar: draft.avatar, accent: draft.theme.accent });
      toast('Profile saved.', 'success');
      return true;
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = (socialDone ? 'Your extended profile was saved, but the hub refused the basic fields: ' : 'Could not save: ') + describeError(error);
      return false;
    } finally {
      busy = false;
      refresh();
    }
  }

  rebuild();
  refresh();

  return () => {
    live = false;
    cancelAnimationFrame(frame);
    document.removeEventListener('click', onLinkClick, true);
    document.removeEventListener('keydown', onKey);
    stash = dirty() ? { user: username, draft: snapshot(), undo, redo } : null;
  };
}

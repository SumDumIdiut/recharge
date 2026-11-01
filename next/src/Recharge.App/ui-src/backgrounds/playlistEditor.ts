import { h } from '../dom.js';
import { describeError } from '../bridge.js';
import { button } from '../components/button.js';
import { selectControl } from '../components/select.js';
import { toast } from '../components/toast.js';
import {
  addFileToPlaylist, addInstalledToPlaylist, createPlaylist, deletePlaylist, pickMediaFile, renamePlaylist, savePlaylistOrder,
  type BackgroundList, type PlaylistRow,
} from './api.js';
import { moveItem } from './model.js';
import { mediaThumb } from './thumb.js';

export interface EditorHooks {
  /** Called after any change on disk; the page reloads the list and repaints. */
  changed(): Promise<void>;
  /** Make this playlist the background. */
  use(folder: string): Promise<void>;
}

let selected: string | null = null;

/** The "Your playlists" editor: make a playlist, add pictures and videos (your files or installed backgrounds), reorder, remove. */
export function playlistEditor(list: BackgroundList, hooks: EditorHooks): HTMLElement {
  const root = h('div', { className: 'pl-editor' });
  const own = list.playlists.filter((p) => p.own);
  if (selected && !own.some((p) => p.folder === selected)) selected = null;
  if (!selected && own.length > 0) selected = own[0].folder;

  const run = async (work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
      await hooks.changed();
    } catch (e) {
      toast(describeError(e), 'error');
    }
  };

  // choose / create
  const head = h('div', { className: 'pl-head' });
  for (const p of own) {
    const chip = button(p.name + ' (' + p.items.length + ')', { kind: 'secondary', onClick: () => { selected = p.folder; void hooks.changed(); } });
    chip.setAttribute('aria-pressed', p.folder === selected ? 'true' : 'false');
    chip.classList.add('theme-choice-chip');
    if (p.folder === selected) chip.style.borderColor = 'var(--green)';
    head.appendChild(chip);
  }
  const nameInput = h('input', { className: 'settings-input', attrs: { type: 'text', placeholder: 'New playlist name', maxlength: '60', 'aria-label': 'New playlist name' } });
  const create = button('Create playlist', {
    kind: 'primary', icon: 'plus',
    onClick: () => void run(async () => {
      const made = await createPlaylist(nameInput.value);
      selected = made.folder;
      nameInput.value = '';
    }),
  });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') create.click(); });
  head.append(nameInput, create);
  root.appendChild(head);

  const current = own.find((p) => p.folder === selected);
  if (!current) {
    root.appendChild(h('p', { className: 'setting-hint', text: 'Name a playlist, then add your own pictures and videos or backgrounds you installed. It rotates behind the app.' }));
    return root;
  }
  root.appendChild(editorFor(current, list, hooks, run));
  return root;
}

function editorFor(p: PlaylistRow, list: BackgroundList, hooks: EditorHooks, run: (w: () => Promise<unknown>) => Promise<void>): HTMLElement {
  const box = h('div', { className: 'pl-body' });

  const bar = h('div', { className: 'pl-head' });
  const rename = h('input', { className: 'settings-input', attrs: { type: 'text', maxlength: '60', 'aria-label': 'Playlist name' } });
  rename.value = p.name;
  bar.appendChild(rename);
  bar.appendChild(button('Rename', { kind: 'secondary', onClick: () => void run(() => renamePlaylist(p.folder, rename.value)) }));
  bar.appendChild(button('Use as background', { kind: 'primary', icon: 'image', onClick: () => void hooks.use(p.folder) }));
  let sure = false;
  const del = button('Delete playlist', { kind: 'danger' });
  del.addEventListener('click', () => {
    if (!sure) {
      sure = true;
      const label = del.querySelector('span');
      if (label) label.textContent = 'Click again to delete';
      window.setTimeout(() => { sure = false; const l = del.querySelector('span'); if (l) l.textContent = 'Delete playlist'; }, 4000);
      return;
    }
    void run(async () => { await deletePlaylist(p.folder); selected = null; });
  });
  bar.appendChild(del);
  box.appendChild(bar);

  const files = p.items.map((i) => i.file);
  const items = h('div', { className: 'pl-list' });
  if (p.items.length === 0) items.appendChild(h('p', { className: 'setting-hint', text: 'Empty. Add a picture or a video below.' }));
  p.items.forEach((item, index) => {
    const row = h('div', { className: 'pl-item' });
    row.appendChild(mediaThumb('playlists', p.folder, item));
    row.appendChild(h('span', { className: 'pl-name', text: item.file, title: item.file }));
    row.appendChild(h('span', { className: 'pl-kind', text: item.kind === 'video' ? 'Video' : 'Picture' }));
    const up = button('Up', { kind: 'ghost', disabled: index === 0, title: 'Move earlier', onClick: () => void run(() => savePlaylistOrder(p.folder, moveItem(files, index, index - 1))) });
    const down = button('Down', { kind: 'ghost', disabled: index === files.length - 1, title: 'Move later', onClick: () => void run(() => savePlaylistOrder(p.folder, moveItem(files, index, index + 1))) });
    const remove = button('Remove', { kind: 'danger', title: 'Remove it from the playlist (the copy in the playlist is deleted)', onClick: () => void run(() => savePlaylistOrder(p.folder, files.filter((_, i) => i !== index))) });
    row.append(up, down, remove);
    items.appendChild(row);
  });
  box.appendChild(items);

  const add = h('div', { className: 'pl-picker' });
  add.appendChild(button('Add a file…', {
    kind: 'secondary', icon: 'plus',
    onClick: () => void run(async () => {
      const picked = await pickMediaFile();
      if (picked.path) await addFileToPlaylist(p.folder, picked.path);
    }),
  }));
  const installed = list.backgrounds.filter((b) => b.media);
  if (installed.length > 0) {
    let choice = installed[0].folder;
    add.appendChild(selectControl(installed.map((b) => ({ value: b.folder, label: b.name })), { value: choice, onChange: (v) => { choice = v; } }));
    add.appendChild(button('Add installed background', { kind: 'secondary', onClick: () => void run(() => addInstalledToPlaylist(p.folder, choice)) }));
  }
  box.appendChild(add);
  box.appendChild(h('p', { className: 'setting-hint', text: 'Files are copied into Recharge, so you can move or delete the originals. Pictures: png, jpg, webp, gif. Videos: mp4, webm.' }));
  return box;
}

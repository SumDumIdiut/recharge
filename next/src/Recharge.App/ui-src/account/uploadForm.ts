/** The Upload form: publish a mod, map or skin to the hub from Library > Your uploads. */
import { h } from '../dom.js';
import { call, describeError } from '../bridge.js';
import { modal } from '../components/modal.js';
import { button } from '../components/button.js';
import { selectControl } from '../components/select.js';
import { toast } from '../components/toast.js';
import { field, textInput, textArea, counter, formError } from '../community/forms.js';
import { hubJson, HubError } from '../community/api.js';
import { githubRepoUrl } from '../lib/sourceUrl.js';
import { currentUser } from './session.js';
import {
  addGallery, BACKGROUND_EXTENSIONS, baseName, buildFields, derivesGallery, DESCRIPTION_MAX, IMAGE_EXTENSIONS, MAX_GALLERY, NAME_MAX,
  parseRelease, releaseLine, REPO_HINT, suggestedName, UPLOAD_KINDS, validateUpload, type FileSource, type ReleaseInfo, type UploadForm, type UploadKind,
} from '../lib/upload.js';

export interface UploadPreset { repo?: string }

async function pick(title: string, name: string, extensions: string[], multiple: boolean): Promise<string[]> {
  const reply = await call<{ paths?: string[] }>('files.pick', { title, filters: [{ name, extensions }], multiple });
  return Array.isArray(reply.paths) ? reply.paths : [];
}

/** Opens the form. onDone runs after a successful upload so the caller can reload its list. */
export function openUploadForm(onDone: () => void, preset: UploadPreset = {}): void {
  const state: UploadForm = {
    kind: 'mod', repo: '', name: '', author: currentUser()?.username || '', version: '', description: '',
    source: 'zip', zipPath: '', gallery: [], release: null,
  };
  let busy = false;
  let sourceChosen = false;   // the person picked a source themselves; do not flip it when a release arrives
  let fetchId = 0;

  const body = h('div', { className: 'upload-form' });
  const errors = formError();

  // kind
  const kindField = h('div', { className: 'form-field' }, h('span', { className: 'form-label', text: 'What are you uploading?' }));
  kindField.appendChild(selectControl(UPLOAD_KINDS, { value: state.kind, onChange: (value) => { state.kind = value as UploadKind; errors.show(null); paint(); } }));

  // repo (mods)
  const repoInput = textInput('', 'https://github.com/owner/repo');
  const releaseNote = h('span', { className: 'form-hint upload-release-line dim' });
  const repoField = field('GitHub repo (source code)', repoInput);
  repoField.appendChild(releaseNote);
  repoInput.addEventListener('change', () => { void lookup(); });
  repoInput.addEventListener('input', () => { state.repo = repoInput.value; });

  // file
  const fileBox = h('div', { className: 'form-field' });
  // screenshots
  const shotsBox = h('div', { className: 'form-field' });
  // text fields
  const nameInput = textInput('', 'Name', NAME_MAX);
  // The author is always the signed-in account; it can't be changed.
  const authorInput = textInput(state.author, 'Author', 60);
  authorInput.readOnly = true;
  authorInput.classList.add('is-locked');
  authorInput.title = 'Uploads are published under your account';
  const versionInput = textInput('', 'Version, like 1.0.0', 30);
  const descInput = textArea('', 'What does it do?', 4);
  const descField = field('Description', descInput);
  descField.appendChild(counter(descInput, DESCRIPTION_MAX));
  const metaRow = h('div', { className: 'upload-row' }, field('Name', nameInput), field('Version', versionInput));

  body.append(kindField, repoField, fileBox, metaRow, field('Author', authorInput), descField, shotsBox, errors.element);

  function sync(): void {
    state.repo = repoInput.value;
    state.name = nameInput.value;
    state.author = authorInput.value;
    state.version = versionInput.value;
    state.description = descInput.value;
  }

  function paintFile(): void {
    const isBg = state.kind === 'background';
    const label = state.kind === 'mod' ? 'Mod file'
      : isBg ? 'Background image or video'
      : state.kind === 'playlist' ? 'Playlist zip (images)'
      : 'Zip file';
    fileBox.replaceChildren(h('span', { className: 'form-label', text: label }));
    const fileName = state.zipPath ? baseName(state.zipPath) : '';
    const exts = isBg ? BACKGROUND_EXTENSIONS : ['zip'];
    const pickerName = isBg ? 'Image or video' : 'Zip files';
    const chooseText = isBg ? 'Choose a file…' : 'Choose a zip…';
    const changeText = isBg ? 'Change file…' : 'Change zip…';
    const chooser = button(state.zipPath ? changeText : chooseText, {
      kind: 'secondary', icon: isBg ? 'image' : 'package',
      onClick: () => {
        pick(chooseText, pickerName, exts, false).then((paths) => {
          if (paths.length === 0) return;
          state.zipPath = paths[0];
          state.source = 'zip';
          sourceChosen = true;
          paintFile();
        }, (error) => errors.show(describeError(error)));
      },
    });
    const picked = h('span', { className: 'upload-file dim', text: fileName });
    if (state.kind !== 'mod') {
      fileBox.appendChild(h('div', { className: 'upload-line' }, chooser, picked));
      return;
    }
    const asset = state.release?.asset || null;
    const radio = (value: FileSource, label: string, disabled: boolean, extra?: Node): HTMLElement => {
      const input = h('input', { attrs: { type: 'radio', name: 'upload-source', value } });
      input.checked = state.source === value;
      input.disabled = disabled;
      input.addEventListener('change', () => { state.source = value; sourceChosen = true; paintFile(); });
      return h('label', { className: 'upload-radio' + (disabled ? ' is-disabled' : '') }, input, h('span', { text: label }), extra);
    };
    fileBox.appendChild(radio('release', asset ? 'Use the GitHub release zip (' + asset.name + ')' : 'Use the GitHub release zip', !asset));
    fileBox.appendChild(radio('zip', 'Choose a zip…', false, state.source === 'zip' ? h('span', { className: 'upload-inline' }, chooser, picked) : undefined));
  }

  function paintShots(): void {
    shotsBox.replaceChildren(h('span', { className: 'form-label', text: 'Screenshots (optional)' }));
    const bar = h('div', { className: 'picker-bar' });
    const add = button('Add screenshots', {
      kind: 'secondary', icon: 'image',
      onClick: () => {
        pick('Choose screenshots', 'Pictures', IMAGE_EXTENSIONS, true).then((paths) => {
          state.gallery = addGallery(state.gallery, paths);
          paintShots();
        }, (error) => errors.show(describeError(error)));
      },
    });
    add.disabled = state.gallery.length >= MAX_GALLERY;
    bar.append(add, h('span', { className: 'dim', text: state.gallery.length + ' of ' + MAX_GALLERY }));
    shotsBox.appendChild(bar);
    if (state.gallery.length > 0) {
      const chips = h('div', { className: 'upload-chips' });
      for (const path of state.gallery) {
        chips.appendChild(h('span', { className: 'upload-chip', title: path },
          h('span', { className: 'upload-chip-name', text: baseName(path) }),
          h('button', { className: 'upload-chip-x', title: 'Remove', attrs: { type: 'button', 'aria-label': 'Remove ' + baseName(path) }, text: '×',
            on: { click: () => { state.gallery = state.gallery.filter((p) => p !== path); paintShots(); } } })));
      }
      shotsBox.appendChild(chips);
    }
  }

  function paintRelease(): void {
    releaseNote.textContent = releaseLine(state.release);
    releaseNote.classList.toggle('is-problem', !!state.release?.problem || (!!state.release && !state.release.asset));
  }

  const KIND_NAME: Record<UploadKind, string> = {
    mod: 'Mod name', map: 'Map name', skin: 'Skin name', background: 'Background name', playlist: 'Playlist name',
  };

  function paint(): void {
    sync();
    const mod = state.kind === 'mod';
    repoField.hidden = !mod;   // the GitHub repo is required for mods only
    nameInput.placeholder = KIND_NAME[state.kind];
    paintFile();
    // Backgrounds and playlists get their preview from the uploaded file, so there is no separate screenshots picker.
    const noShots = derivesGallery(state.kind);
    shotsBox.hidden = noShots;
    if (noShots) shotsBox.replaceChildren(); else paintShots();
    paintRelease();
  }

  function applyRelease(release: ReleaseInfo, repoUrl: string): void {
    state.release = release;
    if (!nameInput.value.trim()) nameInput.value = suggestedName(release, repoUrl);
    if (!versionInput.value.trim() && release.version) versionInput.value = release.version;
    if (!descInput.value.trim() && release.notes) descInput.value = release.notes.slice(0, DESCRIPTION_MAX);
    descInput.dispatchEvent(new Event('input'));
    if (!sourceChosen) state.source = release.asset ? 'release' : 'zip';
    if (state.source === 'release' && !release.asset) state.source = 'zip';
  }

  async function lookup(): Promise<void> {
    sync();
    const repoUrl = githubRepoUrl(state.repo);
    const mine = ++fetchId;
    state.release = null;
    if (!state.repo.trim()) { releaseNote.textContent = ''; paintFile(); return; }
    if (!repoUrl) {
      releaseNote.textContent = REPO_HINT;
      releaseNote.classList.add('is-problem');
      paintFile();
      return;
    }
    releaseNote.textContent = 'Looking for the latest release…';
    releaseNote.classList.remove('is-problem');
    try {
      const release = parseRelease(await hubJson('GET', '/api/github/release?repo=' + encodeURIComponent(repoUrl)));
      if (mine !== fetchId) return;
      if (release) applyRelease(release, repoUrl);
      paintRelease();
    } catch (error) {
      if (mine !== fetchId) return;
      const text = error instanceof HubError && error.status === 404
        ? 'No release found on that repo yet. You can still choose a zip.'
        : describeError(error);
      releaseNote.textContent = text;
      releaseNote.classList.add('is-problem');
    }
    paintFile();
  }

  const overlay = modal({
    title: 'Upload',
    body,
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: () => (busy ? false : undefined) },
      { label: 'Upload', kind: 'primary', onClick: () => { void submit(); return false; } },
    ],
  });
  const uploadButton = overlay.querySelector<HTMLButtonElement>('.modal-actions .btn-primary');
  const close = (): void => { overlay.querySelector<HTMLButtonElement>('.modal-head .icon-btn')?.click(); };

  async function submit(): Promise<void> {
    if (busy) return;
    sync();
    const problem = validateUpload(state);
    if (problem) { errors.show(problem); return; }
    errors.show(null);
    busy = true;
    if (uploadButton) { uploadButton.disabled = true; uploadButton.querySelector('span')!.textContent = 'Uploading…'; }
    try {
      const mod = state.kind === 'mod';
      const reply = await call<{ id?: string; status?: string }>('hub.submit', {
        fields: buildFields(state),
        ...(!(mod && state.source === 'release') && state.zipPath ? { file: state.zipPath } : {}),
        gallery: derivesGallery(state.kind) ? [] : state.gallery,
      });
      toast(reply.status === 'approved' ? 'Uploaded — live now' : 'Uploaded — waiting for review', 'success');
      busy = false;
      close();
      onDone();
    } catch (error) {
      busy = false;
      if (uploadButton) { uploadButton.disabled = false; uploadButton.querySelector('span')!.textContent = 'Upload'; }
      errors.show(describeError(error));
    }
  }

  paint();
  if (preset.repo) { repoInput.value = preset.repo; void lookup(); }
}

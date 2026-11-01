import { h } from '../dom.js';
import { describeError } from '../bridge.js';
import { button } from '../components/button.js';
import { selectControl } from '../components/select.js';
import { toast } from '../components/toast.js';
import { icon } from '../icons.js';
import { getSettings, saveSettings } from './api.js';
import { panel, row, setSwitch, switchControl } from './ui.js';
import { importBackground, listBackgrounds, pickMediaFile, type BackgroundList } from '../backgrounds/api.js';
import { applyConfig } from '../backgrounds/index.js';
import {
  configFromSettings, configToPatch, DEFAULTS, FITS, PAGES, POSITIONS,
  type BgConfig, type PageId,
} from '../backgrounds/model.js';
import { playlistEditor } from '../backgrounds/playlistEditor.js';
import { ensureBackgroundStyles } from '../backgrounds/styles.js';
import { mediaThumb } from '../backgrounds/thumb.js';

const FIT_LABEL: Record<string, string> = { cover: 'Cover (fill the window)', contain: 'Contain (whole picture)', center: 'Centre (actual size)' };
const POSITION_LABEL: Record<string, string> = { center: 'Centre', top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right' };
const INTERVALS: Array<[number, string]> = [[10, '10 seconds'], [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [900, '15 minutes'], [1800, '30 minutes'], [3600, '1 hour'], [21600, '6 hours']];
const FADES: Array<[number, string]> = [[0, 'No fade'], [500, '0.5 seconds'], [1000, '1 second'], [2000, '2 seconds'], [4000, '4 seconds']];

function intervalLabel(seconds: number): string {
  const known = INTERVALS.find(([s]) => s === seconds);
  if (known) return known[1];
  return seconds >= 60 ? Math.round(seconds / 60) + ' minutes' : seconds + ' seconds';
}

function slider(min: number, max: number, value: number, unit: string, onInput: (v: number) => void, label: string): HTMLElement {
  const box = h('div', { className: 'bg-range' });
  const input = h('input', { attrs: { type: 'range', min: String(min), max: String(max), step: '1', 'aria-label': label } });
  input.value = String(value);
  const out = h('output', { text: value + unit });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = v + unit;
    onInput(v);
  });
  box.append(input, out);
  return box;
}

/** The Background panel (choose, look, rotation, playback, per-page dimming) and the Your playlists panel. */
export function backgroundSection(): { nodes: HTMLElement[]; dispose: () => void } {
  ensureBackgroundStyles();
  let config: BgConfig = { ...DEFAULTS, pageDim: {} };
  let list: BackgroundList = { backgrounds: [], playlists: [] };
  let alive = true;
  let saveTimer = 0;

  const note = h('div', { className: 'setting-hint', attrs: { role: 'status' } });
  const gridHost = h('div', { className: 'bg-grid' });
  const settingsHost = h('div', { className: 'bg-settings' });
  const listHost = h('div', { className: 'bg-list' });
  const mainPanel = panel('Background', h('p', { className: 'setting-hint', text: 'A picture, a video or a playlist behind the whole app.' }), gridHost, note, settingsHost);
  mainPanel.classList.add('bg-panel');
  const listPanel = panel('Your playlists', listHost);
  listPanel.classList.add('bg-panel');

  async function show(): Promise<void> {
    try {
      const n = await applyConfig(config, list);
      note.textContent = n || '';
    } catch (e) {
      note.textContent = describeError(e);
    }
  }
  function persist(): void {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      saveSettings(configToPatch(config)).catch((e) => toast(describeError(e), 'error'));
    }, 350);
  }
  /** Changes the config, shows it at once and saves it (after a short pause, so a slider drag saves once). */
  function change(patch: Partial<BgConfig>, repaint = false): void {
    config = { ...config, ...patch };
    void show();
    persist();
    if (repaint) paintAll();
    else paintTiles();
  }

  // ---- the tile grid ----
  const tiles: Array<{ node: HTMLElement; pressed: () => boolean }> = [];
  function tile(label: string, thumb: HTMLElement, pressed: () => boolean, onPick: () => void, badge?: string): HTMLElement {
    const node = h('button', { className: 'bg-tile', attrs: { type: 'button', 'aria-pressed': 'false' }, title: label });
    node.append(thumb);
    if (badge) thumb.appendChild(h('span', { className: 'bg-badge', text: badge }));
    node.append(h('span', { className: 'bg-tile-name', text: label }));
    node.addEventListener('click', onPick);
    tiles.push({ node, pressed });
    return node;
  }
  function paintTiles(): void {
    for (const t of tiles) t.node.setAttribute('aria-pressed', t.pressed() ? 'true' : 'false');
  }
  function paintGrid(): void {
    tiles.length = 0;
    gridHost.replaceChildren();
    const none = h('div', { className: 'bg-thumb is-none' }, icon('x', 28));
    gridHost.appendChild(tile('None', none, () => config.source === 'none', () => change({ source: 'none' })));
    for (const b of list.backgrounds) {
      gridHost.appendChild(tile(b.name, mediaThumb('backgrounds', b.folder, b.media),
        () => config.source === 'background' && config.background === b.folder,
        () => change({ source: 'background', background: b.folder })));
    }
    for (const p of list.playlists) {
      const thumb = mediaThumb('playlists', p.folder, p.items[0] || null);
      gridHost.appendChild(tile(p.name, thumb,
        () => config.source === 'playlist' && config.playlist === p.folder,
        () => change({ source: 'playlist', playlist: p.folder }),
        p.items.length + (p.items.length === 1 ? ' item' : ' items')));
    }
    paintTiles();
  }

  // ---- the look, rotation, playback ----
  function paintSettings(): void {
    settingsHost.replaceChildren();
    const actions = h('div', { className: 'bg-actions' });
    actions.appendChild(button('Add your own picture or video…', {
      kind: 'secondary', icon: 'plus',
      onClick: () => void (async () => {
        try {
          const picked = await pickMediaFile();
          if (!picked.path) return;
          const made = await importBackground(picked.path);
          list = await listBackgrounds();
          config = { ...config, source: 'background', background: made.folder };
          paintAll();
          void show();
          persist();
        } catch (e) {
          toast(describeError(e), 'error');
        }
      })(),
    }));
    settingsHost.appendChild(actions);
    if (list.backgrounds.length === 0 && list.playlists.length === 0) {
      settingsHost.appendChild(h('p', { className: 'setting-hint', text: 'Nothing installed yet. Add your own file here, or get backgrounds and playlists from the Library.' }));
    }

    settingsHost.appendChild(row('Fit', 'How a picture or video fills the window.',
      selectControl(FITS.map((f) => ({ value: f, label: FIT_LABEL[f] })), { value: config.fit, onChange: (v) => change({ fit: v as BgConfig['fit'] }) })));
    settingsHost.appendChild(row('Position', 'Which part stays in view when it is cropped.',
      selectControl(POSITIONS.map((p) => ({ value: p, label: POSITION_LABEL[p] })), { value: config.position, onChange: (v) => change({ position: v as BgConfig['position'] }) })));
    settingsHost.appendChild(row('Dim', 'Darken the background so text is easy to read.',
      slider(0, 90, config.dim, '%', (v) => change({ dim: v }), 'Dim')));

    const color = h('input', { attrs: { type: 'color', 'aria-label': 'Tint colour' } });
    color.value = config.tint || '#000000';
    color.addEventListener('input', () => change({ tint: color.value }));
    const clear = button('Black', { kind: 'ghost', title: 'Use plain black', onClick: () => { color.value = '#000000'; change({ tint: null }); } });
    settingsHost.appendChild(row('Tint', 'The colour of the dimming layer.', h('div', { className: 'bg-color' }, color, clear)));

    const blurRow = row('Blur', 'Soften the background. Costly: it makes the graphics work harder, and a blurred video more so. Leave it at 0 on a slow machine.',
      slider(0, 24, config.blur, ' px', (v) => change({ blur: v }), 'Blur'));
    settingsHost.appendChild(blurRow);

    settingsHost.appendChild(row('Playlist: change every', 'How long each item of a playlist stays.',
      selectControl(
        (INTERVALS.some(([s]) => s === config.interval) ? INTERVALS : INTERVALS.concat([[config.interval, intervalLabel(config.interval)]]))
          .map(([s, l]) => ({ value: String(s), label: l })),
        { value: String(config.interval), onChange: (v) => change({ interval: Number(v) }) })));
    const shuffle = switchControl('Shuffle the playlist', config.shuffle, (next) => { setSwitch(shuffle, next); change({ shuffle: next }); });
    settingsHost.appendChild(row('Playlist: shuffle', 'Play the items in a random order, a new order each round.', shuffle));
    settingsHost.appendChild(row('Playlist: crossfade', 'How the next item fades in over the last.',
      selectControl(FADES.map(([ms, l]) => ({ value: String(ms), label: l })), { value: String(config.fadeMs), onChange: (v) => change({ fadeMs: Number(v) }) })));

    const pause = switchControl('Pause when not focused', config.pauseUnfocused, (next) => { setSwitch(pause, next); change({ pauseUnfocused: next }); });
    settingsHost.appendChild(row('Pause video when unfocused', 'A video always pauses while the window is hidden or minimised. This also pauses it when you click another window, which saves power.', pause));
    const still = switchControl('Low power', config.stillOnly, (next) => { setSwitch(still, next); change({ stillOnly: next }); });
    settingsHost.appendChild(row('Low power mode', 'Videos show their first frame instead of playing. The computer\'s reduce-motion setting does the same.', still));

    const pages = h('details', { className: 'bg-pages' });
    pages.appendChild(h('summary', { text: 'Dim some pages more' }));
    pages.appendChild(h('p', { className: 'setting-hint', text: 'Extra darkness on top of the dim above, for pages with a lot of text.' }));
    for (const page of PAGES) {
      const value = config.pageDim[page as PageId] || 0;
      pages.appendChild(h('div', { className: 'bg-page-row' }, h('span', { className: 'name', text: page }),
        slider(0, 90, value, '%', (v) => {
          const next = { ...config.pageDim };
          if (v === 0) delete next[page as PageId];
          else next[page as PageId] = v;
          change({ pageDim: next });
        }, 'Extra dim for ' + page)));
    }
    settingsHost.appendChild(pages);
  }

  function paintList(): void {
    listHost.replaceChildren(playlistEditor(list, {
      changed: async () => {
        list = await listBackgrounds();
        paintAll();
        if (config.source === 'playlist') void show();
      },
      use: async (folder) => {
        config = { ...config, source: 'playlist', playlist: folder };
        await show();
        persist();
        paintTiles();
        toast('Playlist is now your background', 'success');
      },
    }));
  }

  function paintAll(): void {
    if (!alive) return;
    paintGrid();
    paintList();
  }

  void (async () => {
    try {
      const [saved, found] = await Promise.all([getSettings(), listBackgrounds()]);
      config = configFromSettings(saved);
      list = found;
    } catch (e) {
      note.textContent = 'Backgrounds unavailable (' + describeError(e) + ')';
    }
    if (!alive) return;
    paintSettings();
    paintAll();
  })();

  return {
    nodes: [mainPanel, listPanel],
    dispose: () => {
      alive = false;
      if (saveTimer) {
        window.clearTimeout(saveTimer);
        void saveSettings(configToPatch(config)).catch(() => undefined);
      }
    },
  };
}

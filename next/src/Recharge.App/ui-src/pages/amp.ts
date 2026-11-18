/** The Amplifier: a full-window map editor (route #/amp/new or #/amp/<map folder>). The page wires panels to the editor; the editor hosts tools. */
import { call, describeError } from '../bridge.js';
import { h } from '../dom.js';
import { go } from '../navigation.js';
import { toast } from '../components/toast.js';
import { modal } from '../components/modal.js';
import { updateStatus } from '../settings/api.js';
import { loadAtlas } from '../amp/atlas.js';
import { AmpEditor } from '../amp/editor.js';
import { demoMap } from '../amp/demo.js';
import { emptyMap, fromMapJson, toMapJson } from '../amp/model.js';
import type { AmpMap } from '../amp/core/map.js';
import type { InstalledData } from '../lib/library.js';
import { backgroundPanel, brushPicker, layersPanel, propertiesPanel, rulesPanel, statusBar, toolPalette } from '../amp/ui/panels.js';
import { TOOLS } from '../amp/tools/index.js';
import { clearPreviewCache } from '../amp/preview.js';
import type { PageModule } from '../router.js';

// The Amplifier is beta-only for now: on the stable channel it shows a "coming soon" dialog instead of opening.
// Fails open (editor shown) if the channel can't be read, so beta is never blocked by a transient error.
async function ampBetaOnly(): Promise<boolean> {
  try {
    const status = await updateStatus();
    return status.channel !== 'beta';
  } catch {
    return false;
  }
}

interface LoadResult { id: string; map: string }
interface SaveResult { id: string }

let teardown: (() => void) | null = null;

async function open(id: string | undefined): Promise<{ map: AmpMap; id: string | null }> {
  if (!id || id === 'new') return { map: emptyMap(), id: null };
  if (id === 'demo' || id === 'demo-play') return { map: demoMap(), id: null };
  const loaded = await call<LoadResult>('amp.load', { id });
  return { map: fromMapJson(JSON.parse(loaded.map) as Record<string, unknown>), id: loaded.id };
}

export const ampPage: PageModule = {
  title: 'Amplifier',
  async mount(el, route): Promise<void> {
    teardown?.();
    // STABLE GATE: the Amplifier map maker is beta-only for now (full editor on beta).
    if (await ampBetaOnly()) {
      el.appendChild(h('p', { className: 'dim', text: 'The Amplifier map maker is coming to the stable release soon.' }));
      modal({
        title: 'Amplifier',
        body: 'Only available in beta for now!',
        actions: [{ label: 'OK', kind: 'primary' }],
        onClose: () => go('#/library'),
      });
      return;
    }
    let opened: { map: AmpMap; id: string | null };
    try {
      opened = await open(route.params.id);
    } catch (error) {
      el.appendChild(h('p', { className: 'dim', text: 'Could not open that map: ' + describeError(error) }));
      toast('Could not open the map: ' + describeError(error), 'error');
      return;
    }
    let mapId = opened.id;
    let dirty = false;

    const atlas = await loadAtlas();
    const canvas = h('canvas', { className: 'amp-canvas' });
    const status = h('span', { className: 'amp-status dim', text: mapId ? 'Opened ' + mapId : 'New map' });
    const nameInput = h('input', { className: 'amp-name', attrs: { type: 'text', value: opened.map.name, 'aria-label': 'Map name', spellcheck: 'false', maxlength: '60' } });
    const undoButton = h('button', { className: 'btn btn-ghost', attrs: { type: 'button', title: 'Undo (Ctrl+Z)' } }, h('span', { text: 'Undo' }));
    const redoButton = h('button', { className: 'btn btn-ghost', attrs: { type: 'button', title: 'Redo (Ctrl+Y)' } }, h('span', { text: 'Redo' }));
    const fitButton = h('button', { className: 'btn btn-ghost', attrs: { type: 'button', title: 'Fit the map in view (F)' } }, h('span', { text: 'Fit' }));
    const testButton = h('button', { className: 'btn btn-ghost', attrs: { type: 'button', title: 'Save, then launch the game straight into this map' } }, h('span', { text: 'Test in game' }));
    const uploadButton = h('button', { className: 'btn btn-ghost', attrs: { type: 'button', title: 'Save, then open your uploads to share this map' } }, h('span', { text: 'Upload' }));
    const saveButton = h('button', { className: 'btn btn-primary amp-save', attrs: { type: 'button', title: 'Save (Ctrl+S)' } }, h('span', { text: 'Save' }));
    const backButton = h('button', { className: 'btn btn-ghost', attrs: { type: 'button' } }, h('span', { text: 'Back' }));
    const loadButton = h('button', { className: 'btn btn-ghost', attrs: { type: 'button', title: 'Open a saved map' } }, h('span', { text: 'Load map' }));

    const editor = new AmpEditor(canvas, opened.map, atlas);
    const markDirty = (): void => { dirty = true; status.textContent = 'Unsaved changes'; };
    const tools = toolPalette(editor);
    const picker = brushPicker(editor, atlas);
    const rules = rulesPanel(editor, markDirty);
    const layers = layersPanel(editor);
    const backdrop = backgroundPanel(editor);
    const props = propertiesPanel(editor);
    const bar = statusBar(editor);
    const refresh = (): void => {
      tools.refresh(); picker.refresh(); rules.refresh(); layers.refresh(); backdrop.refresh(); props.refresh(); bar.refresh();
      undoButton.disabled = !editor.history.canUndo;
      redoButton.disabled = !editor.history.canRedo;
    };
    editor.onChange = markDirty;
    editor.onState = refresh;

    const side = h('div', { className: 'amp-side' }, picker.el);
    const inspector = h('div', { className: 'amp-inspector' }, props.el, layers.el, backdrop.el, rules.el);
    const top = h('div', { className: 'amp-bar' }, backButton, nameInput, undoButton, redoButton, fitButton, h('span', { className: 'amp-spacer' }), status, loadButton, testButton, uploadButton, saveButton);
    const body = h('div', { className: 'amp-body' }, tools.el, canvas, inspector, side);
    const root = h('div', { className: 'amp-root' }, top, body, bar.el);
    document.body.appendChild(root);
    document.body.classList.add('amp-open');

    undoButton.addEventListener('click', () => editor.undo());
    redoButton.addEventListener('click', () => editor.redo());
    fitButton.addEventListener('click', () => editor.fit());
    nameInput.addEventListener('input', () => { editor.map.name = nameInput.value; markDirty(); });

    let saving = false;
    const save = async (): Promise<void> => {
      if (saving) return;
      saving = true;
      saveButton.disabled = true;
      status.textContent = 'Saving…';
      try {
        const name = nameInput.value.trim() || 'Untitled map';
        editor.map.name = name;
        const result = await call<SaveResult>('amp.save', { ...(mapId ? { id: mapId } : {}), name, map: JSON.stringify(toMapJson(editor.map)) });
        if (!mapId) window.history.replaceState(null, '', '#/amp/' + encodeURIComponent(result.id));
        mapId = result.id;
        clearPreviewCache();
        dirty = false;
        status.textContent = 'Saved as ' + result.id;
        toast('Saved ' + name, 'success');
      } catch (error) {
        status.textContent = 'Save failed: ' + describeError(error);
        toast('Could not save: ' + describeError(error), 'error');
      } finally {
        saving = false;
        saveButton.disabled = false;
      }
    };
    saveButton.addEventListener('click', () => void save());

    // Test in game: save the map to the library, then start the game modded into it (game.testMap uses the loader's
    // autoplay.txt on a fresh launch so the map opens as a new game, not the main menu; it falls back to a live intent).
    const testInGame = async (): Promise<void> => {
      testButton.disabled = true;
      try {
        await save();
        if (!mapId || dirty) return;
        status.textContent = 'Launching the game…';
        await call('game.testMap', { folder: mapId });
        status.textContent = 'Launched ' + mapId;
        toast('Launching IGTAP into ' + (nameInput.value.trim() || mapId) + '. Other mods are off until you close the game.', 'success');
      } catch (error) {
        status.textContent = 'Could not launch: ' + describeError(error);
        toast('Could not launch the game: ' + describeError(error), 'error');
      } finally {
        testButton.disabled = false;
      }
    };
    testButton.addEventListener('click', () => void testInGame());
    uploadButton.addEventListener('click', () => {
      void save().then(() => { if (mapId && !dirty) go('#/library?kind=maps&view=uploads'); });
    });

    // Load map: a dropdown of saved maps; picking one opens it (same route the library's Edit uses).
    let loadMenu: HTMLElement | null = null;
    function onLoadDocDown(e: PointerEvent): void {
      if (loadMenu && !loadMenu.contains(e.target as Node) && !loadButton.contains(e.target as Node)) closeLoadMenu();
    }
    const closeLoadMenu = (): void => {
      loadMenu?.remove();
      loadMenu = null;
      document.removeEventListener('pointerdown', onLoadDocDown, true);
    };
    loadButton.addEventListener('click', () => {
      if (loadMenu) { closeLoadMenu(); return; }
      void (async (): Promise<void> => {
        let maps: { folder: string; name: string }[];
        try {
          const data = await call<InstalledData>('library.installed');
          maps = (data.maps || []).map((m) => ({ folder: m.folder, name: m.name })).sort((a, b) => a.name.localeCompare(b.name));
        } catch (error) {
          toast('Could not list maps: ' + describeError(error), 'error');
          return;
        }
        const menu = h('div', { className: 'amp-load-menu' });
        menu.style.cssText = 'position:fixed;z-index:1000;min-width:220px;max-height:60vh;overflow:auto;background:var(--panel,#1b1d1a);border:1px solid var(--border,#333a33);border-radius:8px;padding:4px;box-shadow:0 10px 28px rgba(0,0,0,.45)';
        const note = (text: string): void => { const n = h('div', { text }); n.style.cssText = 'padding:6px 10px;opacity:.6;font-size:13px'; menu.appendChild(n); };
        if (dirty) note('Unsaved changes will be lost');
        if (!maps.length) note('No saved maps yet');
        for (const m of maps) {
          const row = h('button', { attrs: { type: 'button' } }, h('span', { text: m.name || m.folder }));
          row.style.cssText = 'display:block;width:100%;text-align:left;padding:7px 10px;background:transparent;border:0;color:inherit;border-radius:6px;cursor:pointer;font:inherit;white-space:nowrap';
          if (m.folder === mapId) row.style.opacity = '.5';
          row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,.08)'; });
          row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
          row.addEventListener('click', () => { closeLoadMenu(); if (m.folder !== mapId) go('#/amp/' + encodeURIComponent(m.folder)); });
          menu.appendChild(row);
        }
        const r = loadButton.getBoundingClientRect();
        menu.style.top = Math.round(r.bottom + 4) + 'px';
        menu.style.right = Math.round(window.innerWidth - r.right) + 'px';
        document.body.appendChild(menu);
        loadMenu = menu;
        document.addEventListener('pointerdown', onLoadDocDown, true);
      })();
    });

    let confirming = false;
    backButton.addEventListener('click', () => {
      if (dirty && !confirming) {
        confirming = true;
        backButton.querySelector('span')!.textContent = 'Discard changes?';
        window.setTimeout(() => { confirming = false; const s = backButton.querySelector('span'); if (s) s.textContent = 'Back'; }, 4000);
        return;
      }
      go('#/library?kind=maps');
    });

    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      const k = e.key.toLowerCase();
      // During playtest the sim's own capturing listener handles movement + T/F/C/R/Escape; the edit shortcuts below still run so you can keep building.
      const playing = editor.playtest.active;
      if (e.ctrlKey || e.metaKey) {
        if (k === 's') { e.preventDefault(); void save(); }
        else if (k === 'z') { e.preventDefault(); if (e.shiftKey) editor.redo(); else editor.undo(); }
        else if (k === 'y') { e.preventDefault(); editor.redo(); }
        return;
      }
      if (e.altKey) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { editor.deleteSelection(); return; }
      if (k === 't') { if (!playing) editor.startPlaytest(); return; }
      if (k === 'f') { if (!playing) editor.fit(); return; }
      if (k === '[') { editor.setSize(editor.state.size - 1); return; }
      if (k === ']') { editor.setSize(editor.state.size + 1); return; }
      if (k === ',') { editor.rotate(1); return; }
      if (k === '.') { editor.rotate(-1); return; }
      const hit = TOOLS.find((x) => x.hotkey.toLowerCase() === k);
      if (hit) editor.setTool(hit.id);
    };
    window.addEventListener('keydown', onKey);

    editor.layout();
    editor.fit();
    if (route.params.id === 'demo-play') {
      // the example, already mid-run (a headless snapshot cannot press keys): the player has ridden the platform for 2.5 seconds
      editor.startPlaytest();
      for (let i = 0; i < 150; i++) editor.playtest.tick(i < 40 ? 0 : 2);
      editor.camera.x = editor.playtest.state.x; editor.camera.y = editor.playtest.state.y + 40; editor.camera.zoom = 1.2;
      editor.redraw();
    }
    refresh();
    // handles for tests and headless snapshots
    (window as unknown as { __amp?: unknown }).__amp = { editor, save, refresh, testInGame };

    teardown = () => {
      closeLoadMenu();
      window.removeEventListener('keydown', onKey);
      editor.dispose();
      root.remove();
      document.body.classList.remove('amp-open');
      delete (window as unknown as { __amp?: unknown }).__amp;
      teardown = null;
    };
  },
  unmount(): void { teardown?.(); },
};

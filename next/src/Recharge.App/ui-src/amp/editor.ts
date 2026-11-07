/**
 * The editor host: owns the camera, the history, the picture cache and the input, and runs whichever tool is active.
 * It knows nothing about any one tool or content type; those come from tools/ and content/.
 */
import type { Atlas } from './atlas.js';
import type { ContentType } from './content/types.js';
import { brushOf, contentById, contentOfLayer, PAINTABLE } from './content/index.js';
import { COURSE } from './content/course.js';
import { addLayer, dataLayer, layerIdOf, moveLayer, removeLayer, type Role } from './core/layers.js';
import { onBackdropLoaded, type BackdropId } from './backdrop.js';
import { onDecoLoaded } from './deco-art.js';
import { onMossLoaded } from './moss-art.js';
import { onVineLoaded } from './vine-art.js';
import { onCourseArtLoaded } from './course-view.js';
import { Camera } from './core/camera.js';
import { History } from './core/history.js';
import type { AmpMap } from './core/map.js';
import { parseKey, type Cell } from './core/types.js';
import { mapBounds } from './model.js';
import { Playtest } from './sim/playtest.js';
import { ChunkCache, drawBackground, drawCourse, drawGrid, drawLive, highlightCells } from './render.js';
import { TOOLS, toolById } from './tools/index.js';
import type { EditorState, PointerInfo, Tool, ToolApi } from './tools/types.js';

export class AmpEditor {
  map: AmpMap;
  readonly camera = new Camera();
  readonly history = new History();
  readonly state: EditorState = { content: 'blocks', brush: 'plate', size: 1, draft: 'plate', layer: 'main', selection: null };
  /** The background shown behind the map (kept in the map file, a view aid: the game plays the level's own). */
  get backdrop(): BackdropId { return this.map.backdrop; }
  set backdrop(id: BackdropId) { this.map.backdrop = id; this.redraw(); this.onChange(); this.onState(); }
  tool: Tool = TOOLS[0];
  hover: Cell | null = null;
  playtest: Playtest;
  /** Fires after any change to the map (the page marks it unsaved). */
  onChange: () => void = () => {};
  /** Fires when the tool, brush, size, history availability or hover changes (the page refreshes its panels). */
  onState: () => void = () => {};

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cache: ChunkCache;
  private atlas: Atlas;
  private frame = 0;
  private pressed = false;
  private panning: { x: number; y: number; camX: number; camY: number } | null = null;
  private spaceDown = false;
  private unlisten: Array<() => void> = [];
  private observer: ResizeObserver | null = null;
  private unsubscribe: () => void;
  readonly api: ToolApi;

  constructor(canvas: HTMLCanvasElement, map: AmpMap, atlas: Atlas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    this.map = map;
    this.atlas = atlas;
    this.cache = new ChunkCache(map, atlas);
    this.unsubscribe = map.onChange((layer, key) => this.changed(layer, key));
    this.api = {
      map, camera: this.camera, state: this.state,
      edit: (layer, key, value) => this.edit(layer, key, value),
      beginStroke: () => this.history.begin(),
      endStroke: () => { if (this.history.end()) this.onState(); },
      redraw: () => this.redraw(),
      setBrush: (content, brush, value) => this.setBrush(content, brush, value),
      setTool: (id) => this.setTool(id),
      layerFor: (content) => this.layerFor(content),
      select: (sel) => { this.state.selection = sel; this.onState(); },
      setLayer: (id) => this.setLayer(id),
    };
    this.unlisten.push(onBackdropLoaded(() => this.redraw()), onDecoLoaded(() => this.redraw()), onMossLoaded(() => this.redraw()), onVineLoaded(() => this.redraw()), onCourseArtLoaded(() => this.redraw()));
    this.playtest = this.makePlaytest();
    this.bind();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
  }

  private makePlaytest(): Playtest {
    return new Playtest(this.map, this.camera, () => this.redraw(), () => { this.canvas.style.cursor = this.tool.cursor; this.onState(); });
  }

  /** Swap in another map (opening one); history starts over. */
  setMap(map: AmpMap): void {
    this.unsubscribe();
    this.map = map;
    this.api.map = map;
    this.cache.setMap(map);
    this.unsubscribe = map.onChange((layer, key) => this.changed(layer, key));
    this.history.clear();
    this.playtest.stop();
    this.playtest = this.makePlaytest();
    this.redraw();
    this.onState();
  }

  private changed(layer: string, key: string): void {
    if (layer !== COURSE) { const c = parseKey(key); this.cache.invalidate(c.x, c.y, layer === 'moss' || layer.startsWith('moss@') ? 4 : 2); }
    this.onChange();
  }

  /** Change a value and record it for undo. */
  edit(layer: string, key: string, value: unknown): void {
    if (layer !== COURSE) {
      const def = this.map.layerDefs.find((l) => l.id === layerIdOf(layer));
      if (def?.locked) return;
    }
    const before = this.map.get(layer, key);
    if (JSON.stringify(before) === JSON.stringify(value)) return;
    this.map.set(layer, key, value);
    this.history.record({ layer, key, before, after: value });
  }

  undo(): void { this.apply(this.history.undo(), 'before'); }
  redo(): void { this.apply(this.history.redo(), 'after'); }
  private apply(step: Array<{ layer: string; key: string; before: unknown; after: unknown }> | null, side: 'before' | 'after'): void {
    if (!step) return;
    for (const c of step) this.map.set(c.layer, c.key, c[side]);
    this.redraw();
    this.onState();
  }

  // ---- state ----

  setTool(id: string): void {
    const next = toolById(id);
    if (!next || next === this.tool) return;
    this.tool.deactivate?.(this.api);
    this.tool = next;
    next.activate?.(this.api);
    this.canvas.style.cursor = this.spaceDown ? 'grab' : next.cursor;
    this.redraw();
    this.onState();
  }

  setBrush(content: string, brush: string, value?: unknown): void {
    const picked = brushOf({ content, brush });
    if (!picked) return;
    this.state.content = content;
    this.state.brush = brush;
    this.state.draft = value !== undefined ? JSON.parse(JSON.stringify(value)) : picked.content.place(picked.brush, { text: 'Sign' });
    // (the arrow tool picks the arrow brush itself)
    if (!(content === 'arrows' && this.tool.id === 'arrow') && ['erase', 'pick', 'select', 'start', 'end', 'reset', 'spawn', 'xspawn', 'arrow'].includes(this.tool.id)) this.setTool('paint');
    this.redraw();
    this.onState();
  }

  /** The data layer a content type is placed in: the active layer if its role fits, else the first layer that fits. Null if that layer is locked or hidden. */
  layerFor(content: string): string | null {
    const c = contentById(content);
    if (!c) return null;
    const active = this.map.layerDefs.find((l) => l.id === this.state.layer);
    const fit = active && c.roles.includes(active.role) ? active : this.map.layerDefs.find((l) => l.role === 'main' && c.roles.includes('main')) || this.map.layerDefs.find((l) => c.roles.includes(l.role));
    if (!fit || fit.locked || !fit.visible) return null;
    return dataLayer(c.layer, fit.id);
  }

  setLayer(id: string): void {
    if (!this.map.layerDefs.some((l) => l.id === id)) return;
    this.state.layer = id;
    this.onState();
  }

  // ---- selection and layers ----

  /** The selected placed thing with its content type, or null (also when it has since been erased). */
  selected(): { layer: string; key: string; value: unknown; content: ContentType } | null {
    const sel = this.state.selection;
    const content = sel && contentOfLayer(sel.layer);
    const value = sel ? this.map.get(sel.layer, sel.key) : undefined;
    return sel && content && value !== undefined ? { ...sel, value, content } : null;
  }

  /** Several map edits as one undo step (an option that lives in other keys of the map, like a course's reward). */
  editMany(edits: Array<{ layer: string; key: string; value: unknown }>): void {
    this.history.begin();
    for (const e of edits) this.edit(e.layer, e.key, e.value);
    this.history.end();
    this.redraw();
    this.onState();
  }

  /** Replace the selected thing's value (one undo step). */
  editSelection(value: unknown): void {
    const sel = this.selected();
    if (!sel) return;
    this.history.begin();
    this.edit(sel.layer, sel.key, value);
    this.history.end();
    this.redraw();
    this.onState();
  }

  /** Change what the brush places (its options). */
  setDraft(value: unknown): void { this.state.draft = value; this.redraw(); this.onState(); }

  deleteSelection(): void {
    const sel = this.selected();
    if (!sel) return;
    this.history.begin();
    this.edit(sel.layer, sel.key, undefined);
    sel.content.cleanup?.(this.map, (l, k, v) => this.edit(l, k, v));
    this.history.end();
    this.state.selection = null;
    this.redraw();
    this.onState();
  }

  private layersChanged(): void { this.cache.clear(); this.redraw(); this.onChange(); this.onState(); }
  toggleLayer(id: string, what: 'visible' | 'locked'): void {
    const l = this.map.layerDefs.find((x) => x.id === id);
    if (!l) return;
    l[what] = !l[what];
    this.layersChanged();
  }
  newLayer(role: Role, name: string): void { this.state.layer = addLayer(this.map, name, role).id; this.layersChanged(); }
  dropLayer(id: string): boolean {
    if (!removeLayer(this.map, id)) return false;
    if (this.state.layer === id) this.state.layer = (this.map.layerDefs.find((l) => l.role === 'main') || this.map.layerDefs[0]).id;
    if (this.state.selection && layerIdOf(this.state.selection.layer) === id) this.state.selection = null;
    this.history.clear();
    this.layersChanged();
    return true;
  }
  shiftLayer(id: string, by: number): void { if (moveLayer(this.map, id, by)) this.layersChanged(); }
  renameLayer(id: string, name: string): void {
    const l = this.map.layerDefs.find((x) => x.id === id);
    if (l && name.trim()) { l.name = name.trim(); this.onChange(); this.onState(); }
  }

  setSize(size: number): void { this.state.size = Math.max(1, Math.min(8, size)); this.redraw(); this.onState(); }
  /** Turn the selected thing, or the brush's draft, a quarter turn (for content that can turn). */
  rotate(by: number): void {
    const sel = this.state.selection;
    const c = sel ? contentOfLayer(sel.layer) : contentById(this.state.content);
    if (!c?.rotate) return;
    if (sel) this.edit(sel.layer, sel.key, c.rotate(this.map.get(sel.layer, sel.key), by));
    else this.state.draft = c.rotate(this.state.draft, by);
    this.redraw();
    this.onState();
  }

  /** Frame everything painted (or the origin if the map is empty). */
  fit(): void {
    this.camera.width = this.canvas.clientWidth || this.camera.width;
    this.camera.height = this.canvas.clientHeight || this.camera.height;
    const b = mapBounds(this.map);
    if (!b) { this.camera.x = 0; this.camera.y = 160; this.camera.zoom = 1.5; } else this.camera.fitCells(b.x0, b.y0, b.x1, b.y1 + 4);
    this.redraw();
    this.onState();
  }

  startPlaytest(): void { this.playtest.start(); this.onState(); }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of PAINTABLE) out[c.id] = this.map.total(c.layer);
    return out;
  }

  // ---- input ----

  private info(e: PointerEvent): PointerInfo {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    return { cell: this.camera.cellAt(sx, sy), sx, sy, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
  }

  private bind(): void {
    const c = this.canvas;
    const on = (el: HTMLElement | Window, type: string, fn: (e: any) => void, opts?: AddEventListenerOptions): void => {
      el.addEventListener(type, fn, opts);
      this.unlisten.push(() => el.removeEventListener(type, fn, opts));
    };
    on(c, 'contextmenu', (e: Event) => e.preventDefault());
    on(c, 'pointerdown', (e: PointerEvent) => {
      if (this.playtest.active) return;
      try { c.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer (the scripted driver) has nothing to capture */ }
      const p = this.info(e);
      if (e.button === 1 || e.button === 2 || this.spaceDown) {
        this.panning = { x: p.sx, y: p.sy, camX: this.camera.x, camY: this.camera.y };
        c.style.cursor = 'grabbing';
        return;
      }
      if (e.button !== 0) return;
      this.pressed = true;
      this.tool.down(this.api, p);
    });
    on(c, 'pointermove', (e: PointerEvent) => {
      const p = this.info(e);
      if (this.panning) {
        this.camera.x = this.panning.camX - (p.sx - this.panning.x) / this.camera.zoom;
        this.camera.y = this.panning.camY + (p.sy - this.panning.y) / this.camera.zoom;
        this.redraw();
        return;
      }
      const moved = !this.hover || this.hover.x !== p.cell.x || this.hover.y !== p.cell.y;
      this.hover = p.cell;
      if (moved) { this.tool.move?.(this.api, p, this.pressed); this.redraw(); this.onState(); }
    });
    const up = (e: PointerEvent): void => {
      const p = this.info(e);
      if (this.panning) { this.panning = null; c.style.cursor = this.spaceDown ? 'grab' : this.tool.cursor; }
      else if (this.pressed) this.tool.up?.(this.api, p);
      this.pressed = false;
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    };
    on(c, 'pointerup', up);
    on(c, 'pointercancel', up);
    on(c, 'pointerleave', () => { this.hover = null; this.redraw(); this.onState(); });
    on(c, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.camera.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      this.redraw();
      this.onState();
    }, { passive: false });
    const typing = (e: KeyboardEvent): boolean => { const t = e.target as HTMLElement | null; return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); };
    on(window, 'keydown', (e: KeyboardEvent) => { if (e.code === 'Space' && !typing(e) && !this.playtest.active) { this.spaceDown = true; c.style.cursor = 'grab'; e.preventDefault(); } });
    on(window, 'keyup', (e: KeyboardEvent) => { if (e.code === 'Space') { this.spaceDown = false; c.style.cursor = this.tool.cursor; } });
    c.style.cursor = this.tool.cursor;
  }

  // ---- drawing ----

  /** Re-measure the canvas (after it is put in the page, or the window changes). */
  layout(): void { this.resize(); }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.camera.width = this.canvas.clientWidth;
    this.camera.height = this.canvas.clientHeight;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.draw();
  }

  redraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  draw(): void {
    const ctx = this.ctx, dpr = window.devicePixelRatio || 1, cam = this.camera;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackground(ctx, cam, this.map.backdrop, this.map.parallax);
    drawGrid(ctx, cam);
    const env = { ctx, atlas: this.atlas };
    const at = (x: number, y: number): [number, number] => cam.toScreen(x * 32, (y + 1) * 32);
    const skip = this.playtest.active ? (c: { id: string }): boolean => c.id === 'movers' : undefined;
    drawLive(env, this.map, at, 32 * cam.zoom, 'under', cam.visible(), skip);
    this.cache.draw(ctx, cam);
    drawLive(env, this.map, at, 32 * cam.zoom, 'over', cam.visible(), skip);
    drawCourse(ctx, cam, this.map);
    if (this.playtest.active) { this.playtest.draw(ctx, cam, this.atlas); return; }
    this.tool.overlay?.(this.api, ctx, this.hover);
    if (!this.tool.overlay && this.hover) highlightCells(ctx, cam, [this.hover]);
  }

  dispose(): void {
    for (const u of this.unlisten) u();
    this.unlisten = [];
    this.observer?.disconnect();
    this.unsubscribe();
    this.playtest.stop();
    if (this.frame) cancelAnimationFrame(this.frame);
  }
}

// What's shown over the map as outlines rather than art: course gates, timer resets
// and their links, the spawn and extra spawns, trigger zones, and level things that
// are only an area (checkpoints, long falls, credits). They select, move and delete
// like things; course markers have ids "m:<course>:<start|end|screen|reset:i>",
// the main spawn "m:spawn".
import { partsOf } from './render/world.js';

export const START_BOX = { dx: 0, dy: 0, w: 60, h: 250 };
export const END_BOX = { dx: 0, dy: -26, w: 240, h: 13 };
export const RESET_BOX = { dx: 0, dy: 150, w: 20, h: 400 };
export const SPAWN_BOX = { dx: 0, dy: 0, w: 32, h: 64 };
export const SCREEN_BOX = { dx: 3, dy: 3, w: 385, h: 172 };
export const COURSE_COLORS = ['#41f88d', '#4fc3ff', '#ffb347', '#ff6fd8', '#c792ea', '#f5e663', '#7ee0c3', '#ff8a80'];
const C = { spawn: '#5ec8f0', reset: '#f0a040', trigger: '#e8d85a', credits: '#f0a0d0', vman: '#b07bff' };
const TRIGGER_COLORS = { media: '#c792ff', show: '#5fd4a0', hide: '#e0736a', toggle: '#e0c36a', move: '#6aa8e0', teleport: '#b07bff', kill: '#ff4f6d', respawn: '#41f88d', zoom: '#7ad7f0', message: '#f0f07a' };
const TRIGGER_LABELS = { media: 'Area / music', show: 'Show group', hide: 'Hide group', toggle: 'Toggle group', move: 'Move group', teleport: 'Teleport', kill: 'Kill zone', respawn: 'Set respawn', zoom: 'Camera zoom', message: 'Message' };

export const courseColor = (doc, id) => COURSE_COLORS[Math.max(0, doc.courses.findIndex((c) => c.id === id)) % COURSE_COLORS.length];
// Where a finished course's screen goes: where it was put, or just left of its start gate.
export function courseScreen(c) {
  if (!c?.start || !c?.end) return null;
  if (c.screen) return c.screen;
  return { x: Math.round(c.start.x - START_BOX.w / 2 - 40 - SCREEN_BOX.w / 2 - SCREEN_BOX.dx), y: Math.round(c.start.y + 20) };
}

export class Markers {
  constructor(ed) { this.ed = ed; }
  get doc() { return this.ed.doc; }

  // Every marker: { id, x, y, box, color, label, kind } (box centred at x + dx, y + dy).
  list() {
    const d = this.doc, out = [];
    d.courses.forEach((c, i) => {
      const col = COURSE_COLORS[i % COURSE_COLORS.length], n = i + 1;
      if (c.start) out.push({ id: `m:${c.id}:start`, ...c.start, box: START_BOX, color: col, label: 'START ' + n, kind: 'gate' });
      if (c.end) out.push({ id: `m:${c.id}:end`, ...c.end, box: END_BOX, color: col, label: 'END ' + n, kind: 'gate' });
      (c.resets || []).forEach((r, k) => out.push({ id: `m:${c.id}:reset:${k}`, x: r.x, y: r.y, box: r.box || RESET_BOX, color: C.reset, label: 'TIMER RESET ' + n, kind: 'reset' }));
      const s = courseScreen(c);
      if (s) out.push({ id: `m:${c.id}:screen`, ...s, box: SCREEN_BOX, color: col, label: 'COURSE ' + n + ' SCREEN', kind: 'screen', quiet: true });
    });
    if (d.meta.spawn) out.push({ id: 'm:spawn', ...d.meta.spawn, box: SPAWN_BOX, color: C.spawn, label: 'SPAWN', kind: 'spawn' });
    let sp = 1;
    for (const e of d.entities) {
      if (e.kind === 'spawn') out.push({ id: e.id, x: e.x, y: e.y, box: SPAWN_BOX, color: C.spawn, label: 'SPAWN ' + ++sp, kind: 'spawn' });
      else if (e.kind === 'trigger') out.push({ id: e.id, x: e.x, y: e.y, box: { dx: 0, dy: 0, w: e.w || 100, h: e.h || 100 }, color: TRIGGER_COLORS[e.t] || C.trigger, label: (TRIGGER_LABELS[e.t] || 'Trigger') + (e.zone ? ' · area ' + e.zone : ''), kind: 'trigger' });
      else if (e.kind === 'unit') {
        const ob = partsOf(this.ed.base, e)?.object;
        const credits = ob && (ob.cls === 'EndCreditsTrigger' || ob.cls === 'FakeCreditsControlScript'), vman = credits && e.cfg?.credits === 'vman';
        if (!ob || (ob.kind !== 'trigger' && !credits)) continue;
        out.push({ id: e.id, x: e.x, y: e.y, box: { dx: ob.x || 0, dy: ob.y || 0, w: ob.w, h: ob.h }, color: vman ? C.vman : credits ? C.credits : C.trigger, label: vman ? 'V-man credits' : ob.label || partsOf(this.ed.base, e).name, kind: 'area', far: credits });
      }
    }
    return out;
  }

  at(wx, wy) {
    const list = this.list(), near = 6 / this.ed.cam.scale;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i], cx = m.x + m.box.dx, cy = m.y + m.box.dy;
      if (Math.abs(wx - cx) <= m.box.w / 2 + near && Math.abs(wy - cy) <= m.box.h / 2 + near) {
        // Big areas take clicks on their edge only, so what's inside stays reachable.
        const edge = m.kind === 'trigger' || m.kind === 'area';
        if (!edge || Math.abs(Math.abs(wx - cx) - m.box.w / 2) < near || Math.abs(Math.abs(wy - cy) - m.box.h / 2) < near) return m.id;
      }
    }
    return null;
  }

  // ---- course markers ----
  pos(id) {
    if (!id.startsWith('m:')) return this.doc.get(id);
    if (id === 'm:spawn') return this.doc.meta.spawn;
    const [, cid, which, k] = id.split(':'), c = this.doc.courses.find((x) => x.id === cid);
    if (!c) return null;
    if (which === 'reset') return c.resets?.[+k];
    return which === 'screen' ? courseScreen(c) : c[which];
  }
  set(id, at) {
    const d = this.doc;
    d.touchMeta();
    if (id === 'm:spawn') { d.meta.spawn = { x: at.x, y: at.y }; return; }
    const [, cid, which, k] = id.split(':'), c = d.courses.find((x) => x.id === cid);
    if (!c) return;
    if (which === 'reset') { if (c.resets?.[+k]) c.resets[+k] = { ...c.resets[+k], x: at.x, y: at.y }; }
    else c[which] = { x: at.x, y: at.y };
  }
  remove(id) {
    const d = this.doc;
    d.touchMeta();
    if (id === 'm:spawn') { d.meta.spawn = null; return; }
    const [, cid, which, k] = id.split(':'), c = d.courses.find((x) => x.id === cid);
    if (!c) return;
    if (which === 'reset') c.resets.splice(+k, 1);
    else if (which === 'screen') delete c.screen;
    else d.courses.splice(d.courses.indexOf(c), 1);
  }

  // ---- drawn over the map ----
  draw(g) {
    const ed = this.ed, s = ed.cam.scale, S = (x, y) => ed.toScreen(x, y), W = ed.ui.clientWidth, H = ed.ui.clientHeight;
    const list = this.list();
    g.save();
    // Each course's start and end, joined.
    this.doc.courses.forEach((c, i) => {
      if (!c.start || !c.end) return;
      const a = S(c.start.x + START_BOX.dx, c.start.y + START_BOX.dy), b = S(c.end.x + END_BOX.dx, c.end.y + END_BOX.dy);
      g.strokeStyle = COURSE_COLORS[i % COURSE_COLORS.length]; g.globalAlpha = 0.5; g.lineWidth = 1.5; g.setLineDash([8, 6]);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    });
    g.globalAlpha = 1; g.setLineDash([]);
    for (const m of list) {
      if (m.quiet) continue;
      if (m.kind === 'reset' && s < 0.1) continue;
      if (m.kind === 'area' && s < (m.far ? 0.03 : 0.15) && !ed.selection.has(m.id)) continue;
      const c = S(m.x + m.box.dx, m.y + m.box.dy), w = Math.max(4, m.box.w * s), h = Math.max(3, m.box.h * s);
      if (c.x + w < 0 || c.x - w > W || c.y + h < 0 || c.y - h > H) continue;
      g.strokeStyle = m.color; g.lineWidth = 1.5;
      if (m.kind === 'trigger' || m.kind === 'area') {
        g.setLineDash([5, 4]);
        g.fillStyle = m.color + '14';
        if (m.kind === 'trigger') g.fillRect(c.x - w / 2, c.y - h / 2, w, h);
      } else {
        g.fillStyle = m.color + '2e';
        g.fillRect(c.x - w / 2, c.y - h / 2, w, h);
      }
      g.strokeRect(c.x - w / 2, c.y - h / 2, w, h);
      g.setLineDash([]);
      if (s >= 0.12) this.label(g, m.label, c.x - w / 2, c.y - h / 2 - 6, m.color);
    }
    g.restore();
  }
  label(g, text, x, y, color) {
    g.font = '600 11px sans-serif';
    const w = g.measureText(text).width + 12;
    g.fillStyle = 'rgba(14, 14, 14, 0.85)';
    g.beginPath(); g.roundRect(x, y - 14, w, 16, 8); g.fill();
    g.fillStyle = color; g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillText(text, x + 6, y - 6);
  }
}

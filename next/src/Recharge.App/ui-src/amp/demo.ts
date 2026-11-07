/** An example map (route #/amp/demo): ground, hazards, a spring, moving platforms, scenery on three layers and a background. For trying the editor and for snapshots. */
import { newTrigger } from './content/triggers.js';
import { MOVER_DEFAULT } from './content/mover.js';
import { addLayer } from './core/layers.js';
import { mossCell } from './content/moss.js';
import { cellKey } from './core/types.js';
import { emptyMap } from './model.js';
import type { AmpMap } from './core/map.js';

export function demoMap(): AmpMap {
  const m = emptyMap('Example: Mossy shafts');
  const block = (x0: number, x1: number, y0: number, y1: number, set: string, layer = 'blocks'): void => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) m.set(layer, cellKey(x, y), set);
  };
  block(-4, 6, -4, -1, 'plate');
  block(22, 34, -4, 3, 'plate');
  block(14, 18, 3, 3, 'panel');
  block(2, 6, 0, 1, 'plate'); // a step: inside corners
  block(-4, 34, -8, -5, 'darkplate');
  block(-4, -4, 0, 8, 'darkpanel');
  block(26, 29, 4, 4, 'grate');
  block(8, 10, -2, -2, 'blue');
  m.set('spikes', cellKey(11, -1), 'spike:0');
  m.set('spikes', cellKey(12, -1), 'spike:0');
  // spikes that sit on what they touch (floor, ceiling, walls), a blue and a dark one, and a hand-turned row
  m.set('spikes', cellKey(14, 2), 'spike:a');
  m.set('spikes', cellKey(15, 2), 'spike:a');
  m.set('spikes', cellKey(21, 0), 'spike:a');
  m.set('spikes', cellKey(21, 1), 'spike:a');
  m.set('spikes', cellKey(35, 0), 'dark:a');
  m.set('spikes', cellKey(35, 1), 'dark:a');
  m.set('spikes', cellKey(-3, 4), 'orange:a');
  m.set('spikes', cellKey(-3, 5), 'orange:a');
  m.set('spikes', cellKey(28, 5), 'blue:a');
  m.set('spikes', cellKey(8, 2), 'orange:0');
  m.set('spikes', cellKey(9, 2), 'orange:1');
  m.set('spikes', cellKey(10, 2), 'orange:2');
  // moss: a band along the top of the right-hand block, a patch on the left ground
  const patch = (x0: number, x1: number, y0: number, y1: number): void => {
    for (let x = x0; x <= x1; x += 2) for (let y = y0; y <= y1; y += 2) { const c = mossCell(x, y); m.set('moss', cellKey(c.x, c.y), true); }
  };
  patch(22, 33, 3, 3);
  patch(-4, 1, -1, -1);
  patch(31, 33, 5, 5);
  // thorn vines: single pictures, upright, turned, and a big one
  m.set('vines', cellKey(18, -1), 'smallArc:0');
  m.set('vines', cellKey(26, 8), 'Thorn:2');
  m.set('vines', cellKey(-6, 3), 'BigThornArc:1');
  m.set('objects', cellKey(5, 0), { t: 'spring' });
  m.set('objects', cellKey(0, 0), { t: 'checkpoint' });
  m.set('objects', cellKey(2, 1), { t: 'sign', text: 'Ride the platform' });
  // movers: a ping-pong platform over the gap, a lift, a block that moves on touch
  m.set('movers', cellKey(9, 1), { ...MOVER_DEFAULT, dx: 11, dy: 0, w: 3, h: 1, time: 3, back: 3, look: 'grate' });
  m.set('movers', cellKey(20, -2), { ...MOVER_DEFAULT, dx: 0, dy: 6, w: 2, h: 1, time: 2.5, back: 2.5, look: 'zip' });
  m.set('movers', cellKey(16, 6), { ...MOVER_DEFAULT, dx: 0, dy: -3, w: 3, h: 2, auto: false, look: 'plate', time: 0.8, back: 2 });
  // trigger zones: a message, a camera zoom, a teleport with its marker, a group toggle
  m.set('triggers', cellKey(4, 2), { ...newTrigger('message'), text: 'Mind the gap!', w: 192, h: 128, once: true });
  m.set('triggers', cellKey(14, 3), { ...newTrigger('zoom'), w: 192, h: 192 });
  m.set('triggers', cellKey(27, 5), { ...newTrigger('toggle'), group: 'door', w: 128, h: 128 });
  m.set('triggers', cellKey(-8, 5), { ...newTrigger('media'), music: 'game:Overgrowth', background: 'level', w: 160, h: 160 });
  // scenery: behind (back layer), in the main layer (behind the ground tiles), in front
  const fg2 = addLayer(m, 'Foreground 2', 'front');
  m.set('deco@back', cellKey(1, 3), { s: 'Mossy - MossyHills_2', an: 'b', sc: 1.2, a: 0.8 });
  m.set('deco@back', cellKey(31, 4), { s: 'Mossy - MossyHills_8', an: 'b', sc: 0.9, a: 0.8 });
  m.set('deco', cellKey(5, 0), { s: 'Mossy - MossyHills_5', an: 'b' });
  m.set('deco', cellKey(24, 4), { s: 'Mossy - MossyHills_6', an: 'b', sc: 0.5 });
  m.set('deco', cellKey(30, 4), { s: 'Mossy - Decorations&Hazards_9', an: 'b', fx: true });
  m.set('deco', cellKey(3, -1), { s: 'Mossy - Decorations&Hazards_22', an: 'b' });
  m.set('deco@front', cellKey(7, 7), { s: 'Mossy - Hanging Plants_0', an: 't', sc: 0.7 });
  m.set('deco@front', cellKey(15, 8), { s: 'Mossy - Hanging Plants_5', an: 't', sc: 0.6 });
  m.set('deco@' + fg2.id, cellKey(23, 8), { s: 'Mossy - Hanging Plants_2', an: 't', sc: 0.8 });
  m.set('course', 'start', { x: -2, y: 0 });
  m.set('course', 'spawn', { x: -1, y: 0 });
  m.set('course', 'end', { x: 32, y: 4 });
  m.set('course', 'meta', { reward: { currency: 'Cash', amount: 50 } });
  m.set('course', 'reset:1', { x: 30, y: 4 });
  // a second course on the right-hand block, with a course checkpoint filed under it
  m.set('course', 'c2:start', { x: 23, y: 4 });
  m.set('course', 'c2:end', { x: 25, y: 4 });
  m.set('objects', cellKey(24, 4), { t: 'courseCheckpoint', course: 'c2' });
  m.set('objects', cellKey(29, 4), { t: 'checkpoint', course: 'c1' });
  // a guide arrow: a circle, a bend and a head
  m.set('arrows', cellKey(4, 5), { cells: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1], [4, 2], [4, 3]] });
  m.backdrop = 'overgrown';
  return m;
}

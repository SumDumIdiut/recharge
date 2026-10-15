// A checkpoint's flag and respawn point end up where the Amplifier shows them: editor model -> export -> Navigator's math.
// node tests/amp-checkpoint.test.mjs
import assert from 'node:assert/strict';
import { checkpointAnchor, checkpointExport, gameCheckpoint, CP_LIFT } from '../src/maps/checkpoint.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, a + ' vs ' + b);

test('the game\'s own sized boxes leave the checkpoint where it was', () => {
  for (const t of [{ w: 400, h: 400, dx: 0, dy: 150 }, { w: 100, h: 300, dx: 0, dy: 100 }, { w: 100, h: 200, dx: 0, dy: 50 }]) {
    const e = checkpointExport(10, 20, t);
    assert.deepEqual([e.x, e.y, e.trigger.dx, e.trigger.dy], [10, 20, t.dx, t.dy]);
  }
  const e = checkpointExport(0, 0, { w: 400, h: 400, dx: 0, dy: 150 });
  assert.deepEqual([e.x, e.y, e.trigger.dx, e.trigger.dy], [0, 0, 0, 150]);
});

test('the user\'s draft: a 112x96 box 150 above the click puts the flag in the box, not 150 below it', () => {
  for (const [x, y] of [[2960, -103], [3104, 64]]) {
    const t = { w: 112, h: 96, dx: 0, dy: 150 }, e = checkpointExport(x, y, t);
    const boxBottom = y + 150 - 48, boxTop = y + 150 + 48;
    assert.ok(e.y >= boxBottom && e.y <= boxTop, 'flag y ' + e.y + ' within box ' + boxBottom + '..' + boxTop);
    assert.equal(e.x, x);
    // Navigator: flag at the clone's position, trigger centre at clone + (dx, dy) = the editor's box centre.
    const g = gameCheckpoint([e.x, e.y], e.trigger, [e.x + 7, e.y - 3], [1, 1]);
    near(g.trigger[0], x + t.dx); near(g.trigger[1], y + t.dy);
    assert.deepEqual(g.flag, [e.x, e.y]);
  }
});

test('any box: the exported trigger covers exactly the editor box, the flag stands in it', () => {
  for (const t of [{ w: 16, h: 16, dx: 80, dy: -300 }, { w: 640, h: 48, dx: -32, dy: 10 }, { w: 112, h: 96, dx: 0, dy: 150 }]) {
    const e = checkpointExport(321, -77, t), a = checkpointAnchor(321, -77, t);
    near(e.x + e.trigger.dx, 321 + t.dx); near(e.y + e.trigger.dy, -77 + t.dy);
    assert.ok(Math.abs(e.x - a.x) <= 0.5 && Math.abs(e.y - a.y) <= 0.5);
    const top = e.y + e.trigger.dy + t.h / 2, bottom = e.y + e.trigger.dy - t.h / 2;
    assert.ok(e.y >= bottom - 0.5 && e.y <= top + 0.5);
  }
});
console.log(n + ' passed');

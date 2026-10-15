// Where a checkpoint's flag and respawn point sit, so the game puts them where the Amplifier shows them.
// The game's checkpoint is an object (its flag art and the spot the player respawns at are its position) with a
// trigger box offset from it: a level checkpoint's box reaches CP_LIFT below its position's height up to 350 above.
// The editor lets the box be dragged and resized on its own, which would strand the flag and respawn point away
// from the box (inside a wall, below it). So the flag always stands in the box: centred, CP_LIFT above its bottom
// edge (or at its middle when the box is shorter than twice that). A box the game sized itself comes out unchanged.
export const CP_LIFT = 50;

// t = the trigger box around the object at (x, y): { w, h, dx, dy } (dx, dy: its centre's offset).
export function checkpointAnchor(x, y, t) {
  return { x: x + t.dx, y: y + t.dy - t.h / 2 + Math.min(CP_LIFT, t.h / 2) };
}

// The export of a checkpoint at (x, y) with box t: whole-unit object position plus the trigger around it.
export function checkpointExport(x, y, t) {
  const a = checkpointAnchor(x, y, t), ax = Math.round(a.x), ay = Math.round(a.y);
  return { x: ax, y: ay, trigger: { w: t.w, h: t.h, dx: x + t.dx - ax, dy: y + t.dy - ay } };
}

// Navigator's math (MapCloneConfig.SizeCheckpoint): the trigger's centre in the world, the flag standing at the
// clone's position and the collider offset taken from where the collider's own transform sits.
export function gameCheckpoint(clone, trigger, boxOrigin = clone, scale = [1, 1]) {
  const at = [clone[0] - boxOrigin[0], clone[1] - boxOrigin[1]];
  const offset = [(at[0] + trigger.dx) / scale[0], (at[1] + trigger.dy) / scale[1]];
  return { flag: [clone[0], clone[1]], trigger: [boxOrigin[0] + offset[0] * scale[0], boxOrigin[1] + offset[1] * scale[1]] };
}

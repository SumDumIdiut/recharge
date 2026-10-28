// Where a checkpoint's flag and respawn point sit, so the game puts them where the Amplifier shows them.
// The flag/respawn is at the object's own position (x, y): that is where the user places it. The trigger box
// is offset from it by (t.dx, t.dy): the box centre sits at (x + t.dx, y + t.dy). The old CP_LIFT rule pushed the
// flag to box_top + CP_LIFT, which stranded the respawn far below where the checkpoint was placed whenever the
// box's dy wasn't exactly h/2 - CP_LIFT.
// Kept as an export for tests and any external consumers.
export const CP_LIFT = 50;

// t = the trigger box around the object at (x, y): { w, h, dx, dy } (dx, dy: its centre's offset).
export function checkpointAnchor(x, y, t) {
  return { x: x, y: y };
}

// The export of a checkpoint at (x, y) with box t: whole-unit object position plus the trigger around it.
export function checkpointExport(x, y, t) {
  const a = checkpointAnchor(x, y, t), ax = Math.round(a.x), ay = Math.round(a.y);
  return { x: ax, y: ay, trigger: { w: t.w, h: t.h, dx: t.dx, dy: t.dy } };
}

// Navigator's math (MapCloneConfig.SizeCheckpoint): the trigger's centre in the world, the flag standing at the
// clone's position and the collider offset taken from where the collider's own transform sits.
export function gameCheckpoint(clone, trigger, boxOrigin = clone, scale = [1, 1]) {
  const at = [clone[0] - boxOrigin[0], clone[1] - boxOrigin[1]];
  const offset = [(at[0] + trigger.dx) / scale[0], (at[1] + trigger.dy) / scale[1]];
  return { flag: [clone[0], clone[1]], trigger: [boxOrigin[0] + offset[0] * scale[0], boxOrigin[1] + offset[1] * scale[1]] };
}

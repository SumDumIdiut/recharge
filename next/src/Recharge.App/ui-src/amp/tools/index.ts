/** The one place tools are registered. A new tool is a module implementing Tool plus a line here. `group` sets its toolbar section. */
import { erase } from './erase.js';
import { fill } from './fill.js';
import { arrowTool } from './arrows.js';
import { zipPathTool } from './zipPath.js';
import { endGate, extraSpawn, resetGate, spawnPoint, startGate } from './gates.js';
import { paint } from './paint.js';
import { pick } from './pick.js';
import { rectangle } from './rectangle.js';
import { select } from './select.js';
import { ellipseFillTool, ellipseTool, frameTool, lineTool } from './shapes.js';
import { replaceTool } from './replace.js';
import type { Tool } from './types.js';

// Group the existing tools (the shape and replace tools carry their own group).
select.group = 'Select'; pick.group = 'Select';
paint.group = 'Draw'; erase.group = 'Draw'; fill.group = 'Draw';
rectangle.group = 'Shapes';
arrowTool.group = 'Paths'; zipPathTool.group = 'Paths';
startGate.group = endGate.group = resetGate.group = spawnPoint.group = extraSpawn.group = 'Course';

export const TOOLS: Tool[] = [
  select, pick,
  paint, erase, fill, replaceTool,
  rectangle, frameTool, lineTool, ellipseTool, ellipseFillTool,
  arrowTool, zipPathTool,
  startGate, endGate, resetGate, spawnPoint, extraSpawn,
];
export const toolById = (id: string): Tool | undefined => TOOLS.find((t) => t.id === id);

/** The toolbar sections, in display order. */
export const TOOL_GROUPS = ['Select', 'Draw', 'Shapes', 'Paths', 'Course'] as const;

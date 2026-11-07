/** The one place tools are registered. A new tool is a module implementing Tool plus a line here. */
import { erase } from './erase.js';
import { fill } from './fill.js';
import { arrowTool } from './arrows.js';
import { endGate, extraSpawn, resetGate, spawnPoint, startGate } from './gates.js';
import { paint } from './paint.js';
import { pick } from './pick.js';
import { rectangle } from './rectangle.js';
import { select } from './select.js';
import type { Tool } from './types.js';

export const TOOLS: Tool[] = [select, paint, erase, rectangle, fill, pick, startGate, endGate, resetGate, spawnPoint, extraSpawn, arrowTool];
export const toolById = (id: string): Tool | undefined => TOOLS.find((t) => t.id === id);

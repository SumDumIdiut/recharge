import { contentById } from '../content/index.js';
import { layerIdOf } from '../core/layers.js';
import { topAt } from './cells.js';
import type { Tool } from './types.js';

export const pick: Tool = {
  id: 'pick', label: 'Pick', hotkey: 'I', cursor: 'copy', hint: 'Click a cell to pick up its brush (with its options) and layer.',
  down(api, p) {
    const t = topAt(api, p.cell.x, p.cell.y);
    const c = t && contentById(t.content);
    const hit = t && c ? c.brushOf(t.value) : null;
    if (t && hit) { api.setLayer(layerIdOf(t.layer)); api.setBrush(t.content, hit.brush.id, t.value); api.setTool('paint'); }
  },
};

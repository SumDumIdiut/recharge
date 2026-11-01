type Shape = { tag: string; attrs: Record<string, string> };

const ICONS: Record<string, Shape[]> = {
  home: [
    { tag: 'path', attrs: { d: 'M3.5 10.5 12 3l8.5 7.5' } },
    { tag: 'path', attrs: { d: 'M5.5 9.5V21h13V9.5' } },
    { tag: 'path', attrs: { d: 'M9.5 21v-6h5v6' } },
  ],
  library: [
    { tag: 'path', attrs: { d: 'M4 4h4v16H4z' } },
    { tag: 'path', attrs: { d: 'M10 4h4v16h-4z' } },
    { tag: 'path', attrs: { d: 'm16.5 5 3.8-1 2.2 15-3.8 1z' } },
  ],
  create: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '9' } },
    { tag: 'path', attrs: { d: 'M12 8v8M8 12h8' } },
  ],
  amplifier: [
    { tag: 'path', attrs: { d: 'M3 17 17 3l4 4L7 21H3z' } },
    { tag: 'path', attrs: { d: 'm13.5 6.5 4 4M6.5 13.5l2 2M9.5 10.5l2 2' } },
  ],
  community: [
    { tag: 'circle', attrs: { cx: '9', cy: '8', r: '3' } },
    { tag: 'path', attrs: { d: 'M3.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5' } },
    { tag: 'circle', attrs: { cx: '17.5', cy: '9', r: '2.2' } },
    { tag: 'path', attrs: { d: 'M15.5 15.2c3 .2 5 2 5 4.3' } },
  ],
  lobbies: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '2.2' } },
    { tag: 'path', attrs: { d: 'M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4' } },
    { tag: 'path', attrs: { d: 'M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2' } },
  ],
  notebook: [
    { tag: 'path', attrs: { d: 'M6 3h12a2 2 0 0 1 2 2v16H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' } },
    { tag: 'path', attrs: { d: 'M8 3v18' } },
    { tag: 'path', attrs: { d: 'M11.5 8h5M11.5 12h5' } },
  ],
  settings: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '7.5' } },
    { tag: 'path', attrs: { d: 'M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4' } },
  ],
  bell: [
    { tag: 'path', attrs: { d: 'M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9' } },
    { tag: 'path', attrs: { d: 'M10 21h4' } },
  ],
  search: [
    { tag: 'circle', attrs: { cx: '10.5', cy: '10.5', r: '7' } },
    { tag: 'path', attrs: { d: 'm16 16 5 5' } },
  ],
  'chevron-left': [
    { tag: 'path', attrs: { d: 'M15 5 8 12l7 7' } },
  ],
  'chevron-right': [
    { tag: 'path', attrs: { d: 'm9 5 7 7-7 7' } },
  ],
  'chevron-down': [
    { tag: 'path', attrs: { d: 'm5 9 7 7 7-7' } },
  ],
  map: [
    { tag: 'path', attrs: { d: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z' } },
    { tag: 'path', attrs: { d: 'M9 3v15M15 6v15' } },
  ],
  download: [
    { tag: 'path', attrs: { d: 'M12 3v12' } },
    { tag: 'path', attrs: { d: 'm7 10 5 5 5-5' } },
    { tag: 'path', attrs: { d: 'M4 20h16' } },
  ],
  clock: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '9' } },
    { tag: 'path', attrs: { d: 'M12 7v5l4 2' } },
  ],
  sparkles: [
    { tag: 'path', attrs: { d: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z' } },
    { tag: 'path', attrs: { d: 'M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z' } },
  ],
  package: [
    { tag: 'path', attrs: { d: 'M21 8 12 3 3 8l9 5 9-5z' } },
    { tag: 'path', attrs: { d: 'M3 8v8l9 5 9-5V8M12 13v8' } },
  ],
  gamepad: [
    { tag: 'path', attrs: { d: 'M6 8h12a4 4 0 0 1 4 4v2a3 3 0 0 1-5.4 1.8L15 14H9l-1.6 1.8A3 3 0 0 1 2 14v-2a4 4 0 0 1 4-4z' } },
    { tag: 'path', attrs: { d: 'M7 12h2M8 11v2' } },
    { tag: 'circle', attrs: { cx: '16', cy: '12', r: '1' } },
    { tag: 'circle', attrs: { cx: '18', cy: '13.5', r: '1' } },
  ],
  alert: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '9' } },
    { tag: 'path', attrs: { d: 'M12 7v6M12 17h.01' } },
  ],
  refresh: [
    { tag: 'path', attrs: { d: 'M20 11a8 8 0 1 0-2.3 6' } },
    { tag: 'path', attrs: { d: 'M20 4v7h-7' } },
  ],
  user: [
    { tag: 'circle', attrs: { cx: '12', cy: '8', r: '4' } },
    { tag: 'path', attrs: { d: 'M4 21c0-4 3.6-6 8-6s8 2 8 6' } },
  ],
  users: [
    { tag: 'circle', attrs: { cx: '9', cy: '8', r: '3' } },
    { tag: 'path', attrs: { d: 'M3.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5' } },
    { tag: 'circle', attrs: { cx: '17.5', cy: '9', r: '2.2' } },
    { tag: 'path', attrs: { d: 'M15.5 15.2c3 .2 5 2 5 4.3' } },
  ],
  forum: [
    { tag: 'path', attrs: { d: 'M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z' } },
    { tag: 'path', attrs: { d: 'M8 9h8M8 13h5' } },
  ],
  play: [
    { tag: 'path', attrs: { d: 'M8 5v14l11-7z' } },
  ],
  plus: [
    { tag: 'path', attrs: { d: 'M12 5v14M5 12h14' } },
  ],
  x: [
    { tag: 'path', attrs: { d: 'M6 6l12 12M18 6 6 18' } },
  ],
  grid: [
    { tag: 'path', attrs: { d: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z' } },
  ],
  image: [
    { tag: 'path', attrs: { d: 'M4 4h16v16H4z' } },
    { tag: 'circle', attrs: { cx: '9', cy: '9', r: '1.6' } },
    { tag: 'path', attrs: { d: 'm4 17 5-5 4 4 3-3 4 4' } },
  ],
  info: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '9' } },
    { tag: 'path', attrs: { d: 'M12 11v6M12 7.5v.5' } },
  ],
  folder: [
    { tag: 'path', attrs: { d: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z' } },
  ],
  check: [
    { tag: 'path', attrs: { d: 'm4 12 5 5L20 6' } },
  ],
  maps: [
    { tag: 'path', attrs: { d: 'M3 6.5 8.5 4l7 2.5L21 4v13.5L15.5 20l-7-2.5L3 20z' } },
    { tag: 'path', attrs: { d: 'M8.5 4v13.5M15.5 6.5V20' } },
  ],
  mods: [
    { tag: 'path', attrs: { d: 'M9 3.5h6v3a1.5 1.5 0 0 0 3 0V5.5h2.5V11h-1.5a1.5 1.5 0 0 0 0 3h1.5v6.5H15V19a1.5 1.5 0 0 0-3 0v1.5H3.5V14H5a1.5 1.5 0 0 0 0-3H3.5V5.5H9z' } },
  ],
  skins: [
    { tag: 'path', attrs: { d: 'M8.5 3.5 4 6l1.5 5 2-1V20.5h9V10l2 1L20 6l-4.5-2.5' } },
    { tag: 'path', attrs: { d: 'M8.5 3.5a3.5 3.5 0 0 0 7 0' } },
  ],
  backgrounds: [
    { tag: 'path', attrs: { d: 'M3.5 5h17v14h-17z' } },
    { tag: 'path', attrs: { d: 'm3.5 16 5-5 4 4 2.5-2.5 5.5 5.5' } },
    { tag: 'circle', attrs: { cx: '15.5', cy: '9', r: '1.5' } },
  ],
};

/** A 24 px line icon drawn by hand as SVG, coloured with currentColor. */
export function icon(name: string, size = 24): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const shapes = ICONS[name] || ICONS.grid;
  for (const shape of shapes) {
    const node = document.createElementNS(ns, shape.tag);
    for (const [attribute, value] of Object.entries(shape.attrs)) {
      node.setAttribute(attribute, value);
    }
    svg.appendChild(node);
  }
  return svg;
}

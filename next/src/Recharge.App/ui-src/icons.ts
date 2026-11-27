type Shape = { tag: string; attrs: Record<string, string> };

const ICONS: Record<string, Shape[]> = {
  home: [
    { tag: 'path', attrs: { d: 'M3.5 11 12 3.5 20.5 11' } },
    { tag: 'path', attrs: { d: 'M5.5 9.5v9a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-9' } },
    { tag: 'path', attrs: { d: 'M9.5 20.5v-4.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5v4.5' } },
  ],
  library: [
    { tag: 'rect', attrs: { x: '4', y: '4', width: '4', height: '16', rx: '1' } },
    { tag: 'rect', attrs: { x: '10', y: '4', width: '4', height: '16', rx: '1' } },
    { tag: 'path', attrs: { d: 'm16.4 5.2 2.9-.8a1 1 0 0 1 1.2.7l3 13.1a1 1 0 0 1-.7 1.2l-2.9.8z' } },
  ],
  create: [
    { tag: 'rect', attrs: { x: '3.5', y: '3.5', width: '17', height: '17', rx: '4' } },
    { tag: 'path', attrs: { d: 'M12 8.5v7M8.5 12h7' } },
  ],
  amplifier: [
    { tag: 'path', attrs: { d: 'M14 3.5 20.5 10 9 21.5H3.5V16z' } },
    { tag: 'path', attrs: { d: 'm12.5 5 6.5 6.5' } },
    { tag: 'path', attrs: { d: 'M16.5 8 19 5.5a1.8 1.8 0 0 0-2.5-2.5L14 5.5z' } },
  ],
  community: [
    { tag: 'path', attrs: { d: 'M20.5 13a3 3 0 0 1-3 3H9l-4 3v-3.5A3 3 0 0 1 3.5 13V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z' } },
    { tag: 'path', attrs: { d: 'M8.5 10h.01M12 10h.01M15.5 10h.01' } },
  ],
  lobbies: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '2' } },
    { tag: 'path', attrs: { d: 'M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4' } },
    { tag: 'path', attrs: { d: 'M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2' } },
  ],
  notebook: [
    { tag: 'path', attrs: { d: 'M8 3.5h10a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H8z' } },
    { tag: 'path', attrs: { d: 'M8 3.5a2.5 2.5 0 0 0-2.5 2.5v12A2.5 2.5 0 0 0 8 20.5' } },
    { tag: 'path', attrs: { d: 'M11.5 8.5h5M11.5 12h5' } },
  ],
  settings: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
    { tag: 'path', attrs: { d: 'M17.7 14.31a1.27 1.27 0 0 0 .25 1.4l.05.05a1.54 1.54 0 0 1 0 2.18 1.54 1.54 0 0 1-2.18 0l-.05-.05a1.27 1.27 0 0 0-1.4-.25 1.27 1.27 0 0 0-.77 1.16V18.93a1.54 1.54 0 0 1-1.54 1.54 1.54 1.54 0 0 1-1.54-1.54v-.07A1.27 1.27 0 0 0 9.69 17.7a1.27 1.27 0 0 0-1.4.25l-.05.05a1.54 1.54 0 0 1-2.18 0 1.54 1.54 0 0 1 0-2.18l.05-.05a1.27 1.27 0 0 0 .25-1.4 1.27 1.27 0 0 0-1.16-.77H5.07a1.54 1.54 0 0 1-1.54-1.54 1.54 1.54 0 0 1 1.54-1.54h.07A1.27 1.27 0 0 0 6.3 9.69a1.27 1.27 0 0 0-.25-1.4l-.05-.05a1.54 1.54 0 0 1 0-2.18 1.54 1.54 0 0 1 2.18 0l.05.05a1.27 1.27 0 0 0 1.4.25H9.69a1.27 1.27 0 0 0 .77-1.16V5.07a1.54 1.54 0 0 1 1.54-1.54 1.54 1.54 0 0 1 1.54 1.54v.07a1.27 1.27 0 0 0 .77 1.16 1.27 1.27 0 0 0 1.4-.25l.05-.05a1.54 1.54 0 0 1 2.18 0 1.54 1.54 0 0 1 0 2.18l-.05.05a1.27 1.27 0 0 0-.25 1.4V9.69a1.27 1.27 0 0 0 1.16.77H18.93a1.54 1.54 0 0 1 1.54 1.54 1.54 1.54 0 0 1-1.54 1.54h-.07a1.27 1.27 0 0 0-1.16.77z' } },
  ],
  bell: [
    { tag: 'path', attrs: { d: 'M18 8.5a6 6 0 1 0-12 0c0 5-2.5 6-2.5 8.5h17c0-2.5-2.5-3.5-2.5-8.5' } },
    { tag: 'path', attrs: { d: 'M10 20.5a2 2 0 0 0 4 0' } },
  ],
  search: [
    { tag: 'circle', attrs: { cx: '10.5', cy: '10.5', r: '7' } },
    { tag: 'path', attrs: { d: 'm15.6 15.6 4.9 4.9' } },
  ],
  'chevron-left': [
    { tag: 'path', attrs: { d: 'M14.5 6 8.5 12l6 6' } },
  ],
  'chevron-right': [
    { tag: 'path', attrs: { d: 'm9.5 6 6 6-6 6' } },
  ],
  'chevron-down': [
    { tag: 'path', attrs: { d: 'm6 9.5 6 6 6-6' } },
  ],
  map: [
    { tag: 'path', attrs: { d: 'M15 4.5 21 3v14l-6 1.5-6-1.5L3 18.5V5l6-1.5z' } },
    { tag: 'path', attrs: { d: 'M9 3.5V17M15 4.5V18.5' } },
    { tag: 'circle', attrs: { cx: '12', cy: '10', r: '1.2' } },
  ],
  download: [
    { tag: 'path', attrs: { d: 'M12 3.5v11' } },
    { tag: 'path', attrs: { d: 'm7.5 10 4.5 4.5 4.5-4.5' } },
    { tag: 'path', attrs: { d: 'M4.5 20h15' } },
  ],
  clock: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '8.5' } },
    { tag: 'path', attrs: { d: 'M12 7v5l3.5 2.5' } },
  ],
  sparkles: [
    { tag: 'path', attrs: { d: 'M11.5 3.5 13 8.5 18 10l-5 1.5-1.5 5-1.5-5L5 10l5-1.5z' } },
    { tag: 'path', attrs: { d: 'M18.5 15.5l.8 2.4 2.4.8-2.4.8-.8 2.4-.8-2.4-2.4-.8 2.4-.8z' } },
  ],
  package: [
    { tag: 'path', attrs: { d: 'M20.5 7.5 12 3 3.5 7.5 12 12z' } },
    { tag: 'path', attrs: { d: 'M3.5 7.5v8.3a1 1 0 0 0 .5.9L12 21l8-4.3a1 1 0 0 0 .5-.9V7.5' } },
    { tag: 'path', attrs: { d: 'M12 12v9' } },
    { tag: 'path', attrs: { d: 'm7.75 5.25 8.5 4.5' } },
  ],
  gamepad: [
    { tag: 'path', attrs: { d: 'M8 8.5h8a4.5 4.5 0 0 1 4.5 4.5l.3 2.6A2.3 2.3 0 0 1 16.6 17L15 15H9l-1.6 2a2.3 2.3 0 0 1-4.2-1.4L3.5 13A4.5 4.5 0 0 1 8 8.5z' } },
    { tag: 'path', attrs: { d: 'M7 12.5h2.5M8.25 11.25v2.5' } },
    { tag: 'circle', attrs: { cx: '15.5', cy: '11.8', r: '0.9' } },
    { tag: 'circle', attrs: { cx: '17.5', cy: '13.5', r: '0.9' } },
  ],
  alert: [
    { tag: 'path', attrs: { d: 'M10.3 4.3 2.7 17.5A2 2 0 0 0 4.4 20.5h15.2a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z' } },
    { tag: 'path', attrs: { d: 'M12 9.5v4M12 17h.01' } },
  ],
  refresh: [
    { tag: 'path', attrs: { d: 'M20 11.5A8 8 0 1 0 18 17' } },
    { tag: 'path', attrs: { d: 'M20 4.5v6.5h-6.5' } },
  ],
  user: [
    { tag: 'circle', attrs: { cx: '12', cy: '8', r: '4' } },
    { tag: 'path', attrs: { d: 'M4.5 20.5a7.5 7.5 0 0 1 15 0' } },
  ],
  users: [
    { tag: 'circle', attrs: { cx: '9.5', cy: '8', r: '3.3' } },
    { tag: 'path', attrs: { d: 'M3.5 20a6 6 0 0 1 12 0' } },
    { tag: 'path', attrs: { d: 'M16 5.2a3.3 3.3 0 0 1 0 6.1' } },
    { tag: 'path', attrs: { d: 'M17 14.3a6 6 0 0 1 3.5 5.7' } },
  ],
  forum: [
    { tag: 'path', attrs: { d: 'M20.5 13a3 3 0 0 1-3 3H9l-4 3v-3.5A3 3 0 0 1 3.5 13V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z' } },
    { tag: 'path', attrs: { d: 'M8 9.5h8M8 12.5h5' } },
  ],
  play: [
    { tag: 'path', attrs: { d: 'M8 5.5a1 1 0 0 1 1.5-.9l9 6.5a1 1 0 0 1 0 1.8l-9 6.5A1 1 0 0 1 8 18.5z' } },
  ],
  phone: [
    { tag: 'path', attrs: { d: 'M8.2 3.5 5.5 4.6a1.5 1.5 0 0 0-.9 1.7c.6 6.1 4.6 10.1 10.7 10.7a1.5 1.5 0 0 0 1.7-.9l1.1-2.7a1.5 1.5 0 0 0-.6-1.8l-2.6-1.6a1.5 1.5 0 0 0-1.8.2l-1.2 1.2a13 13 0 0 1-3.2-3.2l1.2-1.2a1.5 1.5 0 0 0 .2-1.8L9.9 4.1a1.5 1.5 0 0 0-1.7-.6z' } },
  ],
  video: [
    { tag: 'rect', attrs: { x: '3.5', y: '6', width: '12', height: '12', rx: '2.5' } },
    { tag: 'path', attrs: { d: 'm15.5 10 5-3v10l-5-3z' } },
  ],
  camera: [
    { tag: 'rect', attrs: { x: '3.5', y: '6', width: '12', height: '12', rx: '2.5' } },
    { tag: 'path', attrs: { d: 'm15.5 10 5-3v10l-5-3z' } },
  ],
  plus: [
    { tag: 'path', attrs: { d: 'M12 5v14M5 12h14' } },
  ],
  x: [
    { tag: 'path', attrs: { d: 'M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5' } },
  ],
  grid: [
    { tag: 'rect', attrs: { x: '4', y: '4', width: '7', height: '7', rx: '1.5' } },
    { tag: 'rect', attrs: { x: '13', y: '4', width: '7', height: '7', rx: '1.5' } },
    { tag: 'rect', attrs: { x: '4', y: '13', width: '7', height: '7', rx: '1.5' } },
    { tag: 'rect', attrs: { x: '13', y: '13', width: '7', height: '7', rx: '1.5' } },
  ],
  image: [
    { tag: 'rect', attrs: { x: '3.5', y: '4.5', width: '17', height: '15', rx: '2.5' } },
    { tag: 'circle', attrs: { cx: '8.5', cy: '9.5', r: '1.6' } },
    { tag: 'path', attrs: { d: 'm4 17 4.5-4.5 3.5 3.5 3-3 5 5' } },
  ],
  info: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '8.5' } },
    { tag: 'path', attrs: { d: 'M12 11v5.5M12 7.5h.01' } },
  ],
  folder: [
    { tag: 'path', attrs: { d: 'M3.5 7a2 2 0 0 1 2-2h3.3a2 2 0 0 1 1.4.6L11.5 7h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' } },
  ],
  check: [
    { tag: 'path', attrs: { d: 'm4.5 12.5 5 5 10-11' } },
  ],
  github: [
    { tag: 'path', attrs: { d: 'M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22' } },
  ],
  maps: [
    { tag: 'path', attrs: { d: 'M8.5 5.5 3.5 7.5v11l5-2 7 2 5-2v-11l-5 2z' } },
    { tag: 'path', attrs: { d: 'M8.5 5.5v11M15.5 7.5v11' } },
    { tag: 'circle', attrs: { cx: '12', cy: '11.5', r: '1.6' } },
  ],
  mods: [
    { tag: 'path', attrs: { d: 'M8.5 3.5h3.5a1.5 1.5 0 0 1 1.5 1.5 1.5 1.5 0 0 0 3 0h2.5a1 1 0 0 1 1 1v3a1.5 1.5 0 0 0 0 3v3a1 1 0 0 1-1 1H16a1.5 1.5 0 0 0-3 0H8.5a1 1 0 0 1-1-1v-2.5a1.5 1.5 0 0 1 0-3V9a1.5 1.5 0 0 1-1.5-1.5V4.5a1 1 0 0 1 1-1z' } },
  ],
  skins: [
    { tag: 'path', attrs: { d: 'M9 3.5 4.5 6 6 10.5l2-1v10h8v-10l2 1L19.5 6 15 3.5a3 3 0 0 1-6 0z' } },
  ],
  backgrounds: [
    { tag: 'path', attrs: { d: 'M3.5 8.5 7 5l3.5 3.5' } },
    { tag: 'rect', attrs: { x: '7', y: '8.5', width: '13.5', height: '11', rx: '2' } },
    { tag: 'circle', attrs: { cx: '11', cy: '12', r: '1.4' } },
    { tag: 'path', attrs: { d: 'm7 18 3.5-3 2.5 2.5 2.5-2.5 5 4.5' } },
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

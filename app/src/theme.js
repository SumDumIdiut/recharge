// Two starting points (base color sets) - everything else is picked freely
// per-attribute and layered on top as CSS variable overrides.
export const PRESETS = [
  {
    id: 'dark',
    name: 'Dark',
    bg: '#141414',
    panel: '#1c1c1c',
    text: '#f9ffe4',
    accent: '#41f88d',
    accent2: '#c63ed8',
  },
  {
    id: 'light',
    name: 'Light',
    bg: '#f4f2ea',
    panel: '#ffffff',
    text: '#171812',
    accent: '#1f9d5c',
    accent2: '#9c2aad',
  },
];

export const ATTRS = [
  { key: 'bg', label: 'Background' },
  { key: 'panel', label: 'Panel' },
  { key: 'text', label: 'Text' },
  { key: 'accent', label: 'Accent' },
  { key: 'accent2', label: 'Accent 2' },
];

const STORAGE_KEY = 'rechargeColors';
const TEXTURE_KEY = 'rechargeBgTexture';
const CUSTOM_CSS_KEY = 'rechargeCustomCss';

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Perceived brightness (ITU-R BT.601) - decides whether native form controls
/// scrollbars should render themselves light-on-dark or dark-on-light.
function isDark(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

export function getColors() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.bg) return saved;
  } catch (e) {}
  return { ...PRESETS[0] };
}

export function applyColors(colors) {
  const root = document.documentElement.style;
  root.setProperty('--bg', colors.bg);
  root.setProperty('--panel', colors.panel);
  root.setProperty('--text', colors.text);
  root.setProperty('--text-dim', rgba(colors.text, 0.55));
  root.setProperty('--line', rgba(colors.text, 0.14));
  root.setProperty('--line-hi', rgba(colors.text, 0.4));
  root.setProperty('--grid-line', rgba(colors.text, 0.035));
  root.setProperty('--green', colors.accent);
  root.setProperty('--green-dim', rgba(colors.accent, 0.6));
  root.setProperty('--magenta', colors.accent2);
  root.setProperty('--magenta-dim', rgba(colors.accent2, 0.6));
  document.documentElement.style.colorScheme = isDark(colors.bg) ? 'dark' : 'light';
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(colors)); } catch (e) {}
}

export function applyPreset(id) {
  const preset = PRESETS.find((p) => p.id === id) || PRESETS[0];
  applyColors({ ...preset });
}

// Background texture - a user-uploaded image layered over the flat --bg
// color (see body's background-image in style.css). Stored as a data URL
// so it survives a relaunch with no extra Tauri command needed to read it
// back off disk.
export function getBgTexture() {
  try { return localStorage.getItem(TEXTURE_KEY) || ''; } catch (e) { return ''; }
}

export function applyBgTexture(dataUrl) {
  // Persist first - if a large image blows localStorage's quota, throw
  // before touching the visible property at all. Applying it anyway would
  // look like it worked right up until the next relaunch silently drops it.
  try {
    if (dataUrl) localStorage.setItem(TEXTURE_KEY, dataUrl);
    else localStorage.removeItem(TEXTURE_KEY);
  } catch (e) {
    throw e;
  }
  document.documentElement.style.setProperty('--bg-image', dataUrl ? `url("${dataUrl}")` : 'none');
}

// Custom CSS - injected last (after style.css and every tab's own
// stylesheet) so it can freely override anything, including the
// --bg/--panel/etc. custom properties applyColors sets inline.
const CUSTOM_CSS_ELEMENT_ID = 'recharge-custom-css';

export function getCustomCss() {
  try { return localStorage.getItem(CUSTOM_CSS_KEY) || ''; } catch (e) { return ''; }
}

export function applyCustomCss(css) {
  try {
    if (css) localStorage.setItem(CUSTOM_CSS_KEY, css);
    else localStorage.removeItem(CUSTOM_CSS_KEY);
  } catch (e) {
    throw e;
  }
  let el = document.getElementById(CUSTOM_CSS_ELEMENT_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = CUSTOM_CSS_ELEMENT_ID;
    document.head.appendChild(el);
  }
  el.textContent = css || '';
}

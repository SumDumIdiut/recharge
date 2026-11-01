const CSS = `
.bg-panel { max-width: 860px; }
.bg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; padding: 12px 0 4px; }
.bg-panel > .setting-hint { margin: 0 0 4px; }
.bg-tile { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 6px; text-align: left; font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); cursor: pointer; min-width: 0; }
.bg-tile:hover { border-color: var(--green-dim); }
.bg-tile[aria-pressed="true"] { border-color: var(--green); box-shadow: 0 0 0 1px var(--green); }
.bg-thumb { position: relative; width: 100%; aspect-ratio: 16 / 10; overflow: hidden; border-radius: var(--radius-sm); background: #0a0a0a; }
.bg-thumb > img, .bg-thumb > video { display: block; width: 100%; height: 100%; object-fit: cover; }
.bg-thumb.is-none { display: flex; align-items: center; justify-content: center; color: var(--text-dim); }
.bg-badge { position: absolute; right: 6px; bottom: 6px; padding: 0 6px; font-size: 16px; line-height: 20px; color: var(--text); background: rgba(0, 0, 0, .7); border-radius: 3px; }
.bg-tile-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 19px; }
.bg-actions { display: flex; flex-wrap: wrap; gap: 10px; padding: 10px 0 2px; }
.bg-range { display: flex; align-items: center; gap: 10px; }
.bg-range input[type="range"] { width: 220px; accent-color: var(--green); }
.bg-range output { min-width: 52px; text-align: right; color: var(--green); }
.bg-color { display: flex; align-items: center; gap: 10px; }
.bg-color input[type="color"] { width: 44px; height: 32px; padding: 0; border: 1px solid var(--line-hi); border-radius: var(--radius-sm); background: var(--panel); cursor: pointer; }
.bg-warn { color: var(--danger); }
.bg-pages { padding: 4px 0 0; }
.bg-pages > summary { cursor: pointer; padding: 12px 0; font-size: 22px; border-top: 1px solid var(--line); }
.bg-page-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 6px 0; }
.bg-page-row .name { text-transform: capitalize; }
.pl-list { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; }
.pl-item { display: flex; align-items: center; gap: 12px; padding: 6px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); }
.pl-item .bg-thumb { width: 96px; flex: none; }
.pl-item .pl-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-item .pl-kind { color: var(--text-dim); }
.pl-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 6px 0; }
.pl-head .settings-input { min-width: 220px; }
.pl-picker { display: flex; flex-wrap: wrap; gap: 8px; padding: 6px 0; align-items: center; }
`;

let installed = false;

/** Adds the background settings styles once (the page's own stylesheet list isn't touched). */
export function ensureBackgroundStyles(): void {
  if (installed && document.getElementById('bg-settings-style')) return;
  const style = document.createElement('style');
  style.id = 'bg-settings-style';
  style.textContent = CSS;
  document.head.appendChild(style);
  installed = true;
}

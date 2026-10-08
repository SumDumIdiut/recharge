// Startup check: after a launcher update, offer the changelog (bottom-right, stacked above the update banner).
import { bannerDecision, loadChangelog, versionForBuild, BUILD_KEY } from './whatsnew.js';

export async function maybeShowUpdatedBanner(tauri = window.__TAURI__, storage = (() => { try { return localStorage; } catch { return null; } })(), doc = document) {
  try {
    const invoke = tauri?.core?.invoke;
    if (!invoke) return false;
    const info = await invoke('launcher_info').catch(() => null);
    if (!info?.managed || !info.build) return false;
    let last = null;
    try { last = storage?.getItem(BUILD_KEY); } catch {}
    const d = bannerDecision(info.build, last);
    try { if (d.store) storage?.setItem(BUILD_KEY, d.store); } catch {}
    if (!d.show) return false;
    const { entries } = await loadChangelog(invoke, info.channel);
    const banner = doc.createElement('div');
    banner.id = 'whatsnew-banner';
    banner.style.cssText =
      'position:fixed;right:16px;bottom:72px;z-index:9998;display:flex;gap:10px;align-items:center;white-space:nowrap;max-width:calc(100vw - 32px);' +
      'padding:8px 12px;box-shadow:0 4px 18px rgba(0,0,0,.45);background:var(--panel,#1a1a1a);border:1px solid var(--green,#3ddc84);color:var(--text,#eee);font:inherit;';
    const span = doc.createElement('span');
    span.textContent = `Updated to ${versionForBuild(entries, info.build)}`;
    const open = doc.createElement('button');
    open.className = 'btn btn-primary';
    open.textContent = "What's new";
    open.style.cssText = 'white-space:nowrap;padding:6px 14px;';
    open.onclick = () => {
      banner.remove();
      try { window.__openWhatsNew = true; } catch {}
      window.navigate?.('settings');
      window.dispatchEvent?.(new Event('open-whatsnew'));
    };
    const close = doc.createElement('button');
    close.className = 'btn';
    close.textContent = 'x';
    close.style.cssText = 'padding:6px 10px;';
    close.onclick = () => banner.remove();
    banner.append(span, open, close);
    doc.body.appendChild(banner);
    return true;
  } catch {
    return false;
  }
}

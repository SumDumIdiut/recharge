// "What's new": changelog panel + the "Updated to ..." banner after a launcher update.
import { escapeHtml } from './ui.js';

export const BUILD_KEY = 'rechargeLastBuild';

// {"channel","entries":[{version,build,date,commit,changes:[...]}]} -> HTML (all text escaped).
export function renderChangelog(data) {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  if (!entries.length) return '<div class="empty-state">No changelog yet.</div>';
  return entries
    .map((e) => {
      const changes = Array.isArray(e.changes) ? e.changes : [];
      const meta = [e.date].filter(Boolean).map(escapeHtml).join(' - ');
      // The CI build counter is not a version: tooltip only.
      const tip = e.build != null && e.build !== '' ? ` title="Build ${escapeHtml(e.build)}"` : '';
      return `<div class="wn-entry">
  <div class="wn-head"><span class="wn-version"${tip}>${escapeHtml(e.version ?? '?')}</span><span class="wn-meta">${meta}</span></div>
  <ul class="wn-changes">${changes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
</div>`;
    })
    .join('');
}

// -> {html, entries}; a missing changelog is a normal "No changelog yet".
export async function loadChangelog(invoke, channel) {
  try {
    const data = await invoke('fetch_changelog_cmd', { channel });
    return { html: renderChangelog(data), entries: data?.entries || [] };
  } catch (err) {
    const missing = String(err).includes('NOT_FOUND');
    return {
      html: `<div class="empty-state">${missing ? 'No changelog yet.' : escapeHtml(`Couldn't load the changelog: ${err}`)}</div>`,
      entries: [],
    };
  }
}

// Show the banner when a build is running that differs from the one seen last time.
// First run ever (nothing stored) only records the build.
export function bannerDecision(build, last) {
  const b = String(build || '').trim();
  if (!b) return { show: false, store: null };
  if (last == null || last === '') return { show: false, store: b };
  return { show: last !== b, store: b };
}

// A real version looks like 4.0.0 / 4.0.0-beta8. Empty or a bare CI counter ("build-17", "build 17", "v17", "17") is not one.
export function cleanVersion(v) {
  const t = String(v ?? '').trim();
  if (!t || /^(build|b|v)?[-_ ]?\d+$/i.test(t)) return '';
  return t;
}

// Version published for this build, or '' when the changelog doesn't know it.
export function versionForBuild(entries, build) {
  const hit = (entries || []).find((e) => String(e.build) === String(build));
  return cleanVersion(hit?.version);
}

export const VERSION_CACHE_PREFIX = 'rechargeVersionOfBuild:';

// info = launcher_info. Returns the real version: the launcher's, else a cached lookup, else the hub changelog entry for the build (cached); '' if unknown.
export async function resolveVersion(invoke, info, storage = (() => { try { return localStorage; } catch { return null; } })()) {
  const own = cleanVersion(info?.version);
  if (own) return own;
  const build = String(info?.build ?? '').trim();
  if (!build) return '';
  const key = `${VERSION_CACHE_PREFIX}${info?.channel || 'stable'}:${build}`;
  try { const c = cleanVersion(storage?.getItem(key)); if (c) return c; } catch {}
  const { entries } = await loadChangelog(invoke, info?.channel);
  const v = versionForBuild(entries, build);
  if (v) { try { storage?.setItem(key, v); } catch {} }
  return v;
}

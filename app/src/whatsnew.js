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
      const meta = [e.date, e.build != null && e.build !== '' ? `build ${e.build}` : ''].filter(Boolean).map(escapeHtml).join(' - ');
      return `<div class="wn-entry">
  <div class="wn-head"><span class="wn-version">${escapeHtml(e.version ?? '?')}</span><span class="wn-meta">${meta}</span></div>
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

export function versionForBuild(entries, build) {
  const hit = (entries || []).find((e) => String(e.build) === String(build));
  return hit?.version ? hit.version : `build ${build}`;
}

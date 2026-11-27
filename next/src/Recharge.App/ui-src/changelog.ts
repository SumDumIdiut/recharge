/** The once-per-update "What's new" popup, shown after the first UI render. */
import { call, type AppInfo } from './bridge.js';
import { append, h } from './dom.js';
import { modal } from './components/modal.js';
import type { UpdateStatus } from './settings/api.js';
import {
  bulletText,
  isBulletLine,
  noteLines,
  readSeenBuild,
  shouldShowChangelog,
  writeSeenBuild,
} from './lib/changelog.js';

interface ReleaseNotes {
  version?: string;
  notes?: string;
}

let started = false;

/** Text nodes only: bullets become list items, other lines keep their own paragraphs and line breaks. */
function notesBody(notes: string): HTMLElement {
  const body = h('div', { className: 'changelog-notes' });
  let list: HTMLElement | null = null;
  let paragraph: HTMLElement | null = null;
  for (const line of noteLines(notes)) {
    if (!line.trim()) {
      list = null;
      paragraph = null;
      continue;
    }
    if (isBulletLine(line)) {
      paragraph = null;
      if (!list) {
        list = h('ul', { className: 'changelog-list' });
        body.appendChild(list);
      }
      list.appendChild(h('li', { text: bulletText(line) }));
    } else {
      list = null;
      if (!paragraph) {
        paragraph = h('p', { className: 'changelog-text' });
        body.appendChild(paragraph);
      } else {
        append(paragraph, ['\n']);
      }
      append(paragraph, [line]);
    }
  }
  return body;
}

/**
 * The tracker is the installed build number: beta builds bump the manifest build while the version string stays put.
 * First-ever boot just records the build. A boot with a different previous build fetches that build's release notes and shows them once.
 * No bridge (plain browser), no build or no published notes: stay quiet and try again on a later boot.
 */
export async function initChangelog(): Promise<void> {
  if (started) return;
  started = true;

  let build = 0;
  try {
    build = (await call<UpdateStatus>('updates.status')).build;
  } catch {
    return;
  }
  if (!Number.isInteger(build) || build <= 0) return;

  const seen = readSeenBuild();
  if (!shouldShowChangelog(seen, build)) {
    if (seen === null) writeSeenBuild(build);
    return;
  }

  let notes = '';
  try {
    notes = ((await call<ReleaseNotes>('updates.releaseNotes')).notes || '').trim();
  } catch {
    return;
  }
  if (!notes) return;

  // Mark it seen before opening: closing, Esc, backdrop click or a reload must never reshow this update.
  writeSeenBuild(build);

  // The title is cosmetic only; the version string does not change between beta builds.
  let version = '';
  try {
    version = ((await call<AppInfo>('app.info')).version || '').trim();
  } catch {
    /* The popup still works without a display version. */
  }
  modal({
    title: version ? "What's new in v" + version : "What's new",
    body: notesBody(notes),
    actions: [{ label: 'Close', kind: 'primary' }],
  });
}

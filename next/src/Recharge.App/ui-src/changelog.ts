/** The once-per-update "What's new" popup, shown after the first UI render. */
import { call, type AppInfo } from './bridge.js';
import { append, h } from './dom.js';
import { modal } from './components/modal.js';
import {
  bulletText,
  isBulletLine,
  noteLines,
  readSeenVersion,
  shouldShowChangelog,
  writeSeenVersion,
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
 * First-ever boot just records the version. A boot with a different previous version fetches the release notes and shows them once.
 * No bridge (plain browser), no version or no published notes: stay quiet and try again on a later boot.
 */
export async function initChangelog(): Promise<void> {
  if (started) return;
  started = true;

  let version = '';
  try {
    version = ((await call<AppInfo>('app.info')).version || '').trim();
  } catch {
    return;
  }
  if (!version) return;

  const seen = readSeenVersion();
  if (!shouldShowChangelog(seen, version)) {
    if (seen === null) writeSeenVersion(version);
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
  writeSeenVersion(version);
  modal({
    title: "What's new in v" + version,
    body: notesBody(notes),
    actions: [{ label: 'Close', kind: 'primary' }],
  });
}

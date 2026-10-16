// The upload forms' "Update of:" choice: a new upload can be a new version of one of the user's own uploads of that kind.
const norm = (s) => String(s || '').trim().toLowerCase();

// The hub id of the user's upload that `thing` is a new version of, or '' for a new upload. Same rules as the hub's automatic match:
// maps by map id (a map with no id: the upload it was installed or uploaded as, else the same name), mods by mod id, skins by name.
// mine: the user's uploads of this kind, as /api/me/submissions lists them. thing: { mapUid, modId, hubId, name }.
export function defaultUpdateTarget(kind, mine, thing) {
  const uploads = mine || [];
  const t = thing || {};
  if (kind === 'maps') {
    if (t.mapUid) return uploads.find((u) => u.mapUid === t.mapUid)?.id || uploads.find((u) => u.id === t.hubId)?.id || '';
    return uploads.find((u) => u.id === t.hubId)?.id || uploads.find((u) => !u.mapUid && norm(u.name) === norm(t.name))?.id || '';
  }
  if (kind === 'mods') return t.modId ? uploads.find((u) => u.modId === t.modId)?.id || '' : '';
  if (kind === 'skins') return t.name ? uploads.find((u) => norm(u.name) === norm(t.name))?.id || '' : '';
  return '';
}

// <option>s for the select: "New upload" first, then each upload with its version and revision.
export function updateOptionsHtml(mine, selected, escapeHtml) {
  const opt = (value, text) => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(text)}</option>`;
  return [opt('', 'New upload'), ...(mine || []).map((u) => opt(u.id, `${u.name}${u.version ? ' · v' + u.version : ''}${u.revision > 1 ? ' · update ' + u.revision : ''}`))].join('');
}

// Fills the form's "Update of" row: hidden when the user has no uploads of this kind, else the select with the right choice already picked.
export function fillUpdateSelect(doc, prefix, kind, mine, thing, escapeHtml) {
  const row = doc.getElementById(prefix + '-upload-updates-row');
  const select = doc.getElementById(prefix + '-upload-updates');
  if (!row || !select) return '';
  const chosen = defaultUpdateTarget(kind, mine, thing);
  select.innerHTML = updateOptionsHtml(mine, chosen, escapeHtml);
  select.value = chosen;
  row.hidden = !(mine && mine.length);
  return chosen;
}

// The value to send as `updates` ('' / undefined = a new upload).
export function chosenUpdate(doc, prefix) {
  const select = doc.getElementById(prefix + '-upload-updates');
  return select && !doc.getElementById(prefix + '-upload-updates-row')?.hidden && select.value ? select.value : undefined;
}

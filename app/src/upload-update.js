// The upload forms' "Update of:" choice: a new upload can be a new version of one of the user's own uploads of that kind.
const norm = (s) => String(s || '').trim().toLowerCase();

// The hub id of the user's upload that `thing` is a new version of, or '' for a new upload.
// Maps: a map id alone is NOT enough, because a copied folder keeps its source's id. The upload is pre-picked only when it is unambiguous:
//   - the upload this folder was installed / uploaded as (hub.json id), unless another local folder claims the same hub id and has a different name; else
//   - the upload with the same map id AND the same name, when no other local folder shares that map id.
// Anything else is a New upload (the user can still pick the entry by hand). Maps with no id: the same name, as before.
// mine: the user's uploads of this kind, as /api/me/submissions lists them.
// thing: { mapUid, modId, hubId, name, uidCount (local folders with this map id), hubCount (local folders recorded as this hub id) }.
export function defaultUpdateTarget(kind, mine, thing) {
  const uploads = mine || [];
  const t = thing || {};
  if (kind === 'maps') {
    const fromHub = t.hubId ? uploads.find((u) => u.id === t.hubId) : null;
    if (fromHub && (!(t.hubCount > 1) || norm(fromHub.name) === norm(t.name))) return fromHub.id;
    if (t.mapUid) {
      if (t.uidCount > 1) return '';
      const same = uploads.filter((u) => u.mapUid === t.mapUid && norm(u.name) === norm(t.name));
      return same.length === 1 ? same[0].id : '';
    }
    return uploads.find((u) => !u.mapUid && norm(u.name) === norm(t.name))?.id || '';
  }
  if (kind === 'mods') return t.modId ? uploads.find((u) => u.modId === t.modId)?.id || '' : '';
  if (kind === 'skins') return t.name ? uploads.find((u) => norm(u.name) === norm(t.name))?.id || '' : '';
  return '';
}

// How many of the installed maps `installed` (list_maps rows: uid, hub) share this map's id / hub id, for defaultUpdateTarget.
export function mapIdentityCounts(installed, m) {
  const list = installed || [];
  return {
    uidCount: m?.uid ? list.filter((x) => x.uid === m.uid).length : 0,
    hubCount: m?.hub ? list.filter((x) => x.hub === m.hub).length : 0,
  };
}

// Does another installed map (a different folder) carry the same map id? Then this one is a copy and needs an id of its own.
export function uidIsShared(installed, folderId, uid) {
  return !!uid && (installed || []).some((x) => x.id !== folderId && x.uid === uid);
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

import { escapeHtml, armConfirm } from '../ui.js';
import { isLoggedIn } from '../auth.js';
import { openAccount } from '../login-prompt.js';
import { forum } from '../social/api.js';
import { CATEGORIES, LIMITS, validatePost, validateReply, firstError } from '../social/validate.js';
import { createImageStrip, openLightbox } from '../social/images.js';
import { listHtml, pagerHtml, postHtml, replyHtml } from './lib.js';

const DRAFT_KEY = 'rechargeForumDraft';
let root = null;
let filters = { category: '', status: '', q: '', sort: 'new', page: 1 };
let teardown = []; // functions run when the current screen is replaced (image strips, timers)
let current = { screen: 'list', id: null };
let searchTimer = 0;
let loadSeq = 0; // a slow response for a screen the user has left must not paint over the current one

function leave() {
  for (const f of teardown.splice(0)) { try { f(); } catch { /* ignore */ } }
  clearTimeout(searchTimer);
}

const loginNote = () => '<div class="fm-login">Log in to take part. <button class="btn" data-act="login" type="button">Log In</button></div>';

// ---- draft (kept in localStorage while the composer is abandoned) ----
export function readDraft() {
  try { const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); return d && typeof d === 'object' ? d : null; } catch { return null; }
}
export function saveDraft(d) {
  try {
    if (!d.title && !d.body) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify({ title: d.title || '', body: d.body || '', category: d.category || 'bug' }));
  } catch { /* storage unavailable */ }
}
const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } };

// ---- list ----
function chipsHtml() {
  const chip = (id, label) => `<button class="chip${filters.category === id ? ' active' : ''}" data-act="cat" data-v="${id}" type="button">${label}</button>`;
  return chip('', 'All') + CATEGORIES.map((c) => chip(c.id, c.label)).join('');
}
function seg(act, cur, opts) {
  return `<span class="seg">${opts.map(([v, l]) => `<button class="chip${cur === v ? ' active' : ''}" data-act="${act}" data-v="${v}" type="button">${l}</button>`).join('')}</span>`;
}

async function showList() {
  leave();
  current = { screen: 'list', id: null };
  const seq = ++loadSeq;
  // One panel: the category and filter bars on top, the posts and the pager under them.
  root.innerHTML = `<div class="fm-board">
    <div class="fm-toolbar">
      <div class="fm-chips">${chipsHtml()}</div>
      <button class="btn btn-primary" data-act="new" type="button">New post</button>
    </div>
    <div class="fm-toolbar">
      ${seg('status', filters.status, [['', 'Any'], ['open', 'Open'], ['solved', 'Solved']])}
      ${seg('sort', filters.sort, [['new', 'New'], ['active', 'Active']])}
      <input class="browser-search fm-search" type="text" maxlength="100" placeholder="Search posts..." value="${escapeHtml(filters.q)}" />
    </div>
    <div class="fm-list" id="fm-list"><div class="empty-state">Loading...</div></div>
    <div id="fm-pager"></div></div>`;
  try {
    const data = await forum.list(filters);
    if (seq !== loadSeq) return;
    root.querySelector('#fm-list').innerHTML = listHtml(data);
    root.querySelector('#fm-pager').innerHTML = pagerHtml(data);
  } catch (e) {
    if (seq === loadSeq) root.querySelector('#fm-list').innerHTML = `<div class="empty-state">Couldn't load the forum: ${escapeHtml(e.message)}</div>`;
  }
}

// ---- post ----
async function showPost(id, { scrollToReply = false } = {}) {
  leave();
  current = { screen: 'post', id };
  const seq = ++loadSeq;
  root.innerHTML = '<button class="crumb-back" data-act="back" type="button" style="margin-bottom:16px;">&lt; Forum</button><div id="fm-post-host"><div class="empty-state">Loading...</div></div>';
  let data;
  try {
    data = await forum.get(id);
  } catch (e) {
    if (seq === loadSeq) root.querySelector('#fm-post-host').innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
    return;
  }
  if (seq !== loadSeq) return;
  const { post, replies } = data;
  const controls = [];
  if (post.can_edit) controls.push('<button class="btn" data-act="edit-post" type="button">Edit</button>');
  if (post.can_delete) controls.push('<button class="btn btn-danger" data-act="del-post" type="button">Delete</button>');
  const locked = post.status === 'closed';
  // One panel for the whole thread: the post, its controls, the replies and the reply box, split by thin dividers.
  root.querySelector('#fm-post-host').innerHTML = `<div class="fm-thread">
    ${postHtml(post)}
    ${controls.length ? `<div class="fm-controls">${controls.join('')}</div>` : ''}
    <div class="form-error fm-err" role="alert"></div>
    <div class="fm-replies-head">${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}</div>
    <div class="fm-reply-list">${replies.map(replyHtml).join('')}</div>
    <div class="fm-compose" id="fm-reply-box">${!isLoggedIn() ? loginNote() : locked ? '<div class="fm-login">This post is closed.</div>' : `
      <textarea class="form-input fm-reply-input" rows="4" maxlength="${LIMITS.reply}" placeholder="Write a reply..."></textarea>
      <div class="fm-strip" id="fm-reply-strip"></div>
      <div class="cm-form-row"><span class="cm-count"></span><span class="form-error" id="fm-reply-err" role="alert"></span><button class="btn btn-primary" data-act="reply" type="button">Reply</button></div>`}
    </div></div>`;
  const strip = root.querySelector('#fm-reply-strip');
  if (strip) {
    const ta = root.querySelector('.fm-reply-input');
    const s = createImageStrip(strip, { max: LIMITS.replyImages, pasteTarget: ta, onError: (m) => { root.querySelector('#fm-reply-err').textContent = m; } });
    teardown.push(() => s.destroy());
    root._replyStrip = s;
  }
  if (scrollToReply) root.querySelector('#fm-reply-box')?.scrollIntoView({ block: 'nearest' });
}

// ---- composer ----
export function showComposer(preset = {}) {
  leave();
  current = { screen: 'new', id: null };
  ++loadSeq;
  const draft = readDraft() || {};
  const v = {
    title: preset.title ?? draft.title ?? '',
    body: preset.body ?? draft.body ?? '',
    category: preset.category ?? draft.category ?? 'bug',
  };
  root.innerHTML = `
    <button class="crumb-back" data-act="back" type="button" style="margin-bottom:16px;">&lt; Forum</button>
    <div class="fm-compose fm-newpost">
      <div class="modal-title">New post</div>
      ${!isLoggedIn() ? loginNote() : ''}
      <label class="form-field">Category
        <span class="seg" id="fm-cat">${CATEGORIES.map((c) => `<button class="chip${v.category === c.id ? ' active' : ''}" data-act="pick-cat" data-v="${c.id}" type="button">${c.label}</button>`).join('')}</span>
      </label>
      <label class="form-field">Title <input class="form-input" id="fm-title" type="text" maxlength="${LIMITS.title}" value="${escapeHtml(v.title)}" placeholder="Short summary" /></label>
      <label class="form-field">Description <textarea class="form-input" id="fm-body" rows="9" maxlength="${LIMITS.post}" placeholder="What happened? What did you expect?">${escapeHtml(v.body)}</textarea></label>
      <div class="form-field">Images (up to ${LIMITS.postImages})<div class="fm-strip" id="fm-new-strip"></div></div>
      <div class="cm-form-row"><span class="cm-count" id="fm-body-count"></span><span class="form-error" id="fm-new-err" role="alert"></span>
        <button class="btn" data-act="discard" type="button">Discard draft</button>
        <button class="btn btn-primary" data-act="submit" type="button">Post</button></div>
    </div>`;
  root._category = v.category;
  const title = root.querySelector('#fm-title'), body = root.querySelector('#fm-body');
  const strip = createImageStrip(root.querySelector('#fm-new-strip'), { max: LIMITS.postImages, pasteTarget: body, onError: (m) => { root.querySelector('#fm-new-err').textContent = m; } });
  root._newStrip = strip;
  teardown.push(() => strip.destroy());
  // The title box takes pasted pictures too.
  const pasteTitle = (e) => { const f = [...(e.clipboardData?.files || [])].filter((x) => x.type.startsWith('image/')); if (f.length) { e.preventDefault(); strip.add(f); } };
  title.addEventListener('paste', pasteTitle);
  teardown.push(() => title.removeEventListener('paste', pasteTitle));
  const persist = () => {
    saveDraft({ title: title.value, body: body.value, category: root._category });
    const n = [...body.value].length;
    root.querySelector('#fm-body-count').textContent = n > LIMITS.post * 0.8 ? `${n}/${LIMITS.post}` : '';
  };
  title.addEventListener('input', persist);
  body.addEventListener('input', persist);
  teardown.push(() => { title.removeEventListener('input', persist); body.removeEventListener('input', persist); });
}

// ---- actions ----
const setErr = (msg) => { const e = root.querySelector('.fm-err') || root.querySelector('#fm-new-err'); if (e) e.textContent = msg || ''; };

async function submitNew(btn) {
  const title = root.querySelector('#fm-title').value, body = root.querySelector('#fm-body').value;
  const images = root._newStrip.files;
  const errEl = root.querySelector('#fm-new-err');
  if (!isLoggedIn()) { errEl.textContent = 'Log in to post.'; return; }
  const v = validatePost({ title, body, category: root._category, images });
  if (!v.ok) { errEl.textContent = firstError(v); return; }
  errEl.textContent = '';
  btn.disabled = true;
  try {
    const r = await forum.create({ title: title.trim(), body: body.trim(), category: root._category }, images);
    clearDraft();
    await showPost(r.post.id);
  } catch (e) {
    errEl.textContent = e.message;
    btn.disabled = false;
  }
}

async function submitReply(btn) {
  const ta = root.querySelector('.fm-reply-input');
  const errEl = root.querySelector('#fm-reply-err');
  const images = root._replyStrip?.files || [];
  const v = validateReply({ body: ta.value, images });
  if (!v.ok) { errEl.textContent = firstError(v); return; }
  errEl.textContent = '';
  btn.disabled = true;
  try {
    await forum.reply(current.id, ta.value.trim(), images);
    await showPost(current.id, { scrollToReply: true });
  } catch (e) {
    errEl.textContent = e.message;
    btn.disabled = false;
  }
}

async function guarded(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { setErr(e.message); btn.disabled = false; }
}

function startEditPost() {
  const art = root.querySelector('.fm-post');
  const title = art.querySelector('.fm-post-title').textContent;
  const body = art.dataset.rawBody;
  art.querySelector('.fm-post-title').outerHTML = `<input class="form-input" id="fm-edit-title" maxlength="${LIMITS.title}" value="${escapeHtml(title)}" />`;
  art.querySelector('.fm-post-body').outerHTML = `<textarea class="form-input" id="fm-edit-body" rows="8" maxlength="${LIMITS.post}">${escapeHtml(body)}</textarea><div class="cm-form-row"><button class="btn" data-act="cancel-edit" type="button">Cancel</button><button class="btn btn-primary" data-act="save-post" type="button">Save</button></div>`;
}

async function onClick(e) {
  const t = e.target;
  if (t.closest('[data-user]') || t.closest('a[data-ext-url]')) return; // handled globally
  const full = t.closest('.fm-img');
  if (full) { openLightbox(full.dataset.full); return; }
  const btn = t.closest('[data-act]');
  if (!btn) {
    const row = t.closest('.fm-row');
    if (row) showPost(row.dataset.post);
    return;
  }
  const act = btn.dataset.act, v = btn.dataset.v;
  switch (act) {
    case 'login': openAccount(); break;
    case 'back': showList(); break;
    case 'new': showComposer(); break;
    case 'cat': filters.category = v; filters.page = 1; showList(); break;
    case 'status': filters.status = v; filters.page = 1; showList(); break;
    case 'sort': filters.sort = v; filters.page = 1; showList(); break;
    case 'page': filters.page = Number(btn.dataset.page) || 1; showList(); break;
    case 'pick-cat':
      root._category = v;
      root.querySelectorAll('#fm-cat .chip').forEach((c) => c.classList.toggle('active', c.dataset.v === v));
      saveDraft({ title: root.querySelector('#fm-title').value, body: root.querySelector('#fm-body').value, category: v });
      break;
    case 'discard': clearDraft(); showComposer({ title: '', body: '', category: 'bug' }); break;
    case 'submit': submitNew(btn); break;
    case 'reply': submitReply(btn); break;
    case 'del-post':
      if (armConfirm(btn)) guarded(btn, async () => { await forum.remove(current.id); await showList(); });
      break;
    case 'edit-post': startEditPost(); break;
    case 'cancel-edit': showPost(current.id); break;
    case 'save-post': {
      const title = root.querySelector('#fm-edit-title').value.trim(), body = root.querySelector('#fm-edit-body').value.trim();
      if (!title || !body) { setErr('Title and description are required.'); break; }
      guarded(btn, async () => { await forum.edit(current.id, { title, body }); await showPost(current.id); });
      break;
    }
    case 'edit-reply': {
      const row = btn.closest('.fm-reply'), slot = row.querySelector('.cm-slot');
      if (slot.firstChild) { slot.innerHTML = ''; break; }
      slot.innerHTML = `<textarea class="form-input" rows="3" maxlength="${LIMITS.reply}">${escapeHtml(row.dataset.raw || '')}</textarea><div class="cm-form-row"><span class="form-error" role="alert"></span><button class="btn" data-act="cancel-reply-edit" type="button">Cancel</button><button class="btn btn-primary" data-act="save-reply" type="button">Save</button></div>`;
      break;
    }
    case 'cancel-reply-edit': btn.closest('.cm-slot').innerHTML = ''; break;
    case 'save-reply': {
      const row = btn.closest('.fm-reply'), ta = row.querySelector('.cm-slot textarea'), er = row.querySelector('.cm-slot .form-error');
      const vv = validateReply({ body: ta.value });
      if (!vv.ok) { er.textContent = firstError(vv); break; }
      btn.disabled = true;
      try { await forum.editReply(row.dataset.rid, ta.value.trim()); await showPost(current.id); } catch (err) { er.textContent = err.message; btn.disabled = false; }
      break;
    }
    case 'del-reply':
      if (armConfirm(btn)) guarded(btn, async () => { await forum.removeReply(btn.closest('.fm-reply').dataset.rid); await showPost(current.id); });
      break;
  }
}

function onInput(e) {
  if (e.target.matches('.fm-search')) {
    clearTimeout(searchTimer);
    const val = e.target.value;
    searchTimer = setTimeout(() => { filters.q = val.trim(); filters.page = 1; showList(); }, 350);
  } else if (e.target.matches('.fm-reply-input')) {
    const n = [...e.target.value].length;
    root.querySelector('#fm-reply-box .cm-count').textContent = n > LIMITS.reply * 0.8 ? `${n}/${LIMITS.reply}` : '';
  }
}

function onKey(e) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.fm-row')) { e.preventDefault(); showPost(e.target.dataset.post); }
}

function consumePreset() {
  const p = window.__forumPreset;
  if (!p) return false;
  window.__forumPreset = null;
  showComposer(p);
  return true;
}

export async function init() {
  root = document.getElementById('forum-root');
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKey);
  if (!consumePreset()) await showList();
}

export async function onShow() {
  if (consumePreset()) return;
  if (current.screen === 'list') await showList();
  else if (current.screen === 'post' && !root.querySelector('.fm-reply-input')?.value) await showPost(current.id); // pictures / names may have changed meanwhile
}

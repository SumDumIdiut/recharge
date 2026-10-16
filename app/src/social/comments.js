// Comments under a skin / playlist / mod / map. commentsHtml() is pure (testable under node); mountComments() wires it to the DOM.
import { escapeHtml, armConfirm } from '../ui.js';
import { isLoggedIn } from '../auth.js';
import { avatarHtml, nameHtml, userOf, titlesHtml } from './avatar.js';
import { richText, timeAgo } from './text.js';
import { validateComment, firstError, LIMITS } from './validate.js';
import { comments as api } from './api.js';

// The hub wants parent_id as a number; the id read back from a data-cid attribute is a string.
export const parentIdOf = (cid) => Number(cid);

function oneHtml(c, { reply = false } = {}) {
  const u = userOf(c);
  const acts = [];
  if (!reply) acts.push('<button class="link-btn" data-act="reply" type="button">Reply</button>');
  if (c.can_edit) acts.push('<button class="link-btn" data-act="edit" type="button">Edit</button>');
  if (c.can_delete) acts.push('<button class="link-btn link-danger" data-act="del" type="button">Delete</button>');
  return `<div class="cm${reply ? ' cm-reply' : ''}" data-cid="${escapeHtml(c.id)}">
    ${avatarHtml(u, reply ? 26 : 32)}
    <div class="cm-main">
      <div class="cm-head">${nameHtml(u)}${titlesHtml(u)}<span class="cm-time">${escapeHtml(timeAgo(c.created_at))}${c.edited_at ? ' (edited)' : ''}</span></div>
      <div class="cm-body rich">${richText(c.body)}</div>
      ${acts.length ? `<div class="cm-acts">${acts.join('')}</div>` : ''}
      <div class="cm-slot"></div>
    </div>
  </div>`;
}

// data = the hub's comments response (or { comments: [...] }).
export function commentsHtml(list, { loggedIn = false } = {}) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return `<div class="cm-empty">No comments yet.${loggedIn ? ' Be the first.' : ''}</div>`;
  return items
    .map((c) => `<div class="cm-thread">${oneHtml(c)}${(c.replies || []).map((r) => oneHtml(r, { reply: true })).join('')}</div>`)
    .join('');
}

export function composerHtml({ loggedIn, placeholder = 'Write a comment...', act = 'post', label = 'Comment', cancel = false, text = '' } = {}) {
  if (!loggedIn) return '<div class="cm-login">Log in to comment.</div>';
  // The text box and its buttons share one row; the count and any error sit underneath.
  return `<div class="cm-form">
    <div class="cm-input-row">
      <textarea class="form-input cm-input" rows="1" maxlength="${LIMITS.comment}" placeholder="${escapeHtml(placeholder)}">${escapeHtml(text)}</textarea>
      ${cancel ? '<button class="btn" data-act="cancel" type="button">Cancel</button>' : ''}
      <button class="btn btn-primary" data-act="${act}" type="button">${escapeHtml(label)}</button>
    </div>
    <div class="cm-form-row"><span class="cm-count"></span><span class="form-error" role="alert"></span></div>
  </div>`;
}

export function mountComments(host, kind, id) {
  let dead = false;
  let data = [];
  let total = 0, page = 1, pages = 1;
  host.classList.add('comments');
  host.innerHTML = `<div class="comments-title">Comments <span class="comments-n"></span></div><div class="cm-top"></div><div class="cm-list"><div class="cm-empty">Loading...</div></div><div class="cm-more"></div>`;
  const top = host.querySelector('.cm-top'), listEl = host.querySelector('.cm-list'), moreEl = host.querySelector('.cm-more');

  const paint = () => {
    if (dead) return;
    listEl.innerHTML = commentsHtml(data, { loggedIn: isLoggedIn() });
    host.querySelector('.comments-n').textContent = total ? `(${total})` : '';
    moreEl.innerHTML = page < pages ? '<button class="btn" data-act="more" type="button">Load more</button>' : '';
  };
  const paintTop = () => { top.innerHTML = composerHtml({ loggedIn: isLoggedIn() }); };
  paintTop();

  async function load(p) {
    try {
      const r = await api.list(kind, id, p);
      if (dead) return;
      data = p === 1 ? r.comments || [] : data.concat(r.comments || []);
      total = r.total || 0; page = r.page || p; pages = r.pages || 1;
      paint();
    } catch (e) {
      if (!dead) listEl.innerHTML = `<div class="cm-empty">Couldn't load comments: ${escapeHtml(e.message)}</div>`;
    }
  }
  load(1);

  const findC = (cid) => { for (const c of data) { if (String(c.id) === cid) return c; for (const r of c.replies || []) if (String(r.id) === cid) return r; } return null; };
  const err = (form, msg) => { const e = form.querySelector('.form-error'); if (e) e.textContent = msg || ''; };
  const busy = (btn, on) => { btn.disabled = on; };

  async function onClick(ev) {
    const btn = ev.target.closest('[data-act]');
    if (!btn || !host.contains(btn)) return;
    const act = btn.dataset.act;
    const row = btn.closest('.cm');
    const cid = row?.dataset.cid;
    if (act === 'more') { btn.disabled = true; await load(page + 1); return; }
    if (act === 'reply' || act === 'edit') {
      const slot = row.querySelector('.cm-slot');
      if (slot.firstChild) { slot.innerHTML = ''; return; }
      if (!isLoggedIn()) { slot.innerHTML = composerHtml({ loggedIn: false }); return; }
      const c = findC(cid);
      slot.innerHTML = act === 'reply'
        ? composerHtml({ loggedIn: true, placeholder: 'Write a reply...', act: 'send-reply', label: 'Reply', cancel: true })
        : composerHtml({ loggedIn: true, act: 'save-edit', label: 'Save', cancel: true, text: c?.body || '' });
      slot.querySelector('textarea')?.focus();
      return;
    }
    if (act === 'cancel') { btn.closest('.cm-slot').innerHTML = ''; return; }
    if (act === 'del') {
      if (!armConfirm(btn)) return;
      busy(btn, true);
      try { await api.remove(cid); await load(1); } catch (e) { busy(btn, false); const s = row.querySelector('.cm-slot'); s.innerHTML = `<span class="form-error">${escapeHtml(e.message)}</span>`; }
      return;
    }
    if (act === 'post' || act === 'send-reply' || act === 'save-edit') {
      const form = btn.closest('.cm-form');
      const text = form.querySelector('textarea').value;
      const v = validateComment({ body: text });
      if (!v.ok) { err(form, firstError(v)); return; }
      err(form, '');
      busy(btn, true);
      try {
        if (act === 'post') await api.add(kind, id, text.trim());
        else if (act === 'send-reply') await api.add(kind, id, text.trim(), parentIdOf(cid));
        else await api.edit(cid, text.trim());
        if (act === 'post') form.querySelector('textarea').value = '';
        await load(1);
        if (act !== 'post') row.querySelector('.cm-slot').innerHTML = '';
      } catch (e) {
        err(form, e.message);
      } finally {
        busy(btn, false);
      }
    }
  }
  function onInput(ev) {
    const ta = ev.target.closest?.('.cm-input');
    if (!ta) return;
    const n = [...ta.value].length;
    const c = ta.closest('.cm-form').querySelector('.cm-count');
    c.textContent = n > LIMITS.comment * 0.8 ? `${n}/${LIMITS.comment}` : '';
  }
  host.addEventListener('click', onClick);
  host.addEventListener('input', onInput);
  let wasIn = isLoggedIn();
  const onLogin = () => { if (isLoggedIn() === wasIn) return; wasIn = isLoggedIn(); paintTop(); paint(); };
  window.addEventListener('focus', onLogin);
  return {
    destroy() {
      dead = true;
      host.removeEventListener('click', onClick);
      host.removeEventListener('input', onInput);
      window.removeEventListener('focus', onLogin);
      host.innerHTML = '';
    },
  };
}

// Pure markup builders for the forum (testable under node): list rows, post header, replies.
import { escapeHtml } from '../ui.js';
import { avatarHtml, nameHtml, userOf, hubUrl } from '../social/avatar.js';
import { richText, timeAgo } from '../social/text.js';
import { CATEGORIES } from '../social/validate.js';

export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label.replace(/s$/, '')]));

export const ICON_TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

export function statusBadge(status) {
  if (status === 'solved') return `<span class="fm-status fm-solved" title="Solved">${ICON_TICK}Solved</span>`;
  if (status === 'closed') return '<span class="fm-status fm-closed" title="Closed">Closed</span>';
  return '';
}
export const categoryTag = (cat) => `<span class="tag fm-cat fm-cat-${escapeHtml(cat)}">${escapeHtml(CATEGORY_LABEL[cat] || cat)}</span>`;

// The status actions this viewer may take. The hub decides via can_status: an author while the
// post is open or solved, an admin always. A closed post can therefore only be reopened by an admin.
export function statusControlsHtml(post) {
  if (!post || !post.can_status) return '';
  const status = post.status || 'open';
  const buttons = status === 'open'
    ? ['<button class="btn" data-act="set-status" data-v="solved" type="button">Mark solved</button>']
    : ['<button class="btn" data-act="set-status" data-v="open" type="button">Reopen</button>'];
  if (status !== 'closed') buttons.push('<button class="btn" data-act="set-status" data-v="closed" type="button">Close</button>');
  return buttons.join('');
}

export function postRowHtml(p) {
  const u = userOf(p);
  return `<div class="fm-row" data-post="${escapeHtml(p.id)}" role="button" tabindex="0">
    ${avatarHtml(u, 38)}
    <div class="fm-row-main">
      <div class="fm-row-title">${p.pinned ? '<span class="fm-pin" title="Pinned">PIN</span>' : ''}${escapeHtml(p.title)}</div>
      <div class="fm-row-meta">${nameHtml(u)} &middot; ${escapeHtml(timeAgo(p.last_activity_at || p.created_at))}</div>
    </div>
    ${categoryTag(p.category)}
    ${statusBadge(p.status) || '<span class="fm-status"></span>'}
    <span class="fm-replies" title="Replies">${escapeHtml(p.reply_count ?? 0)}</span>
  </div>`;
}

export function listHtml(data) {
  const posts = data && Array.isArray(data.posts) ? data.posts : [];
  if (!posts.length) return '<div class="empty-state">No posts here yet.</div>';
  return posts.map(postRowHtml).join('');
}

export function imagesHtml(images) {
  const list = (Array.isArray(images) ? images : []).map((u) => hubUrl(u)).filter(Boolean);
  if (!list.length) return '';
  return `<div class="fm-images">${list.map((u) => `<button type="button" class="fm-img" data-full="${escapeHtml(u)}" aria-label="Enlarge image"><img src="${escapeHtml(u)}" alt="" loading="lazy" decoding="async" /></button>`).join('')}</div>`;
}

export function replyHtml(r) {
  const u = userOf(r);
  const acts = [];
  if (r.can_edit) acts.push('<button class="link-btn" data-act="edit-reply" type="button">Edit</button>');
  if (r.can_delete) acts.push('<button class="link-btn link-danger" data-act="del-reply" type="button">Delete</button>');
  return `<div class="fm-reply" data-rid="${escapeHtml(r.id)}" data-raw="${escapeHtml(r.body)}">
    ${avatarHtml(u, 34)}
    <div class="fm-reply-main">
      <div class="cm-head">${nameHtml(u)}<span class="cm-time">${escapeHtml(timeAgo(r.created_at))}${r.edited_at ? ' (edited)' : ''}</span></div>
      <div class="fm-reply-body rich">${richText(r.body)}</div>
      ${imagesHtml(r.images)}
      ${acts.length ? `<div class="cm-acts">${acts.join('')}</div>` : ''}
      <div class="cm-slot"></div>
    </div>
  </div>`;
}

export function postHtml(post) {
  const u = userOf(post);
  return `<article class="fm-post" data-post="${escapeHtml(post.id)}" data-raw-body="${escapeHtml(post.body)}">
    <h2 class="fm-post-title">${escapeHtml(post.title)}</h2>
    <div class="fm-post-badges">${categoryTag(post.category)}${statusBadge(post.status)}${post.pinned ? '<span class="tag">Pinned</span>' : ''}</div>
    <div class="fm-author">${avatarHtml(u, 44)}<div><div>${nameHtml(u)}</div><div class="cm-time">${escapeHtml(timeAgo(post.created_at))}${post.updated_at && post.updated_at !== post.created_at ? ' (edited)' : ''}</div></div></div>
    <div class="fm-post-body rich">${richText(post.body)}</div>
    ${imagesHtml(post.images)}
  </article>`;
}

export function pagerHtml(data) {
  const pages = data?.pages || 1, page = data?.page || 1;
  if (pages <= 1) return '';
  return `<div class="fm-pager"><button class="btn" data-act="page" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} type="button">Prev</button><span>Page ${escapeHtml(page)} of ${escapeHtml(pages)}</span><button class="btn" data-act="page" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} type="button">Next</button></div>`;
}

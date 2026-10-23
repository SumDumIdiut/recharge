// Client-side checks that mirror the hub's limits, so errors show before the upload. The hub stays the authority.
export const LIMITS = { title: 120, post: 5000, reply: 3000, comment: 1000, bio: 300, pronouns: 20, postImages: 4, replyImages: 2, imageBytes: 5 * 1024 * 1024, avatarBytes: 2 * 1024 * 1024, links: 3 };
export const CATEGORIES = [
  { id: 'bug', label: 'Bugs' },
  { id: 'issue', label: 'Issues' },
  { id: 'question', label: 'Questions' },
  { id: 'suggestion', label: 'Suggestions' },
];
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const len = (s) => [...String(s ?? '')].length;

export function validateImages(images, max) {
  const list = Array.isArray(images) ? images : [];
  if (list.length > max) return `At most ${max} image${max === 1 ? '' : 's'}.`;
  for (const f of list) {
    if (f.type && !IMAGE_TYPES.includes(f.type)) return 'Images must be PNG, JPEG, GIF or WebP.';
    if (f.size > LIMITS.imageBytes) return 'Each image must be under 5 MB.';
  }
  return '';
}

// -> { ok, errors: { title?, body?, category?, images? } }
export function validatePost({ title, body, category, images } = {}) {
  const errors = {};
  const t = String(title ?? '').trim();
  if (!t) errors.title = 'Give your post a title.';
  else if (len(t) > LIMITS.title) errors.title = `Title is too long (${len(t)}/${LIMITS.title}).`;
  const b = String(body ?? '').trim();
  if (!b) errors.body = 'Describe the problem or idea.';
  else if (len(b) > LIMITS.post) errors.body = `Description is too long (${len(b)}/${LIMITS.post}).`;
  if (!CATEGORIES.some((c) => c.id === category)) errors.category = 'Pick a category.';
  const im = validateImages(images, LIMITS.postImages);
  if (im) errors.images = im;
  return { ok: !Object.keys(errors).length, errors };
}

export function validateReply({ body, images } = {}) {
  const errors = {};
  const b = String(body ?? '').trim();
  if (!b) errors.body = 'Write something first.';
  else if (len(b) > LIMITS.reply) errors.body = `Reply is too long (${len(b)}/${LIMITS.reply}).`;
  const im = validateImages(images, LIMITS.replyImages);
  if (im) errors.images = im;
  return { ok: !Object.keys(errors).length, errors };
}

export function validateComment({ body } = {}) {
  const b = String(body ?? '').trim();
  if (!b) return { ok: false, errors: { body: 'Write something first.' } };
  if (len(b) > LIMITS.comment) return { ok: false, errors: { body: `Comment is too long (${len(b)}/${LIMITS.comment}).` } };
  return { ok: true, errors: {} };
}

export const firstError = (r) => Object.values(r.errors)[0] || '';

import { h } from '../dom.js';
import { icon } from '../icons.js';
import type { MediaEntry } from './api.js';
import { videoBaseUrl } from './api.js';
import { mediaUrl, videoUrl } from './model.js';

/** A small preview of one picture or video: the picture itself, a video's poster, or the first frame of a video. Nothing plays. */
export function mediaThumb(kind: 'backgrounds' | 'playlists', folder: string, media: MediaEntry | null): HTMLElement {
  const box = h('div', { className: 'bg-thumb' });
  if (!media) {
    box.classList.add('is-none');
    box.appendChild(icon('image', 28));
    return box;
  }
  if (media.kind === 'image') {
    box.appendChild(h('img', { attrs: { src: mediaUrl(kind, folder, media.file), alt: '', loading: 'lazy', decoding: 'async' } }));
  } else if (media.poster) {
    box.appendChild(h('img', { attrs: { src: mediaUrl(kind, folder, media.poster), alt: '', loading: 'lazy', decoding: 'async' } }));
  } else {
    // preload=metadata plus a time fragment shows the first frame without decoding the whole file
    box.appendChild(h('video', { attrs: { src: (videoBaseUrl() ? videoUrl(videoBaseUrl(), kind, folder, media.file) : mediaUrl(kind, folder, media.file)) + '#t=0.1', preload: 'metadata', muted: '', playsinline: '' } }));
  }
  if (media.kind === 'video') box.appendChild(h('span', { className: 'bg-badge', text: 'Video' }));
  return box;
}

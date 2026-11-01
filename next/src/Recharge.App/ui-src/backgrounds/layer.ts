import {
  blurStyle, dimStyle, fitStyle, pageOf, playbackPlan, Rotation,
  type BgConfig, type PageId,
} from './model.js';

export interface LayerItem {
  url: string;
  kind: 'image' | 'video';
  poster: string | null;
}

/**
 * The one background layer of the app: a fixed, composited box behind everything (z-index -1) that holds a media box (the picture or
 * video, two slots while crossfading) and a dim box on top. WebKitGTK rules kept: no background-attachment: fixed, no
 * backdrop-filter, will-change only on a slot while it fades, and a video is paused (and its decoder released when it leaves)
 * whenever the window is hidden, unfocused (setting) or in low-power mode.
 */
const CSS = `
#bg-layer { position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; transform: translateZ(0); contain: strict; }
#bg-media { position: absolute; inset: 0; }
.bg-slot { position: absolute; inset: 0; opacity: 0; }
.bg-slot > .bg-el { display: block; width: 100%; height: 100%; }
#bg-dim { position: absolute; inset: 0; opacity: 0; }
:root[data-bg="on"] body::before { display: none !important; }
`;

function releaseVideo(video: HTMLVideoElement): void {
  try {
    video.pause();
    video.removeAttribute('src');
    video.removeAttribute('poster');
    video.load();
  } catch {
    /* already gone */
  }
}

export class BackgroundLayer {
  readonly root: HTMLDivElement;
  private readonly media: HTMLDivElement;
  private readonly dim: HTMLDivElement;
  private config: BgConfig | null = null;
  private items: LayerItem[] = [];
  private rotation: Rotation | null = null;
  private slots: HTMLDivElement[] = [];
  private timer = 0;
  private generation = 0;
  private focused = true;
  private reducedMotion = false;
  private page: PageId | null = null;
  private readonly cleanup: Array<() => void> = [];
  /** How many items were shown, for tests and the readout. */
  shown = 0;

  private readonly doc: Document;
  private readonly win: Window;

  constructor(doc: Document = document, win: Window = window) {
    this.doc = doc;
    this.win = win;
    const style = doc.createElement('style');
    style.id = 'bg-layer-style';
    style.textContent = CSS;
    doc.head.appendChild(style);
    this.root = doc.createElement('div');
    this.root.id = 'bg-layer';
    this.root.setAttribute('aria-hidden', 'true');
    this.media = doc.createElement('div');
    this.media.id = 'bg-media';
    this.dim = doc.createElement('div');
    this.dim.id = 'bg-dim';
    this.root.append(this.media, this.dim);
    doc.body.prepend(this.root);
    this.page = pageOf(this.win.location.hash);
    this.focused = typeof doc.hasFocus === 'function' ? doc.hasFocus() : true;
    try {
      const query = this.win.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = query.matches;
      const onMotion = () => { this.reducedMotion = query.matches; this.syncPlayback(); };
      query.addEventListener('change', onMotion);
      this.cleanup.push(() => query.removeEventListener('change', onMotion));
    } catch {
      /* no matchMedia */
    }
    this.listen(doc, 'visibilitychange', () => this.syncPlayback());
    this.listen(win, 'focus', () => { this.focused = true; this.syncPlayback(); });
    this.listen(win, 'blur', () => { this.focused = false; this.syncPlayback(); });
    this.listen(win, 'hashchange', () => { this.page = pageOf(this.win.location.hash); this.paintDim(); });
  }

  private listen(target: EventTarget, type: string, fn: () => void): void {
    target.addEventListener(type, fn);
    this.cleanup.push(() => target.removeEventListener(type, fn));
  }

  /** Shows the items with this config. An empty list (or source none) clears the layer. */
  apply(config: BgConfig, items: LayerItem[]): void {
    const sameItems = this.items.length === items.length && this.items.every((it, i) => it.url === items[i].url);
    this.config = config;
    this.paintStyle();
    if (sameItems && this.slots.length > 0) {
      // only the look changed: keep what is playing
      this.restartTimer();
      this.syncPlayback();
      return;
    }
    this.items = items;
    this.generation += 1;
    this.clearTimer();
    if (items.length === 0) {
      this.doc.documentElement.removeAttribute('data-bg');
      this.removeSlots(this.slots.slice(), 0);
      this.rotation = null;
      return;
    }
    this.doc.documentElement.setAttribute('data-bg', 'on');
    this.rotation = new Rotation(items.length, config.shuffle);
    this.showIndex(this.rotation.next());
  }

  private paintStyle(): void {
    const c = this.config;
    if (!c) return;
    const blur = blurStyle(c);
    this.media.style.filter = blur.filter;
    this.media.style.transform = blur.transform;
    for (const slot of this.slots) this.styleEl(slot.firstElementChild as HTMLElement | null);
    this.paintDim();
  }

  private paintDim(): void {
    if (!this.config) return;
    const d = dimStyle(this.config, this.page);
    this.dim.style.background = d.background;
    this.dim.style.opacity = d.opacity;
  }

  private styleEl(el: HTMLElement | null): void {
    if (!el || !this.config) return;
    const f = fitStyle(this.config);
    el.style.objectFit = f.objectFit;
    el.style.objectPosition = f.objectPosition;
  }

  private showIndex(index: number): void {
    const item = this.items[index];
    if (!item || !this.config) return;
    const generation = this.generation;
    const fadeMs = this.config.fadeMs;
    const slot = this.doc.createElement('div');
    slot.className = 'bg-slot';
    let el: HTMLImageElement | HTMLVideoElement;
    let ready: Promise<void>;
    if (item.kind === 'video') {
      const video = this.doc.createElement('video');
      video.className = 'bg-el';
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.autoplay = false;
      video.preload = 'auto';
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');
      if (item.poster) video.poster = item.poster;
      ready = new Promise<void>((resolve) => {
        video.addEventListener('loadeddata', () => resolve(), { once: true });
        video.addEventListener('error', () => resolve(), { once: true });
        // a poster is enough to start the fade
        if (item.poster) {
          const probe = new Image();
          probe.onload = () => resolve();
          probe.src = item.poster;
        }
      });
      video.src = item.url;
      el = video;
    } else {
      const img = this.doc.createElement('img');
      img.className = 'bg-el';
      img.decoding = 'async';
      img.alt = '';
      ready = new Promise<void>((resolve) => {
        img.addEventListener('load', () => resolve(), { once: true });
        img.addEventListener('error', () => resolve(), { once: true });
      });
      img.src = item.url;
      el = img;
    }
    this.styleEl(el);
    slot.appendChild(el);
    this.media.appendChild(slot);
    const old = this.slots.slice();
    this.slots.push(slot);
    this.shown += 1;
    this.syncPlayback();
    const timeout = new Promise<void>((resolve) => this.win.setTimeout(resolve, 8000));
    void Promise.race([ready, timeout]).then(() => {
      if (generation !== this.generation || !this.slots.includes(slot)) return;
      if (el instanceof HTMLVideoElement && el.paused && el.readyState >= 2 && el.currentTime === 0) el.currentTime = 0.001;
      if (fadeMs <= 0) {
        slot.style.opacity = '1';
        this.removeSlots(old, 0);
      } else {
        slot.style.willChange = 'opacity';
        slot.style.transition = 'opacity ' + fadeMs + 'ms ease';
        this.win.requestAnimationFrame(() => this.win.requestAnimationFrame(() => { slot.style.opacity = '1'; }));
        this.win.setTimeout(() => {
          slot.style.willChange = '';
          slot.style.transition = '';
          this.removeSlots(old, 0);
        }, fadeMs + 60);
      }
      this.restartTimer();
    });
  }

  private removeSlots(slots: HTMLDivElement[], _delay: number): void {
    for (const slot of slots) {
      const el = slot.firstElementChild;
      if (el instanceof HTMLVideoElement) releaseVideo(el);
      slot.remove();
      const at = this.slots.indexOf(slot);
      if (at >= 0) this.slots.splice(at, 1);
    }
  }

  private plan(): ReturnType<typeof playbackPlan> {
    const c = this.config;
    return playbackPlan({
      documentHidden: this.doc.hidden === true,
      windowFocused: this.focused,
      pauseUnfocused: c ? c.pauseUnfocused : true,
      // The Halloween event look hides this layer, so nothing in it plays meanwhile.
      stillOnly: (c ? c.stillOnly : false) || this.doc.documentElement.getAttribute('data-theme') === 'halloween',
      reducedMotion: this.reducedMotion,
    });
  }

  /** Plays or pauses every video to match the playback rule. */
  syncPlayback(): void {
    const play = this.plan().play;
    for (const slot of this.slots) {
      const el = slot.firstElementChild;
      if (!(el instanceof HTMLVideoElement)) continue;
      if (play) void el.play().catch(() => undefined);
      else el.pause();
    }
    if (!this.plan().play && this.doc.hidden) this.clearTimer();
    else if (this.timer === 0 && this.items.length > 1 && this.slots.length > 0) this.restartTimer();
  }

  private clearTimer(): void {
    if (this.timer) this.win.clearTimeout(this.timer);
    this.timer = 0;
  }

  private restartTimer(): void {
    this.clearTimer();
    const c = this.config;
    if (!c || this.items.length < 2 || this.doc.hidden) return;
    this.timer = this.win.setTimeout(() => {
      this.timer = 0;
      if (this.doc.hidden || !this.rotation) { this.restartTimer(); return; }
      this.showIndex(this.rotation.next());
    }, c.interval * 1000);
  }

  /** Whether any video element is currently playing (for tests and the readout). */
  playingVideos(): number {
    return this.slots.filter((s) => {
      const el = s.firstElementChild;
      return el instanceof HTMLVideoElement && !el.paused;
    }).length;
  }

  dispose(): void {
    this.clearTimer();
    this.generation += 1;
    this.removeSlots(this.slots.slice(), 0);
    this.cleanup.splice(0).forEach((fn) => fn());
    this.doc.documentElement.removeAttribute('data-bg');
    this.root.remove();
  }
}

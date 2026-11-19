/** Voice rooms: one peer connection to the roomless Cloudflare SFU. Publish mic/cam, subscribe to the roster. */
import { call, describeError } from '../bridge.js';
import { SocialError, voiceCloseTracks, voiceIce, voiceNewTracks, voiceRenegotiate, voiceSession, type VoiceTrackInfo } from './api.js';
import { openFeed, type FeedEvent } from './events.js';

export type VoiceTrack = 'mic' | 'cam';
export type CallKind = 'audio' | 'video';

export interface VoiceMember { username: string; sessionId: string; tracks: string[]; muted: boolean; cam: boolean }
export interface VoiceState { convId: string; members: VoiceMember[] }

export interface VoiceHooks {
  onState(state: VoiceState): void;
  onTrack(username: string, track: VoiceTrack): void;
  onTrackLost(username: string, track: VoiceTrack): void;
  onError(message: string): void;
  onLevel(username: string, speaking: boolean): void;
}

interface LevelMeter {
  ctx: AudioContext;
  src: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  data: Uint8Array;
  speaking: boolean;
}

const KEY = '\u0000';
const keyOf = (username: string, track: VoiceTrack): string => username.toLowerCase() + KEY + track;

/** Parse a voice.state push; null when it is malformed or for another room. */
export function parseVoiceState(event: FeedEvent, convId?: string): VoiceState | null {
  if (event.type !== 'voice.state') return null;
  const id = typeof event.convId === 'string' ? event.convId : typeof event.channelId === 'string' ? event.channelId : '';
  if (!id || (convId && id !== convId)) return null;
  const members: VoiceMember[] = [];
  for (const raw of Array.isArray(event.members) ? event.members : []) {
    const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const username = typeof o.username === 'string' ? o.username : '';
    if (!username) continue;
    members.push({
      username,
      sessionId: typeof o.sessionId === 'string' ? o.sessionId : '',
      tracks: Array.isArray(o.tracks) ? o.tracks.filter((t): t is string => typeof t === 'string') : [],
      muted: o.muted === true,
      cam: o.cam === true,
    });
  }
  return { convId: id, members };
}

/** Resolve once ICE gathering finishes, with a short ceiling for stubborn networks. */
function waitIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let timer = 0;
    const finish = (): void => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      window.clearTimeout(timer);
      resolve();
    };
    const onChange = (): void => { if (pc.iceGatheringState === 'complete') finish(); };
    pc.addEventListener('icegatheringstatechange', onChange);
    timer = window.setTimeout(finish, 2500);
  });
}

export class VoiceClient {
  readonly convId: string;
  readonly channelId: string;   // alias for the voice-channel views
  private readonly me: string;
  private kind: CallKind;
  private readonly hooks: VoiceHooks;
  private pc: RTCPeerConnection | null = null;
  private sessionId = '';
  private micTrack: MediaStreamTrack | null = null;
  private camTrack: MediaStreamTrack | null = null;
  private camTx: RTCRTPTransceiver | null = null;
  private micMid = '';
  private camMid = '';
  private readonly ownTracks = new Set<MediaStreamTrack>();
  private readonly subscribed = new Set<string>();
  private readonly midMap = new Map<string, { username: string; track: VoiceTrack }>();
  private pendingMids: Array<{ username: string; track: VoiceTrack }> = [];
  private readonly elements = new Map<string, HTMLMediaElement>();
  private readonly mutedBy = new Map<string, boolean>();
  private readonly levels = new Map<string, LevelMeter>();
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;
  private state: VoiceState = { convId: '', members: [] };
  private stopFeed: (() => void) | null = null;
  private raf = 0;
  private stopped = false;
  private signaling = false;
  private joining = false;
  private active = false;
  private camBusy = false;
  private micMuted = false;
  private camOn = false;
  private deafened = false;

  constructor(convId: string, me: string, hooks: VoiceHooks, kind: CallKind = 'audio') {
    this.convId = convId;
    this.channelId = convId;
    this.me = me;
    this.hooks = hooks;
    this.kind = kind;
  }

  get joined(): boolean { return this.active; }
  get closed(): boolean { return this.stopped; }
  get isMuted(): boolean { return this.micMuted; }
  get cameraOn(): boolean { return this.camOn; }
  get isDeafened(): boolean { return this.deafened; }

  /** The element for a remote track, for the UI to place inside that person's tile. */
  mediaFor(username: string, track: VoiceTrack): HTMLMediaElement | null {
    return this.elements.get(keyOf(username, track)) || null;
  }

  /** Join the room's presence roster and start listening for voice.state (no media yet). */
  enter(kind: CallKind = this.kind): void {
    if (this.stopped) return;
    this.kind = kind;
    if (!this.stopFeed) {
      this.stopFeed = openFeed((event) => {
        if (event.type === 'voice.native.state') { this.onNativeState(event); return; }
        const state = parseVoiceState(event, this.convId);
        if (state) { console.log('[voice] voice.state received, members=' + state.members.length); this.applyState(state); }
      });
    }
    if (!this.signaling) {
      this.signaling = true;
      // The native host sends voice.join itself (from the same connection that publishes the SFU tracks).
      if (VoiceClient.webrtcSupported) this.frame({ type: 'voice.join', kind });
    }
  }

  /** Some embedded web views (the Linux WebKitGTK build) ship no WebRTC, so a peer connection can't be made. */
  static get webrtcSupported(): boolean { return typeof RTCPeerConnection !== 'undefined'; }

  /** Acquire the mic (camera too for a video call), open the SFU session and publish. Safe to call once. */
  async join(kind: CallKind = this.kind): Promise<void> {
    if (this.active || this.joining || this.stopped) return;
    this.joining = true;
    this.enter(kind);
    // WebKitGTK has no RTCPeerConnection: the C# host owns WebRTC and audio (see docs/native-voice-plan.md).
    if (!VoiceClient.webrtcSupported) {
      try {
        await call('voice.native.join', { convId: this.convId, channelId: this.convId, kind, username: this.me });
        if (this.stopped) return;
        this.active = true;
        this.joining = false;
        this.micMuted = false;
        this.patchSelf({ sessionId: '', tracks: ['mic'], muted: false, cam: false });
        this.applyState(this.state);
        this.hooks.onState(this.state);
      } catch (error) {
        this.joining = false;
        // Native voice is the fallback for a web view without WebRTC; if it fails too, say so clearly.
        this.hooks.onError("This app's web view has no WebRTC and native voice couldn't start: " + describeError(error));
      }
      return;
    }
    const video = kind === 'video';
    let stream: MediaStream;
    try {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') throw new Error('unsupported');
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    } catch {
      if (!video) {
        this.joining = false;
        this.hooks.onError('Microphone access was blocked. Allow microphone access to join voice.');
        this.leave();
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        this.hooks.onError('No camera was found; joined with audio only.');
      } catch {
        this.joining = false;
        this.hooks.onError('Microphone access was blocked. Allow microphone access to join voice.');
        this.leave();
        return;
      }
    }
    if (this.stopped) { stopStream(stream); return; }
    const mic = stream.getAudioTracks()[0];
    if (!mic) {
      this.joining = false;
      stopStream(stream);
      this.hooks.onError('No microphone was found on this device.');
      this.leave();
      return;
    }
    const cam = video ? stream.getVideoTracks()[0] || null : null;
    const gen = this.generation;
    this.micTrack = mic;
    this.ownTracks.add(mic);
    if (cam) { this.camTrack = cam; this.ownTracks.add(cam); }
    try {
      const ice = await voiceIce();
      if (this.stale(gen)) return;
      const pc = new RTCPeerConnection({ iceServers: Array.isArray(ice.iceServers) ? ice.iceServers : [] });
      this.pc = pc;
      pc.addEventListener('track', (event) => this.onTrack(event));
      const tx = pc.addTransceiver(mic, { direction: 'sendonly' });
      this.micMid = tx.mid || '';
      if (cam) {
        const ctx = pc.addTransceiver(cam, { direction: 'sendonly' });
        this.camMid = ctx.mid || '';
        this.camTx = ctx;
      }
      const session = await voiceSession();
      if (this.stale(gen)) return;
      this.sessionId = session.sessionId;
      await this.enqueue(gen, async () => { await this.publishOffer(gen, this.localTracks()); });
      if (this.stale(gen)) return;
      this.active = true;
      this.joining = false;
      this.camOn = !!cam;
      this.frame({ type: 'voice.publish', sessionId: this.sessionId, tracks: this.localNames(), muted: false, cam: !!cam });
      this.patchSelf({ sessionId: this.sessionId, tracks: this.localNames(), muted: false, cam: !!cam });
      this.applyState(this.state);
    } catch (error) {
      this.joining = false;
      this.fail(error);
    }
  }

  toggleMute(): void {
    if (!this.active) return;
    if (!VoiceClient.webrtcSupported) {
      this.micMuted = !this.micMuted;
      void call('voice.native.mute', { muted: this.micMuted }).catch(() => undefined);
      this.patchSelf({ muted: this.micMuted });
      this.hooks.onState(this.state);
      return;
    }
    if (!this.micTrack) return;
    this.micMuted = !this.micMuted;
    this.micTrack.enabled = !this.micMuted;
    this.frame({ type: 'voice.update', muted: this.micMuted });
    this.patchSelf({ muted: this.micMuted });
    this.hooks.onState(this.state);
  }

  /** Add or remove a sendonly camera track. Renegotiations share the session queue. */
  async toggleCamera(): Promise<void> {
    if (!this.active || !this.pc || !this.sessionId || this.camBusy) return;
    if (this.camTrack) { await this.cameraOff(); return; }
    this.camBusy = true;
    let stream: MediaStream;
    try {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') throw new Error('unsupported');
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    } catch {
      this.camBusy = false;
      this.hooks.onError('Camera access was blocked. Allow camera access to use it.');
      return;
    }
    const cam = stream.getVideoTracks()[0];
    if (!cam || this.stopped) { stopStream(stream); this.camBusy = false; return; }
    const gen = this.generation;
    this.camTrack = cam;
    this.ownTracks.add(cam);
    const tx = this.pc.addTransceiver(cam, { direction: 'sendonly' });
    this.camTx = tx;
    this.camMid = tx.mid || '';
    try {
      await this.enqueue(gen, async () => { await this.publishOffer(gen, this.localTracks()); });
      if (this.stale(gen)) return;
      this.camOn = true;
      this.camBusy = false;
      this.frame({ type: 'voice.publish', sessionId: this.sessionId, tracks: this.localNames(), muted: this.micMuted, cam: true });
      this.patchSelf({ cam: true, tracks: this.localNames() });
      this.hooks.onState(this.state);
    } catch (error) {
      if (cam === this.camTrack) { this.ownTracks.delete(cam); cam.stop(); this.camTrack = null; this.camMid = ''; this.camTx = null; }
      this.camBusy = false;
      this.fail(error);
    }
  }

  /** Deafen only affects local playback of remote microphones. */
  setDeafened(on: boolean): void {
    this.deafened = on;
    if (!VoiceClient.webrtcSupported) {
      void call('voice.native.deafen', { deafened: on }).catch(() => undefined);
      return;
    }
    for (const [key, el] of this.elements) {
      if (!key.endsWith(KEY + 'mic')) continue;
      const username = key.slice(0, key.indexOf(KEY));
      (el as HTMLAudioElement).muted = on || this.mutedBy.get(username) === true;
    }
  }

  /** Leave the roster and release the peer connection, tracks, media elements and level meters. */
  leave(): void {
    if (this.stopped) return;
    const native = !VoiceClient.webrtcSupported;
    if (native) void call('voice.native.leave', { convId: this.convId }).catch(() => undefined);
    const mids = [this.micMid, this.camMid].filter(Boolean);
    const sid = this.sessionId;
    const wasSignaling = this.signaling;
    const pending = this.chain;
    this.stopped = true;
    this.generation++;
    this.active = false;
    this.joining = false;
    this.camBusy = false;
    this.chain = Promise.resolve();
    if (this.stopFeed) { this.stopFeed(); this.stopFeed = null; }
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    for (const meter of this.levels.values()) this.stopMeter(meter);
    this.levels.clear();
    for (const key of Array.from(this.elements.keys())) this.dropElement(key);
    for (const track of this.ownTracks) { try { track.stop(); } catch { /* already stopped */ } }
    this.ownTracks.clear();
    this.micTrack = null;
    this.camTrack = null;
    this.camTx = null;
    const pc = this.pc;
    this.pc = null;
    if (pc) { try { pc.close(); } catch { /* already closed */ } }
    this.subscribed.clear();
    this.midMap.clear();
    this.pendingMids = [];
    this.sessionId = '';
    this.state = { convId: this.convId, members: [] };
    if (wasSignaling && !native) this.frame({ type: 'voice.leave' });
    if (!native && sid && mids.length) {
      void pending.catch(() => undefined)
        .then(() => voiceCloseTracks(sid, { tracks: mids.map((mid) => ({ mid })) }))
        .catch(() => undefined);
    }
  }

  /** Update tiles/subscriptions from a roster push. */
  applyState(state: VoiceState): void {
    if (state.convId !== this.convId || this.stopped) return;
    this.state = state;
    const present = new Set<string>();
    for (const m of state.members) {
      const name = m.username.toLowerCase();
      present.add(name);
      this.mutedBy.set(name, m.muted);
      const audio = this.elements.get(keyOf(m.username, 'mic'));
      if (audio instanceof HTMLAudioElement) audio.muted = m.muted || this.deafened;
    }
    for (const key of Array.from(this.elements.keys())) {
      if (!present.has(key.slice(0, key.indexOf(KEY)))) this.dropElement(key);
    }
    if (this.sessionId) {
      for (const m of state.members) {
        if (m.username.toLowerCase() === this.me.toLowerCase() || !m.sessionId) continue;
        for (const track of m.tracks) {
          if (track !== 'mic' && track !== 'cam') continue;
          const key = m.sessionId + ':' + track;
          if (this.subscribed.has(key)) continue;
          this.subscribed.add(key);
          void this.subscribe(m, track, key);
        }
      }
    }
    this.hooks.onState(state);
  }

  /** Host-driven voice (no WebRTC in the web view): roster/speaking/errors arrive on the social event feed. */
  private onNativeState(event: FeedEvent): void {
    if (this.stopped || String(event.convId || '') !== this.convId) return;
    const status = String(event.status || '');
    if (status === 'roster' && Array.isArray(event.members)) {
      const members: VoiceMember[] = [];
      for (const raw of event.members) {
        const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
        const username = typeof o.username === 'string' ? o.username : '';
        if (!username) continue;
        members.push({
          username,
          sessionId: typeof o.sessionId === 'string' ? o.sessionId : '',
          tracks: Array.isArray(o.tracks) ? o.tracks.filter((t): t is string => typeof t === 'string') : [],
          muted: o.muted === true,
          cam: o.cam === true,
        });
      }
      this.applyState({ convId: this.convId, members });
    } else if (status === 'speaking') {
      const username = typeof event.username === 'string' ? event.username : '';
      if (username) this.hooks.onLevel(username, event.speaking === true);
    } else if (status === 'error') {
      this.hooks.onError(typeof event.message === 'string' ? event.message : 'Native voice failed.');
    }
  }

  // ---- internals ----

  private stale(gen: number): boolean {
    return this.stopped || gen !== this.generation || !this.pc;
  }

  /** All session mutations go through one chain; never overlap tracks/new and renegotiate. */
  private enqueue(gen: number, run: () => Promise<void>): Promise<void> {
    const task = this.chain.then(async () => { if (!this.stale(gen)) await run(); });
    this.chain = task.catch(() => undefined);
    return task;
  }

  /** Keep our own tile honest while the roster round-trips. */
  private patchSelf(patch: Partial<VoiceMember>): void {
    this.state = {
      ...this.state,
      members: this.state.members.map((m) => m.username.toLowerCase() === this.me.toLowerCase() ? { ...m, ...patch } : m),
    };
  }

  private localTracks(): VoiceTrackInfo[] {
    const out: VoiceTrackInfo[] = [];
    if (this.micMid) out.push({ location: 'local', mid: this.micMid, trackName: 'mic' });
    if (this.camMid) out.push({ location: 'local', mid: this.camMid, trackName: 'cam' });
    return out;
  }

  private localNames(): string[] {
    const out: string[] = [];
    if (this.micTrack) out.push('mic');
    if (this.camTrack) out.push('cam');
    return out;
  }

  /** tracks/new with our SDP offer; the SFU's answer becomes the remote description. */
  private async publishOffer(gen: number, tracks: VoiceTrackInfo[]): Promise<void> {
    const pc = this.pc;
    if (!pc || !this.sessionId) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIce(pc);
    if (this.stale(gen)) return;
    const reply = await voiceNewTracks(this.sessionId, {
      sessionDescription: { type: 'offer', sdp: pc.localDescription ? pc.localDescription.sdp : offer.sdp },
      tracks,
    });
    if (this.stale(gen)) return;
    await pc.setRemoteDescription(reply.sessionDescription);
  }

  /** tracks/new with a remote track ref; the SFU sends an offer we answer. */
  private async subscribe(member: VoiceMember, track: VoiceTrack, key: string): Promise<void> {
    const gen = this.generation;
    try {
      await this.enqueue(gen, async () => {
        const pc = this.pc;
        if (!pc || !this.sessionId) return;
        const reply = await voiceNewTracks(this.sessionId, { tracks: [{ location: 'remote', sessionId: member.sessionId, trackName: track }] });
        if (this.stale(gen)) return;
        for (const t of reply.tracks || []) {
          if (t.mid && t.trackName === track && t.sessionId === member.sessionId) {
            this.midMap.set(t.mid, { username: member.username, track });
          }
        }
        this.pendingMids.push({ username: member.username, track });
        await pc.setRemoteDescription(reply.sessionDescription);
        if (this.stale(gen)) return;
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await voiceRenegotiate(this.sessionId, {
          sessionDescription: { type: 'answer', sdp: pc.localDescription ? pc.localDescription.sdp : answer.sdp },
        });
      });
    } catch (error) {
      this.subscribed.delete(key);
      this.fail(error);
    }
  }

  private async cameraOff(): Promise<void> {
    const track = this.camTrack;
    const mid = this.camMid;
    const sid = this.sessionId;
    const gen = this.generation;
    this.camTrack = null;
    this.camMid = '';
    this.camOn = false;
    if (track) { this.ownTracks.delete(track); try { track.stop(); } catch { /* already stopped */ } }
    if (this.camTx) {
      try { this.pc?.removeTrack(this.camTx); this.camTx.stop(); } catch { /* already closed */ }
      this.camTx = null;
    }
    if (sid && mid) {
      try { await this.enqueue(gen, () => voiceCloseTracks(sid, { tracks: [{ mid }] })); }
      catch (error) { this.fail(error); }
    }
    if (this.stale(gen)) return;
    this.camBusy = false;
    this.frame({ type: 'voice.publish', sessionId: sid, tracks: this.localNames(), muted: this.micMuted, cam: false });
    this.patchSelf({ cam: false, tracks: this.localNames() });
    this.hooks.onState(this.state);
  }

  private onTrack(event: RTCTrackEvent): void {
    const mid = event.transceiver.mid || '';
    const target = this.midMap.get(mid) || this.pendingMids.shift();
    if (!target) return;
    const key = keyOf(target.username, target.track);
    let el = this.elements.get(key);
    if (!el) {
      el = target.track === 'cam' ? document.createElement('video') : document.createElement('audio');
      el.className = 'voice-media voice-media-' + target.track;
      el.autoplay = true;
      if (el instanceof HTMLVideoElement) el.playsInline = true;
      el.muted = target.track === 'cam' || this.deafened || this.mutedBy.get(target.username.toLowerCase()) === true;
      this.elements.set(key, el);
    }
    const stream = new MediaStream([event.track]);
    (el as HTMLMediaElement).srcObject = stream;
    void (el as HTMLMediaElement).play().catch(() => undefined);
    if (target.track === 'mic') this.watchLevel(target.username, event.track);
    this.hooks.onTrack(target.username, target.track);
  }

  private dropElement(key: string): void {
    const el = this.elements.get(key);
    this.elements.delete(key);
    const at = key.indexOf(KEY);
    const username = key.slice(0, at);
    const track = key.slice(at + 1) as VoiceTrack;
    this.stopLevel(username);
    if (!el) return;
    const stream = el.srcObject as MediaStream | null;
    if (stream) for (const t of stream.getTracks()) { try { t.stop(); } catch { /* already stopped */ } }
    el.srcObject = null;
    el.remove();
    this.hooks.onTrackLost(username, track);
  }

  private watchLevel(username: string, track: MediaStreamTrack): void {
    this.stopLevel(username);
    if (typeof AudioContext === 'undefined') return;
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);   // analyser only: never route a remote mic back to the speakers
      this.levels.set(username.toLowerCase(), { ctx, src, analyser, data: new Uint8Array(analyser.frequencyBinCount), speaking: false });
      if (!this.raf) this.raf = requestAnimationFrame(() => this.tickLevels());
    } catch { /* level meter is optional */ }
  }

  private stopLevel(username: string): void {
    const id = username.toLowerCase();
    const meter = this.levels.get(id);
    if (!meter) return;
    this.levels.delete(id);
    this.stopMeter(meter);
  }

  private stopMeter(meter: LevelMeter): void {
    // Teardown must be best-effort: a failed meter must not block leave().
    try { meter.src.disconnect(); meter.analyser.disconnect(); } catch { /* already disconnected */ }
    try {
      if (meter.ctx.state !== 'closed') void meter.ctx.close().catch(() => undefined);
    } catch { /* already closed */ }
  }

  private tickLevels(): void {
    this.raf = 0;
    if (this.stopped) return;
    for (const [username, meter] of this.levels) {
      meter.analyser.getByteTimeDomainData(meter.data);
      let sum = 0;
      for (const value of meter.data) { const d = (value - 128) / 128; sum += d * d; }
      const speaking = Math.sqrt(sum / meter.data.length) > 0.025;
      if (speaking !== meter.speaking) { meter.speaking = speaking; this.hooks.onLevel(username, speaking); }
    }
    this.raf = requestAnimationFrame(() => this.tickLevels());
  }

  private fail(error: unknown): void {
    const status = error instanceof SocialError ? error.status : 0;
    const message = status === 503 || status === 502 ? "Voice isn't set up yet" : describeError(error);
    this.hooks.onError(message);
    if (!this.active || status === 503 || status === 502) this.leave();
  }

  private frame(frame: Record<string, unknown>): void {
    sendFrame({ ...frame, convId: this.convId, channelId: this.convId });   // both names: old channel clients and new calls
  }
}

/** Signaling frames go out on the app's social socket. Flat + nested args suit either bridge shape. */
export function sendFrame(frame: Record<string, unknown>): void {
  void call('social.send', { ...frame, frame }).catch(() => undefined);
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) { try { track.stop(); } catch { /* already stopped */ } }
}

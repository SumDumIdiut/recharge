// Background state: playbackPlan matrix and Tauri window events driving applyPlayback.
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); } };
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {},
  createElement: () => { const a = { paused: true, volume: 1, style: {}, addEventListener() {}, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, load() {}, removeAttribute() {} };
    Object.defineProperty(a, 'src', { set() {}, get() { return ''; } }); return a; } };
const { playbackPlan, backgroundReason, watchWindow, setSound, saveAudioPrefs, getAudioPrefs, setGameRunning } = await import('../src/bgmedia.js');

const states = { focused: {}, unfocused: { unfocused: true }, minimised: { minimised: true }, hidden: { hidden: true }, invisible: { invisible: true }, game: { gameRunning: true } };
for (const [name, st] of Object.entries(states)) for (const keepPlaying of [false, true]) for (const sound of [null, 'own', 'a.ogg']) {
  test(`plan ${name} keep=${keepPlaying} sound=${sound}`, () => {
    const p = playbackPlan({ ...st, prefs: { enabled: true, volume: 0.5, keepPlaying }, sound, hasVideo: true });
    const bg = name !== 'focused';
    const audioOn = !!sound && (!bg || keepPlaying);
    assert.equal(p.background, bg);
    assert.equal(p.audio, audioOn && sound === 'a.ogg');
    assert.equal(p.videoMuted, !(sound === 'own' && audioOn));
    assert.equal(p.videoHidden, bg);
    assert.equal(p.video, !bg || (sound === 'own' && audioOn));
  });
}
test('speaker off: silent everywhere, video pauses in background', () => {
  const p = playbackPlan({ unfocused: true, prefs: { enabled: false, volume: 1, keepPlaying: true }, sound: 'a.ogg', hasVideo: true });
  assert.deepEqual([p.audio, p.video, p.videoMuted], [false, false, true]);
});
test('reason priority', () => {
  assert.equal(backgroundReason({ gameRunning: true, minimised: true }), 'game');
  assert.equal(backgroundReason({ minimised: true, unfocused: true }), 'minimised');
  assert.equal(backgroundReason({ unfocused: true }), 'unfocused');
  assert.equal(backgroundReason({}), null);
});
test('focus / minimise events call applyPlayback and move the audio', async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let focusCb, resizeCb; const st = { min: false, vis: true, foc: true };
  const win = { onFocusChanged: async (f) => { focusCb = f; }, onResized: async (f) => { resizeCb = f; }, onMoved: async () => {},
    isMinimized: async () => st.min, isVisible: async () => st.vis, isFocused: async () => st.foc };
  let el; const orig = globalThis.document.createElement;
  globalThis.document.createElement = () => (el = orig());
  saveAudioPrefs({ enabled: true, volume: 0.5, keepPlaying: false });
  setSound('s.ogg', 'http://x/');
  globalThis.document.createElement = orig;
  assert.equal(el.paused, false);
  const stop = watchWindow(win, { debounceMs: 10, pollMs: 0 });
  await wait(30);
  st.foc = false; focusCb({ payload: false }); await wait(40);
  assert.equal(el.paused, true, 'unfocus pauses when keepPlaying is off');
  st.foc = true; focusCb({ payload: true }); await wait(40);
  assert.equal(el.paused, false, 'refocus resumes');
  st.min = true; resizeCb(); await wait(40);
  assert.equal(el.paused, true, 'minimise pauses');
  saveAudioPrefs({ enabled: true, volume: 0.5, keepPlaying: true }); // toggle applies immediately
  assert.equal(el.paused, false, 'keepPlaying keeps it going while minimised');
  setGameRunning(true);
  assert.equal(el.paused, false, 'and while the game runs');
  saveAudioPrefs({ enabled: true, volume: 0.5, keepPlaying: false });
  assert.equal(el.paused, true);
  setGameRunning(false); st.min = false; resizeCb(); await wait(40);
  assert.equal(el.paused, false);
  stop();
});

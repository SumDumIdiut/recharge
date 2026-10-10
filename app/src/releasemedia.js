// Lets go of a <video>/<audio> without freezing the page.
// WebKitGTK tears the GStreamer pipeline down synchronously on the main thread, and while the element is still
// downloading (networkState LOADING) that teardown waits for the transfer: pause()/removeAttribute('src')/load()/remove()
// on a streaming 21 MB hub mp4 blocked the page for 2-35 s. So: pause + detach right away, and only drop the source
// (load() frees the decoder and its buffers) once the element is no longer loading. Preview media is fetched into a
// blob first, so it is never loading from the network at that point.
export const NETWORK_LOADING = 2;
const RETRY_MS = 500;
const MAX_TRIES = 240;

export function releaseMedia(el, { setTimer = (f, ms) => setTimeout(f, ms)?.unref?.() } = {}) {
  if (!el) return true;
  try { el.pause?.(); } catch (e) {}
  try { el.remove?.(); } catch (e) {}
  let tries = 0;
  const finish = () => {
    if (el.networkState === NETWORK_LOADING && tries++ < MAX_TRIES) { setTimer(finish, RETRY_MS); return; }
    if (el.networkState === NETWORK_LOADING) return; // never ends: leave it to the GC rather than block
    try { el.removeAttribute?.('src'); el.load?.(); } catch (e) {}
  };
  if (el.networkState === NETWORK_LOADING) { setTimer(finish, RETRY_MS); return false; }
  finish();
  return true; // false: the source is dropped later, so the caller must not reuse the element
}

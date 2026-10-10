// Cover picture of an MP4 / ISO-BMFF video, read from the file's boxes (no decoding, no dependencies).
//   1. moov/udta/meta/ilst/covr/data   (iTunes-style cover; JPEG or PNG)  - what yt-dlp / AtomicParsley write
//   2. a video track whose sample entry is mjpeg / jpeg / png with a single sample ("attached picture") - what ffmpeg writes
// Works on a "reader": { read(offset, length) -> Promise<Uint8Array> (shorter / empty past the end) }.
// Only the box headers and the moov box are read, so a 90 MB video costs a few small range requests.
// Also reports the video codec (stsd fourcc, e.g. 'av01', 'hvc1', 'avc1') so the UI can warn about codecs the engine can't play.

export const MAX_MOOV_BYTES = 48 * 1024 * 1024;
const PICTURE_ENTRIES = new Set(['mjpg', 'jpeg', 'png ', 'MJPG', 'JPEG']);

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

// [{ type, start (of payload), end }] for the boxes in buf[from, to).
export function childBoxes(buf, from = 0, to = buf.length) {
  const out = [];
  let o = from;
  while (o + 8 <= to) {
    let size = u32(buf, o);
    const type = fourcc(buf, o + 4);
    let head = 8;
    if (size === 1) { if (o + 16 > to) break; size = u64(buf, o + 8); head = 16; }
    else if (size === 0) size = to - o;
    if (size < head || o + size > to) break;
    out.push({ type, start: o + head, end: o + size });
    o += size;
  }
  return out;
}
const find = (buf, box, type) => childBoxes(buf, box.start, box.end).find((c) => c.type === type);
const findAll = (buf, box, type) => childBoxes(buf, box.start, box.end).filter((c) => c.type === type);
const dig = (buf, box, ...path) => path.reduce((b, t) => (b ? find(buf, b, t) : null), box);

export function imageMime(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

function covrPicture(moov, buf) {
  for (const meta of [dig(buf, moov, 'udta', 'meta'), find(buf, moov, 'meta')]) {
    if (!meta) continue;
    const ilst = childBoxes(buf, meta.start + 4, meta.end).find((c) => c.type === 'ilst'); // meta is a full box: 4 version/flag bytes first
    const covr = ilst && find(buf, ilst, 'covr');
    if (!covr) continue;
    for (const data of findAll(buf, covr, 'data')) {
      const bytes = buf.subarray(data.start + 8, data.end); // type/flags (4) + locale (4)
      const mime = imageMime(bytes);
      if (mime) return { bytes, mime };
    }
  }
  return null;
}

// { handler, entry, offset, size } of a track's first sample, enough to read a single-picture track.
function trackInfo(buf, trak) {
  const mdia = find(buf, trak, 'mdia');
  const hdlr = mdia && find(buf, mdia, 'hdlr');
  const stbl = mdia && dig(buf, mdia, 'minf', 'stbl');
  if (!hdlr || !stbl) return null;
  const handler = fourcc(buf, hdlr.start + 8);
  const stsd = find(buf, stbl, 'stsd');
  const entry = stsd && stsd.start + 16 <= stsd.end ? fourcc(buf, stsd.start + 12) : null; // version/flags 4, count 4, entry size 4, then the format
  const stsz = find(buf, stbl, 'stsz');
  const stco = find(buf, stbl, 'stco');
  const co64 = find(buf, stbl, 'co64');
  let count = 0, size = 0, offset = 0;
  if (stsz) {
    count = u32(buf, stsz.start + 8);
    size = u32(buf, stsz.start + 4) || (count ? u32(buf, stsz.start + 12) : 0);
  }
  if (stco && u32(buf, stco.start + 4) > 0) offset = u32(buf, stco.start + 8);
  else if (co64 && u32(buf, co64.start + 4) > 0) offset = u64(buf, co64.start + 8);
  return { handler, entry, offset, size, count };
}

// -> { videoCodec, tracks } from a moov payload (whole box bytes WITHOUT its 8 byte header)
export function parseMoov(buf) {
  const moov = { start: 0, end: buf.length };
  const cover = covrPicture(moov, buf);
  const tracks = findAll(buf, moov, 'trak').map((t) => trackInfo(buf, t)).filter(Boolean);
  const videoCodec = tracks.find((t) => t.handler === 'vide' && !PICTURE_ENTRIES.has(t.entry))?.entry || null;
  const pictureTrack = tracks.find((t) => t.handler === 'vide' && PICTURE_ENTRIES.has(t.entry) && t.count === 1 && t.size > 0 && t.size <= 16 * 1024 * 1024 && t.offset > 0) || null;
  return { cover, pictureTrack, videoCodec };
}

// -> { bytes, mime, videoCodec } (bytes/mime null without a cover)
export async function readMp4Cover(reader) {
  let offset = 0;
  for (let guard = 0; guard < 64; guard++) {
    const head = await reader.read(offset, 16);
    if (!head || head.length < 8) break;
    let size = u32(head, 0);
    const type = fourcc(head, 4);
    let hsz = 8;
    if (guard === 0 && type !== 'ftyp') break; // not an ISO media file
    if (size === 1) { if (head.length < 16) break; size = u64(head, 8); hsz = 16; }
    if (type === 'moov') {
      const len = size === 0 ? 0 : size - hsz;
      if (len <= 0 || len > MAX_MOOV_BYTES) break;
      const moov = await reader.read(offset + hsz, len);
      if (!moov || moov.length < len) break;
      const info = parseMoov(moov);
      if (info.cover) return { ...info.cover, videoCodec: info.videoCodec };
      if (info.pictureTrack) {
        const bytes = await reader.read(info.pictureTrack.offset, info.pictureTrack.size);
        const mime = imageMime(bytes);
        if (mime) return { bytes, mime, videoCodec: info.videoCodec };
      }
      return { bytes: null, mime: null, videoCodec: info.videoCodec };
    }
    if (size === 0 || size < hsz) break; // box runs to the end of the file (mdat) without a moov before it
    offset += size;
  }
  return { bytes: null, mime: null, videoCodec: null };
}

// Readers
export function blobReader(blob) {
  return { read: async (o, n) => new Uint8Array(await blob.slice(o, o + n).arrayBuffer()) };
}

// Range requests against a URL (the local media server and the hub both answer them). Any trouble with the Range fetch
// (a cross-origin preflight that doesn't allow the Range header -> fetch throws a TypeError; a non-206 error; a 206 whose
// body isn't the slice asked for) falls back to ONE whole-file fetch WITHOUT custom headers (a simple CORS request),
// capped at maxFull and abortable, then served from memory. A server that ignores Range and answers 200 is read once from
// that answer. Content-Range is never needed: cross-origin it is unreadable unless the server exposes it, so its absence
// is not an error. onFallback(reason) is called when a whole-file read starts (the UI shows a spinner); it is also logged.
export function urlReader(url, fetchFn = (...a) => fetch(...a), { maxFull = 60 * 1024 * 1024, signal, onFallback } = {}) {
  let whole = null;
  let wholeP = null;
  const readWhole = async (res) => {
    const len = Number(res.headers?.get?.('content-length')) || 0;
    if (len > maxFull) throw new Error('too large to read');
    if (res.body?.getReader) { // streamed, so a server that omits or lies about the length can't make us hold more than the cap
      const reader = res.body.getReader();
      const parts = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxFull) { try { await reader.cancel(); } catch (e) {} throw new Error('too large to read'); }
        parts.push(value);
      }
      whole = new Uint8Array(total);
      let at = 0;
      for (const p of parts) { whole.set(p, at); at += p.length; }
      return;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxFull) throw new Error('too large to read');
    whole = buf;
  };
  const wholeFrom = (reason, getRes) => {
    wholeP ||= (async () => {
      console.warn(`[cover] Range read of ${url} not usable (${reason}); reading the whole file`);
      try { onFallback?.(reason); } catch (e) {}
      const res = await getRes();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await readWhole(res);
    })();
    return wholeP;
  };
  return {
    read: async (o, n) => {
      if (whole) return whole.subarray(o, o + n);
      let reason;
      try {
        const res = await fetchFn(url, { headers: { Range: `bytes=${o}-${o + n - 1}` }, signal });
        if (res.status === 416) return new Uint8Array(0);
        if (res.status === 206) {
          const body = new Uint8Array(await res.arrayBuffer());
          if (body.length <= n) return body;
          reason = 'Range answer longer than asked';
        } else if (res.status === 200) {
          await wholeFrom('server ignored Range', async () => res);
          return whole.subarray(o, o + n);
        } else reason = `HTTP ${res.status}`;
      } catch (e) {
        if (signal?.aborted) throw e;
        if (whole) return whole.subarray(o, o + n);
        reason = `${e?.name || 'Error'}: ${e?.message || e}`;
      }
      await wholeFrom(reason, () => fetchFn(url, { signal })); // no custom headers: a simple request, no preflight
      return whole.subarray(o, o + n);
    },
  };
}

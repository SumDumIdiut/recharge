#!/usr/bin/env node
// publish-update.mjs - publish a Recharge build to the update hub. Plain Node, no deps.
//
// Usage:
//   node tools/publish-update.mjs --channel stable|beta --version 3.0.13 --build 123 --api-level 9 \
//     --platform windows-x64=<dir> --platform linux-x64=<dir> \
//     [--launch-windows recharge.exe] [--launch-linux recharge] \
//     [--components-map '{"extras":"content"}'] [--base https://codecade.co.za/recharge] \
//     [--key-env UPDATE_KEY] [--dry-run]
//   node tools/publish-update.mjs --launcher windows-x64=<file> --launcher linux-x64=<file> \
//     --launcher-version 1.0.0 [--base ...] [--key-env ...] [--dry-run]
//   (launcher and build options may be combined in one call)
//
// Each platform dir is walked; every file is sha256-hashed. Component is inferred from the
// top-level folder (src/ -> screens, loader/ -> loader, content/ -> content, electron/ ->
// electron, anything else incl. root files -> app); --components-map is a JSON object of
// path-prefix -> component overrides (longest prefix wins). The launch file and (for
// non-windows platforms) files with an exec bit get "exec": true. The server is asked which
// hashes it lacks, only those are uploaded (streamed), then the manifest is PUT.
//
// The key is read from the env var named by --key-env (default UPDATE_KEY); it must equal the
// UPDATE_KEY configured on the hub. Not needed for --dry-run.
//
// CI / ship.sh: after building the release dirs, call e.g.
//   UPDATE_KEY=... node tools/publish-update.mjs --channel beta --version "$VER" --build "$BUILD" \
//     --api-level "$API" --platform windows-x64=dist/win --platform linux-x64=dist/linux
//   (--channel stable for --promote; the same files are re-used by hash, so promoting uploads ~nothing)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const args = process.argv.slice(2);
const opt = { platform: [], launcher: [] };
const multi = new Set(['platform', 'launcher']);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) die(`unexpected argument ${a}`);
  const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (k === 'dryRun') { opt.dryRun = true; continue; }
  const v = args[++i];
  if (v === undefined) die(`missing value for ${a}`);
  if (multi.has(k)) opt[k].push(v); else opt[k] = v;
}
function die(m) { console.error('error: ' + m); process.exit(1); }

const base = (opt.base || 'https://codecade.co.za/recharge').replace(/\/+$/, '');
const keyEnv = opt.keyEnv || 'UPDATE_KEY';
const key = process.env[keyEnv];
if (!opt.dryRun && !key) die(`env ${keyEnv} not set`);
const doBuild = opt.platform.length > 0;
if (!doBuild && !opt.launcher.length) die('nothing to do: give --platform and/or --launcher');

function splitKV(s) { const i = s.indexOf('='); if (i < 1) die(`expected name=path, got ${s}`); return [s.slice(0, i), s.slice(i + 1)]; }
const KNOWN = ['windows-x64', 'linux-x64'];

function sha256File(p) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}
function* walk(dir, rel = '') {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) yield* walk(dir, r);
    else if (e.isFile()) yield r;
  }
}
const compMap = opt.componentsMap ? JSON.parse(opt.componentsMap) : {};
const TOP = { src: 'screens', loader: 'loader', content: 'content', electron: 'electron' };
function component(rel) {
  let best = null;
  for (const [p, c] of Object.entries(compMap)) {
    const pre = p.replace(/\/+$/, '');
    if ((rel === pre || rel.startsWith(pre + '/')) && (!best || pre.length > best[0].length)) best = [pre, c];
  }
  if (best) return best[1];
  const i = rel.indexOf('/');
  return i < 0 ? 'app' : (TOP[rel.slice(0, i)] || 'app');
}

function request(method, urlPath, { body, stream, size, onProgress } = {}) {
  const u = new URL(base + urlPath);
  const lib = u.protocol === 'https:' ? https : http;
  const headers = { Authorization: `Bearer ${key || ''}` };
  let payload = null;
  if (body !== undefined) { payload = Buffer.from(JSON.stringify(body)); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
  if (stream) { headers['Content-Type'] = 'application/octet-stream'; headers['Content-Length'] = size; }
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let j = null; try { j = JSON.parse(text); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
        else reject(new Error(`${method} ${urlPath} -> ${res.statusCode} ${(j && j.error) || text.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload);
    else if (stream) {
      let sent = 0;
      const rs = fs.createReadStream(stream);
      rs.on('data', (c) => { sent += c.length; onProgress && onProgress(sent); });
      rs.on('error', reject);
      rs.pipe(req);
    } else req.end();
  });
}

async function uploadMissing(entries) { // entries: Map sha -> {file,size,label}
  const hashes = [...entries.keys()];
  let missing = hashes;
  if (!opt.dryRun) missing = (await request('POST', '/update/files/missing', { body: { hashes } })).missing;
  const total = missing.reduce((n, h) => n + entries.get(h).size, 0);
  console.log(`${hashes.length} unique files, ${missing.length} to upload (${(total / 1048576).toFixed(1)} MB)`);
  if (opt.dryRun) { for (const h of missing) console.log(`  would upload ${entries.get(h).label} ${h.slice(0, 12)} ${entries.get(h).size}B`); return; }
  let n = 0;
  for (const h of missing) {
    const e = entries.get(h); n++;
    const tag = `[${n}/${missing.length}] ${e.label}`;
    await request('PUT', `/update/files/${h}`, {
      stream: e.file, size: e.size,
      onProgress: (s) => process.stdout.write(`\r${tag} ${(s / 1048576).toFixed(1)}/${(e.size / 1048576).toFixed(1)} MB   `),
    });
    process.stdout.write(`\r${tag} done${' '.repeat(30)}\n`);
  }
}

const store = new Map();
let manifest = null;
const launchers = {};

if (doBuild) {
  for (const k of ['channel', 'version', 'build', 'apiLevel']) if (opt[k] === undefined) die(`--${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} required`);
  if (!['stable', 'beta'].includes(opt.channel)) die('--channel must be stable or beta');
  manifest = { format: 1, channel: opt.channel, version: opt.version, build: Number(opt.build), apiLevel: Number(opt.apiLevel), published: new Date().toISOString(), platforms: {} };
  for (const spec of opt.platform) {
    const [name, dir] = splitKV(spec);
    if (!KNOWN.includes(name)) die(`unknown platform ${name}`);
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) die(`not a directory: ${dir}`);
    const launch = name === 'windows-x64' ? (opt.launchWindows || 'recharge.exe') : (opt.launchLinux || 'recharge');
    const files = [];
    for (const rel of walk(dir)) {
      const abs = path.join(dir, rel);
      const st = fs.statSync(abs);
      const sha = await sha256File(abs);
      const f = { path: rel, size: st.size, sha256: sha, component: component(rel) };
      if (rel === launch || (name !== 'windows-x64' && (st.mode & 0o111))) f.exec = true;
      files.push(f);
      if (!store.has(sha)) store.set(sha, { file: abs, size: st.size, label: `${name}/${rel}` });
    }
    if (!files.some((f) => f.path === launch)) die(`launch file ${launch} not found in ${dir}`);
    manifest.platforms[name] = { launch, files };
    console.log(`${name}: ${files.length} files`);
  }
}
if (opt.launcher.length) {
  if (!opt.launcherVersion) die('--launcher-version required');
  for (const spec of opt.launcher) {
    const [name, file] = splitKV(spec);
    if (!KNOWN.includes(name)) die(`unknown platform ${name}`);
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st?.isFile()) die(`not a file: ${file}`);
    const sha = await sha256File(file);
    launchers[name] = { version: opt.launcherVersion, sha256: sha, size: st.size };
    if (!store.has(sha)) store.set(sha, { file, size: st.size, label: `launcher/${name}` });
  }
}

try {
  await uploadMissing(store);
  if (opt.dryRun) {
    if (manifest) console.log(JSON.stringify(manifest, null, 2));
    if (Object.keys(launchers).length) console.log(JSON.stringify(launchers, null, 2));
    console.log('(dry run: nothing sent)');
  } else {
    for (const [name, l] of Object.entries(launchers)) {
      await request('PUT', `/update/launcher/${name}`, { body: l });
      console.log(`launcher ${name} ${l.version} published`);
    }
    if (manifest) {
      await request('PUT', `/update/${manifest.channel}/manifest.json`, { body: manifest });
      console.log(`manifest ${manifest.channel} ${manifest.version} (build ${manifest.build}) published`);
    }
  }
} catch (e) { die(e.message); }

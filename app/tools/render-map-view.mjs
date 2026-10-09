#!/usr/bin/env node
// Renders a map's view picture headlessly (the same code the app uses: src/maps/mapview.js -> the editor's tile worker) in headless Firefox.
//   node tools/render-map-view.mjs <map.json | map.zip> <out.png> [width height]
// A .zip is a Hub/exported map (its map.json is read with `unzip -p`). Needs Firefox (FIREFOX env overrides the binary).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const [inFile, outFile, W = '960', H = '540'] = process.argv.slice(2);
if (!inFile || !outFile) { console.error('usage: render-map-view.mjs <map.json|map.zip> <out.png> [width height]'); process.exit(2); }

const mapText = inFile.endsWith('.zip') ? execFileSync('unzip', ['-p', inFile, 'map.json'], { maxBuffer: 1 << 30 }).toString() : fs.readFileSync(inFile, 'utf8');
const types = { '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.html': 'text/html', '.css': 'text/css' };
const page = `<!doctype html><meta charset="utf-8"><script type="module">
import { renderMapView } from '/maps/mapview.js';
try {
  const map = await (await fetch('/__map')).json();
  const blob = await renderMapView(map, ${+W}, ${+H});
  if (!blob) throw new Error('no editor data in this map');
  await fetch('/__out', { method: 'POST', body: blob });
} catch (e) { await fetch('/__fail', { method: 'POST', body: String(e && e.stack || e) }); }
</script>`;

let finish;
const result = new Promise((r) => { finish = r; });
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') { res.setHeader('content-type', 'text/html'); return res.end(page); }
  if (url === '/__map') { res.setHeader('content-type', 'application/json'); return res.end(mapText); }
  if (url === '/__out' || url === '/__fail') {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => { res.end('ok'); finish(url === '/__out' ? { png: Buffer.concat(parts) } : { error: Buffer.concat(parts).toString() }); });
    return;
  }
  const file = path.join(src, path.normalize(url));
  if (!file.startsWith(src) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('no'); }
  res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mapview-ff-'));
const ff = spawn(process.env.FIREFOX || 'firefox', ['--headless', '--no-remote', '--profile', profile, `http://127.0.0.1:${server.address().port}/`], { stdio: 'ignore' });
const timer = setTimeout(() => finish({ error: 'timed out after 180s' }), 180000);
const r = await result;
clearTimeout(timer);
ff.kill();
server.close();
fs.rmSync(profile, { recursive: true, force: true });
if (r.error) { console.error('render failed:', r.error); process.exit(1); }
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, r.png);
console.log('wrote', outFile, r.png.length, 'bytes');
process.exit(0);

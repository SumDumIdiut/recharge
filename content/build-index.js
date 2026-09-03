// Regenerates index.json by scanning mods/*/mod.json and maps/*/map.json.
// Run this after adding/editing/removing any mod or map folder.
const fs = require('fs');
const path = require('path');

function scan(kind) {
  const dir = path.join(__dirname, kind);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const manifestName = kind === 'mods' ? 'mod.json' : 'map.json';
      const manifestPath = path.join(dir, e.name, manifestName);
      if (!fs.existsSync(manifestPath)) return null;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return { ...manifest, path: `${kind}/${e.name}` };
    })
    .filter(Boolean);
}

const index = { mods: scan('mods'), maps: scan('maps') };
fs.writeFileSync(path.join(__dirname, 'index.json'), JSON.stringify(index, null, 2));
console.log(`Indexed ${index.mods.length} mod(s), ${index.maps.length} map(s).`);

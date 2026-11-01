#!/usr/bin/env node
// Build src/Recharge.App/ui/ from src/Recharge.App/ui-src/.
// TypeScript is stripped with Node's built-in type stripping (no packages), and
// every other file is copied as-is. Outputs with no remaining source are deleted.
import { stripTypeScriptTypes } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const srcRoot = path.join(root, 'src', 'Recharge.App', 'ui-src');
const outRoot = path.join(root, 'src', 'Recharge.App', 'ui');

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function outputName(relative) {
  return relative.endsWith('.ts') ? relative.slice(0, -3) + '.js' : relative;
}

async function main() {
  try {
    await fs.access(srcRoot);
  } catch {
    console.error('build-ui: missing ' + srcRoot);
    process.exit(1);
  }

  const sources = await walk(srcRoot);
  const expected = new Set();
  let compiled = 0;
  let copied = 0;

  await fs.mkdir(outRoot, { recursive: true });

  for (const source of sources) {
    const relative = path.relative(srcRoot, source);
    if (relative.split(path.sep).includes('..')) {
      throw new Error('build-ui: source escaped its root: ' + source);
    }

    const target = path.join(outRoot, outputName(relative));
    expected.add(target);
    await fs.mkdir(path.dirname(target), { recursive: true });

    if (relative.endsWith('.ts')) {
      const sourceText = await fs.readFile(source, 'utf8');
      let stripped;
      try {
        stripped = stripTypeScriptTypes(sourceText, { mode: 'strip' });
      } catch (error) {
        console.error('build-ui: ' + relative + ': ' + error.message);
        process.exit(1);
      }
      await fs.writeFile(target, stripped, 'utf8');
      compiled += 1;
    } else {
      await fs.copyFile(source, target);
      copied += 1;
    }
  }

  // Remove outputs whose source is gone (old placeholder CSS, stale pages, ...).
  let removed = 0;
  async function prune(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await prune(full);
        const left = await fs.readdir(full);
        if (left.length === 0) {
          await fs.rmdir(full);
        }
      } else if (entry.isFile() && !expected.has(full)) {
        await fs.rm(full);
        removed += 1;
      }
    }
  }
  await prune(outRoot);

  console.log(
    'ui: ' + (compiled + copied) + ' files (' + compiled + ' compiled, ' + copied +
    ' copied, ' + removed + ' stale removed)'
  );
}

await main();

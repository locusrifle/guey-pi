// Drop other-OS optional binaries and Pi docs/examples from node_modules.
// Guey is Linux-only; esbuild's optional packages install every platform by default.
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2] || join(import.meta.dirname, '..');
const keepEsbuild = new Set(['linux-x64', 'linux-arm64']);
const arch = process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';

async function walk(dir) {
  let entries;
  try { entries = await readdir(dir); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const name of entries) {
    const path = join(dir, name);
    let st;
    try { st = await stat(path); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (!st.isDirectory()) continue;
    if (name === '@esbuild') {
      for (const platform of await readdir(path)) {
        if (platform === arch || keepEsbuild.has(platform)) continue;
        await rm(join(path, platform), { recursive: true, force: true });
      }
      continue;
    }
    if (name === '@earendil-works') {
      for (const pkg of ['pi-coding-agent']) {
        for (const extra of ['docs', 'examples']) {
          await rm(join(path, pkg, extra), { recursive: true, force: true });
        }
      }
    }
    if (name === 'node_modules' || name.startsWith('@')) await walk(path);
    else {
      const nested = join(path, 'node_modules');
      await walk(nested);
    }
  }
}

await walk(join(root, 'node_modules'));

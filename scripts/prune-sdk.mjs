// Drop other-OS optional binaries, type packages, and Pi docs/examples.
// Guey is Linux-only; the archive is for this architecture.
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2] || join(import.meta.dirname, '..');
const esbuildKeep = process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
const clipboardKeep = process.arch === 'arm64' ? 'clipboard-linux-arm64-gnu' : 'clipboard-linux-x64-gnu';

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
    if (name === '@types') {
      await rm(path, { recursive: true, force: true });
      continue;
    }
    if (name === '@esbuild') {
      for (const platform of await readdir(path)) {
        if (platform === esbuildKeep) continue;
        await rm(join(path, platform), { recursive: true, force: true });
      }
      continue;
    }
    if (name === '@mariozechner') {
      for (const pkg of await readdir(path)) {
        if (pkg === 'clipboard' || pkg === clipboardKeep) continue;
        if (pkg.startsWith('clipboard-')) await rm(join(path, pkg), { recursive: true, force: true });
      }
    }
    if (name === '@earendil-works') {
      for (const extra of ['docs', 'examples']) {
        await rm(join(path, 'pi-coding-agent', extra), { recursive: true, force: true });
      }
    }
    if (name === 'node_modules' || name.startsWith('@')) await walk(path);
    else await walk(join(path, 'node_modules'));
  }
}

await walk(join(root, 'node_modules'));

// Load the Pi Node SDK. The `pi` CLI may be a compiled binary without dist/;
// Guey needs the importable package (npm), same version as that CLI.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TARGET = '0.85.';

function readSdk(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@earendil-works/pi-coding-agent') throw new Error(`Not a Pi SDK package: ${root}`);
  return pkg;
}

function importable(root) {
  return existsSync(join(root, 'dist/index.js'));
}

function fromEnv() {
  const dir = process.env.GUEY_PI_SDK;
  if (!dir) return null;
  if (!dir.startsWith('/')) throw new Error('GUEY_PI_SDK must be an absolute directory');
  return resolve(dir);
}

function fromNodeModules() {
  try {
    const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const root = dirname(dirname(entry)); // dist/index.js → package root
    return importable(root) ? root : null;
  } catch {
    return null;
  }
}

function fromCli() {
  const explicit = process.env.GUEY_PI_BIN;
  const found = explicit || spawnSync('/bin/sh', ['-c', 'command -v pi'], { encoding: 'utf8' }).stdout.trim();
  if (!found) return null;
  let real;
  try { real = realpathSync(found); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const dir = dirname(real);
  for (const candidate of [dir, dirname(dir), join(dir, '..', '@earendil-works', 'pi-coding-agent')]) {
    if (!importable(candidate)) continue;
    try { readSdk(candidate); return candidate; }
    catch { /* keep looking */ }
  }
  return null;
}

export function findPiRoot() {
  const root = fromEnv() || fromNodeModules() || fromCli();
  if (!root || !importable(root)) {
    throw new Error('Guey needs the Pi Node SDK (@earendil-works/pi-coding-agent 0.85.x). A compiled `pi` binary is not importable; run npm ci in this repo or set GUEY_PI_SDK to the npm package directory.');
  }
  const pkg = readSdk(root);
  if (!String(pkg.version).startsWith(TARGET)) {
    throw new Error(`Guey 0.2.0 targets Pi 0.85.x (found ${pkg.version} at ${root})`);
  }
  return root;
}

export const PI_ROOT = findPiRoot();
export const PI_VERSION = readSdk(PI_ROOT).version;
export const PI_THEME_DIR = join(PI_ROOT, 'dist/modes/interactive/theme');

const sdk = await import(pathToFileURL(join(PI_ROOT, 'dist/index.js')).href);
export const {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  getAgentDir,
  CredentialSynchronizationError,
  SettingsManager,
  ModelRuntime,
} = sdk;

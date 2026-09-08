import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findPiRoot, PI_ROOT, PI_VERSION, SessionManager } from '../pi-sdk.mjs';

test('uses the installed Pi CLI, not a vendored copy', async () => {
  const root = findPiRoot();
  assert.equal(root, PI_ROOT);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@earendil-works/pi-coding-agent');
  assert.match(PI_VERSION, /^0\.85\./);
  assert.equal(typeof SessionManager.create, 'function');
  assert.ok(existsSync(join(root, 'dist/index.js')));
});

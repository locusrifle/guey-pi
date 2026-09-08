import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readlink, writeFile, rm, stat, access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const bundleName = `guey-${version}-linux-${process.arch}`;

function client(url) {
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/pi');
  let id = 0;
  const pending = new Map();
  ws.on('message', raw => { const msg = JSON.parse(raw); if (msg.type === 'response') pending.get(msg.id)?.(msg); });
  return { ws, async send(type, fields = {}) {
    const key = String(++id);
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Timeout: ${type}`)); }, 10000);
      pending.set(key, value => { clearTimeout(timer); pending.delete(key); resolve(value); });
    });
    ws.send(JSON.stringify({ id: key, type, ...fields })); return result;
  } };
}

test('extracted desktop artifact: isolated SDK, lifecycle, failure paths and user install/uninstall', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guey-desktop-test-'));
  const home = join(dir, 'home'), state = join(home, '.local/state/guey-desktop');
  const bundle = join(dir, bundleName);
  const env = { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: join(home, 'app data'), XDG_STATE_HOME: join(home, '.local/state'), GUEY_NO_BROWSER: '1', GUEY_ISOLATE: '1', PI_OFFLINE: '1',
    // Deliberately hostile inherited service/TUI options must not affect desktop.
    LOCUS_SITE_HOST: '0.0.0.0', LOCUS_SITE_PORT: '5057', GUEY_ORIGINS: 'https://evil.example', PI_CODING_AGENT_DIR: join(home, '.pi/agent'), PI_CODING_AGENT_SESSION_DIR: join(home, '.pi/sessions') };
  let launcher = join(bundle, 'desktop/guey');
  const run = (...args) => exec(launcher, args, { env, cwd: dir, timeout: 45000 });
  let ws;
  try {
    await mkdir(home, { recursive: true });
    await exec('tar', ['-xzf', join(root, 'dist', bundleName + '.tar.gz'), '-C', dir]);
    await exec('sha256sum', ['-c', 'SHA256SUMS'], { cwd: bundle, maxBuffer: 8 * 1024 * 1024 });
    for (const omitted of ['skills', 'extensions', 'records', '.git', 'native/test', 'node_modules/playwright']) await assert.rejects(access(join(bundle, omitted)));
    assert.equal(JSON.parse(await readFile(join(bundle, 'package.json'), 'utf8')).pi, undefined);
    await access(join(bundle, 'LICENSE'));
    const nativeMjs = async name => (await readdir(join(name, 'native'))).filter(n => n.endsWith('.mjs')).sort();
    assert.deepEqual(await nativeMjs(bundle), await nativeMjs(root));
    for (const extra of ['THIRD_PARTY_NOTICES.md', 'licenses']) {
      await access(join(bundle, extra));
    }
    await mkdir(join(home, '.pi/agent/extensions'), { recursive: true });
    await writeFile(join(home, 'AGENTS.md'), 'PERSONAL INSTRUCTIONS MUST NOT LOAD');
    await writeFile(join(home, '.pi/agent/extensions/bomb.ts'), 'throw new Error("PERSONAL EXTENSION LOADED");');
    await writeFile(join(home, '.pi/agent/auth.json'), '{ invalid personal credentials');
    const personalBefore = await readFile(join(home, '.pi/agent/auth.json'));
    const help = await run('--help');
    assert.match(help.stdout, /loopback/);
    assert.match(help.stdout, /XDG_STATE_HOME\/guey-desktop/);
    assert.doesNotMatch(help.stdout, /binds the tailnet/);
    await assert.rejects(run('nonsense'), /Unknown command/);
    await assert.rejects(run('start', join(dir, 'missing')), /ENOENT/);
    await assert.rejects(exec(join(bundle, 'desktop/install.sh'), [], { env: { ...env, XDG_DATA_HOME: join(home, 'bad%path') } }), /Unsupported characters/);
    // SDK writes a persisted fixture, so resume/new/restart can be proved without
    // spending credentials or serializing Pi JSONL ourselves.
    const sessionDir = join(state, 'agent/sessions'), cwd = join(state, 'workspace');
    await mkdir(cwd, { recursive: true });
    const fixture = SessionManager.create(cwd, sessionDir);
    fixture.appendMessage({ role: 'user', content: 'packaged fixture', timestamp: Date.now() });
    fixture.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'persisted packaged answer' }], timestamp: Date.now(), stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    await writeFile(join(state, 'owner.pid'), String(process.pid));
    await assert.rejects(run('start'), /Startup failed/);
    assert.equal(await readFile(join(state, 'owner.pid'), 'utf8'), String(process.pid), 'failed startup leaves the other owner intact');
    await rm(join(state, 'owner.pid'));
    await assert.rejects(exec(launcher, ['start'], { env: { ...env, GUEY_DESKTOP_HOST: '0.0.0.0' }, cwd: dir, timeout: 45000 }), /Startup failed/);
    assert.match(await readFile(join(state, 'desktop.log'), 'utf8'), /loopback or tailnet IP/);
    // A stale endpoint must never cause a signal to an unrelated reused PID.
    await writeFile(join(state, 'desktop.json'), JSON.stringify({ pid: process.pid, birth: 'stale', url: 'http://127.0.0.1:1' }));
    await run('stop');
    const starts = await Promise.all([run('start'), run('start')]);
    const first = starts[0].stdout.trim();
    assert.equal(starts[1].stdout.trim(), first, 'concurrent launch is serialized');
    assert.match(first, /^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await (await fetch(first + '/health')).json();
    assert.equal(health.runtime, 'pi-sdk'); assert.ok(health.sessionFile.startsWith(sessionDir + '/'));
    assert.equal((await run('start')).stdout.trim(), first, 'second launch reuses one runtime');
    const bin = join(dir, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'chromium'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    await writeFile(join(bin, 'xdg-open'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const noBrowser = await exec(launcher, ['start'], { env: { ...env, PATH: `${bin}:${env.PATH}`, GUEY_NO_BROWSER: '0' } });
    assert.match(noBrowser.stderr, /Could not open Guey window/);
    assert.equal(noBrowser.stdout.trim(), first, 'browser failure leaves a usable URL and running agent');
    await assert.rejects(run('start', home), /another workspace/);
    assert.equal((await fetch(first, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(first + '/%2e%2e%2fpackage.json')).status, 404);
    assert.equal((await fetch(first + '/fonts/CommitMono-400-Regular.otf')).status, 200);
    const c = client(first); ws = c.ws; await once(ws, 'open');
    let snap = (await c.send('snapshot')).data;
    assert.deepEqual(snap.resources.extensions, []); assert.deepEqual(snap.resources.skills, []);
    assert.ok(snap.resources.tools.includes('bash'));
    assert.deepEqual((await c.send('live')).data, []);
    assert.equal((await c.send('attach', { pid: process.pid })).success, false);
    const models = await c.send('models');
    assert.equal(models.success, false, 'GUEY_ISOLATE does not isolate ModelRuntime auth; invalid ~/.pi/agent/auth.json is still read');
    assert.match(models.error, /JSON/);
    assert.equal(snap.auth?.configured, false);
    assert.equal((await c.send('prompt', { text: '' })).success, false);
    assert.equal((await c.send('prompt', { text: 'hello without credentials' })).success, false);
    assert.equal((await c.send('model', { provider: 'missing', modelId: 'missing' })).success, false);
    assert.equal((await c.send('resume', { path: '/etc/passwd' })).success, false);
    const listed = (await c.send('sessions')).data;
    assert.ok(listed.some(s => s.path === fixture.getSessionFile()));
    assert.ok(listed.every(s => s.path.startsWith(sessionDir + '/')));
    assert.equal((await c.send('resume', { path: fixture.getSessionFile() })).success, true);
    snap = (await c.send('snapshot')).data;
    assert.ok(snap.messages.some(m => m.content?.[0]?.text === 'persisted packaged answer'));
    assert.equal((await c.send('name', { name: 'desktop persistence' })).success, true);
    await t.test('headless Chromium renders the packaged app against the real isolated SDK', async bt => {
      const executablePath = existsSync(chromium.executablePath()) ? undefined : ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
      if (!executablePath && !existsSync(chromium.executablePath())) return bt.skip('No Chromium available');
      const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
      try {
        const page = await browser.newPage();
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(first);
        assert.equal(await page.title(), 'Guey');
        await page.waitForSelector('#guey-auth[open]');
        await page.getByRole('button', { name: 'Use a subscription / sign in', exact: true }).click();
        await page.getByRole('button', { name: /OpenAI Codex/ }).waitFor();
        await page.getByRole('button', { name: /Anthropic/ }).waitFor();
        await mkdir(join(root, 'records/desktop'), { recursive: true });
        await page.screenshot({ path: join(root, 'records/desktop/onboarding.png') });
        await page.getByRole('button', { name: 'Not now', exact: true }).click();
        await page.waitForSelector('.entry-line.assistant:has-text("persisted packaged answer")');
        const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
        assert.match(family, /monospace/i, 'stock Guey applies a monospace body font from shipped CSS, not a Commit Mono body override');
        assert.ok(await page.locator('#entry-input').isVisible());
        assert.ok(await page.locator('#entry-session-name').count());
        await mkdir(join(root, 'records/desktop'), { recursive: true });
        await page.screenshot({ path: join(root, 'records/desktop/packaged.png') });
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    });
    ws.close(); ws = null;
    assert.equal((await (await fetch(first + '/health')).json()).pid, health.pid, 'browser detach leaves agent alive');
    await run('stop');
    const second = (await run('start')).stdout.trim();
    assert.equal((await (await fetch(second + '/health')).json()).sessionFile, fixture.getSessionFile());
    const d = client(second); ws = d.ws; await once(ws, 'open');
    assert.equal((await d.send('new')).success, true);
    assert.ok((await d.send('snapshot')).data.sessionFile.startsWith(sessionDir + '/'), 'new sessions stay isolated');
    ws.close(); ws = null;
    await run('stop');
    assert.deepEqual(await readFile(join(home, '.pi/agent/auth.json')), personalBefore);
    assert.equal((await stat(join(state, 'desktop.log'))).mode & 0o077, 0);
    await mkdir(join(home, '.local/bin'), { recursive: true });
    await writeFile(join(home, '.local/bin/guey'), 'unrelated launcher');
    await assert.rejects(exec(join(bundle, 'desktop/install.sh'), [], { env }), /Launcher already exists/);
    assert.equal(await readFile(join(home, '.local/bin/guey'), 'utf8'), 'unrelated launcher');
    await rm(join(home, '.local/bin/guey'));
    await exec(join(bundle, 'desktop/install.sh'), [], { env });
    const installed = join(env.XDG_DATA_HOME, 'guey-desktop');
    launcher = join(installed, 'desktop/guey');
    assert.equal(await readlink(join(home, '.local/bin/guey')), launcher);
    const entry = await readFile(join(env.XDG_DATA_HOME, 'applications/guey.desktop'), 'utf8');
    assert.ok(entry.includes(`Exec="${launcher}" start`));
    try { await exec('desktop-file-validate', [join(env.XDG_DATA_HOME, 'applications/guey.desktop')]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; t.diagnostic('desktop-file-validate unavailable'); }
    await assert.rejects(exec(join(bundle, 'desktop/install.sh'), [], { env }), /Already installed/);
    // Remove extraction: installed app cannot depend on the source/archive path.
    await rm(bundle, { recursive: true });
    await exec(join(home, '.local/bin/guey'), ['start'], { env });
    await assert.rejects(exec(join(installed, 'desktop/install.sh'), ['uninstall'], { env }), /Stop Guey/);
    await run('stop');
    await exec(join(installed, 'desktop/install.sh'), ['uninstall'], { env });
    await assert.rejects(access(installed));
    await assert.rejects(readlink(join(home, '.local/bin/guey')));
    await assert.rejects(access(join(env.XDG_DATA_HOME, 'applications/guey.desktop')));
    await access(fixture.getSessionFile());
    t.diagnostic('Packaged SDK ran without model credentials; no model request or graphical application-menu/xdg-open launch was exercised.');
  } finally {
    ws?.terminate();
    await run('stop').catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

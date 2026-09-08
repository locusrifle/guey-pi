import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { SessionManager } from '../pi-sdk.mjs';
import { createGueyServer } from '../../server.mjs';
import { createRuntime } from '../runtime.mjs';
import { resolveProduct } from '../product.mjs';

function stubRuntime(cwd) {
  return {
    events: new EventEmitter(),
    snapshot: () => ({
      sessionId: 'x', sessionFile: join(cwd, 's.jsonl'), cwd, busy: false, failed: null,
      messages: [], commands: [], ui: { dialogs: [], widgets: {}, statuses: {}, notifications: [], editor: null },
    }),
    async command() { return {}; },
    async close() {},
  };
}

test('product resolution: explicit stock vs live locusrifle default', () => {
  assert.equal(resolveProduct({ product: 'stock' }), 'stock');
  assert.equal(resolveProduct({ product: 'locusrifle' }), 'locusrifle');
});

test('stock shell has no upload control; locusrifle index keeps it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-product-html-'));
  const runtime = stubRuntime(root);
  const stock = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'stock'), runtime, product: 'stock' });
  const personal = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'personal'), runtime, product: 'locusrifle' });
  try {
    const sAddr = await stock.listen();
    const pAddr = await personal.listen();
    const sBase = `http://127.0.0.1:${sAddr.port}`;
    const pBase = `http://127.0.0.1:${pAddr.port}`;
    const sHealth = await (await fetch(sBase + '/health')).json();
    const pHealth = await (await fetch(pBase + '/health')).json();
    assert.equal(sHealth.product, 'stock');
    assert.equal(pHealth.product, 'locusrifle');
    const sHtml = await (await fetch(sBase + '/')).text();
    const pHtml = await (await fetch(pBase + '/')).text();
    assert.match(sHtml, /guey-stock/);
    assert.match(sHtml, /stock\.js/);
    assert.doesNotMatch(sHtml, /entry-files/);
    assert.doesNotMatch(sHtml, /site\.js/);
    assert.doesNotMatch(sHtml, /grid-keys/);
    assert.match(pHtml, /entry-files/);
    assert.match(pHtml, /site\.js/);
    assert.equal((await fetch(sBase + '/transcribe', { method: 'POST', body: Buffer.alloc(0) })).status, 404);
    assert.equal((await fetch(sBase + '/push/vapid')).status, 404);
    assert.equal((await fetch(pBase + '/push/vapid')).status, 200);
  } finally {
    await stock.close(); await personal.close(); await rm(root, { recursive: true, force: true });
  }
});

test('ownArchive does not auto-resume the shared Pi session tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-own-archive-'));
  const agent = join(root, 'agent');
  const cwd = join(root, 'work');
  const stateDir = join(root, 'store');
  const sessionDir = join(stateDir, 'sessions');
  await mkdir(cwd, { recursive: true });
  const foreign = SessionManager.create(cwd, join(agent, 'sessions'));
  foreign.appendMessage({ role: 'user', content: 'locusrifle transcript', timestamp: Date.now() });
  foreign.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'saved answer' }], timestamp: Date.now(), stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const runtime = await createRuntime({
    cwd, agentDir: agent, stateDir, sessionDir, liveSessions: false, ownArchive: true,
  });
  try {
    const snap = runtime.snapshot();
    assert.ok(snap.sessionFile.startsWith(sessionDir + '/'), snap.sessionFile);
    assert.notEqual(snap.sessionFile, foreign.getSessionFile());
    const listed = await runtime.command({ type: 'sessions' });
    const shared = listed.find(s => s.path === foreign.getSessionFile());
    assert.ok(shared, 'shared Pi sessions stay visible in /resume');
    assert.equal(shared.copyOnResume, true);
    await runtime.command({ type: 'resume', path: foreign.getSessionFile() });
    const after = runtime.snapshot();
    assert.ok(after.sessionFile.startsWith(sessionDir + '/'), after.sessionFile);
    assert.notEqual(after.sessionFile, foreign.getSessionFile());
    assert.ok(after.messages.some(m => m.content === 'locusrifle transcript' || m.content?.[0]?.text === 'locusrifle transcript' || m.content?.[0]?.text === 'saved answer'));
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a snapshot larger than 8MB does not close the websocket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-big-snap-'));
  const blob = 'x'.repeat(60000);
  const data = {
    sessionId: 'big', sessionFile: join(root, 's.jsonl'), cwd: root, busy: true, failed: null,
    messages: Array.from({ length: 180 }, (_, i) => ({ role: 'assistant', content: blob + i })),
    commands: [], ui: { dialogs: [], widgets: {}, statuses: {}, notifications: [], editor: null },
  };
  const events = new EventEmitter();
  const runtime = {
    events,
    snapshot: () => data,
    async command() { return {}; },
    async close() {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime, product: 'stock' });
  try {
    const addr = await app.listen();
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/pi`, { origin: `http://127.0.0.1:${addr.port}` });
    const closed = [];
    ws.on('close', (code, reason) => closed.push({ code, reason: String(reason) }));
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no snapshot')), 15000);
      ws.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.type === 'snapshot') { clearTimeout(t); resolve(); }
      });
      ws.on('error', reject);
    });
    assert.ok(JSON.stringify(data).length > 8 * 1024 * 1024);
    events.emit('change');
    events.emit('change');
    await new Promise(r => setTimeout(r, 400));
    assert.equal(ws.readyState, WebSocket.OPEN);
    assert.equal(closed.length, 0, `socket closed ${JSON.stringify(closed)}`);
    ws.close();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

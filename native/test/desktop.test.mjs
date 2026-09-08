import { test } from 'node:test';
import { get } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once, EventEmitter } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { WebSocket } from 'ws';
import { createGueyServer } from '../../server.mjs';
import { WayVncManager, freeLoopbackPort } from '../wayvnc.mjs';

function stubRuntime() {
  const events = new EventEmitter();
  return { events, snapshot: () => ({ sessionId: 't', messages: [] }), async command() { throw new Error('Unsupported command'); }, async close() {} };
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 42;
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0, null)); };
  return child;
}

function fakeWayVnc({ port, owned = true, fail = false } = {}) {
  let starts = 0, stops = 0;
  let state = { running: false, ready: false, owned: false, host: '127.0.0.1', port: port ?? null, pid: null, error: null };
  return {
    starts: () => starts,
    stops: () => stops,
    async start() {
      starts += 1;
      if (fail) {
        state = { ...state, running: false, ready: false, owned: false, error: 'no wayvnc' };
        return { ...state };
      }
      state = { running: true, ready: true, owned, host: '127.0.0.1', port, pid: owned ? 7 : null, error: null };
      return { ...state };
    },
    async stop() {
      stops += 1;
      state = { ...state, running: false, ready: false, owned: false, pid: null };
    },
    status: () => ({ ...state }),
  };
}

async function echoServer() {
  const server = createNetServer(socket => { socket.on('data', data => socket.write(data)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

function client(url) {
  const ws = new WebSocket(url); let id = 0;
  const inbox = [], waiters = [];
  ws.on('message', data => { const message = JSON.parse(data); inbox.push(message); for (const f of [...waiters]) f(); });
  function wait(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); reject(new Error('WS timeout')); }, 10000);
      function check() { const i = inbox.findIndex(predicate); if (i >= 0) { clearTimeout(timer); waiters.splice(waiters.indexOf(check), 1); resolve(inbox.splice(i, 1)[0]); } }
      waiters.push(check); check();
    });
  }
  return { ws, wait, async command(type, fields = {}) { const request = String(++id); ws.send(JSON.stringify({ id: request, type, ...fields })); return wait(m => m.type === 'response' && m.id === request); } };
}

async function withApp(t, fields, run) {
  const root = await mkdtemp(join(tmpdir(), 'guey-desk-'));
  const app = await createGueyServer({ port: 0, stateDir: root, runtime: stubRuntime(), desktopIdleMs: 20, ...fields });
  const address = await app.listen();
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return run({ app, address, base: `http://127.0.0.1:${address.port}`, url: `ws://127.0.0.1:${address.port}` });
}

test('wayvnc refuses an occupied port instead of adopting the stranger', async () => {
  const stranger = createNetServer();
  await new Promise(resolve => stranger.listen(0, '127.0.0.1', resolve));
  const port = stranger.address().port;
  let spawned = 0;
  try {
    const manager = new WayVncManager({
      port, executable: '/bin/true', readyTimeoutMs: 200,
      spawnProcess: () => { spawned += 1; return fakeChild(); },
    });
    const status = await manager.start();
    assert.equal(spawned, 0);
    assert.equal(status.ready, false);
    assert.equal(status.owned, false);
    assert.match(status.error, /already taken/);
    await manager.stop();
  } finally { await new Promise(resolve => stranger.close(resolve)); }
});

test('wayvnc binds loopback on a port it owns and only kills that child', async () => {
  let spawned = 0, killed = 0;
  let bound;
  const manager = new WayVncManager({
    executable: '/bin/true', readyTimeoutMs: 1500,
    spawnProcess: (_cmd, args) => {
      spawned += 1;
      const host = args.at(-2);
      const port = Number(args.at(-1));
      assert.equal(host, '127.0.0.1');
      assert.notEqual(port, 5900);
      bound = createNetServer();
      bound.listen(port, host);
      const child = fakeChild();
      const inner = child.kill;
      child.kill = sig => { killed += 1; bound.close(); inner(sig); };
      return child;
    },
  });
  const status = await manager.start();
  assert.equal(spawned, 1);
  assert.equal(status.ready, true);
  assert.equal(status.owned, true);
  assert.equal(status.host, '127.0.0.1');
  assert.notEqual(status.port, 5900);
  await manager.stop();
  assert.equal(killed, 1);
  const idle = new WayVncManager({ spawnProcess: () => { spawned += 1; return fakeChild(); } });
  await idle.stop();
  assert.equal(spawned, 1, 'stop without start must not spawn or kill a stranger');
});

test('reserved loopback ports skip 5900', async () => {
  const port = await freeLoopbackPort();
  assert.notEqual(port, 5900);
  assert.equal(typeof port, 'number');
});

test('desktop assets are same-origin; capture stays asleep until a viewer arrives', async t => {
  const wayvnc = fakeWayVnc({ port: 9 });
  await withApp(t, { wayvnc }, async ({ base, url }) => {
    assert.equal(wayvnc.starts(), 0);
    const rfb = await fetch(`${base}/vendor/novnc/core/rfb.js`);
    assert.equal(rfb.status, 200);
    assert.match(rfb.headers.get('content-type'), /javascript/);
    assert.match(await rfb.text(), /export default class RFB/);
    assert.equal((await fetch(`${base}/css/desk.css`)).status, 200);
    assert.equal((await fetch(`${base}/js/desk.js`)).status, 200);
    const a = client(`${url}/pi`);
    await once(a.ws, 'open');
    const snap = await a.wait(m => m.type === 'snapshot');
    assert.ok(snap.data.controls.some(row => row.id === 'desktop-open' && row.where === 'client'));
    a.ws.close();
    assert.equal(wayvnc.starts(), 0, 'idle /pi clients must not start capture');
  });
});

test('desktop websocket keeps the private Host/Origin check and rejects extras', async t => {
  const wayvnc = fakeWayVnc({ port: 9 });
  await withApp(t, { wayvnc, origins: ['https://proxy.example.net'] }, async ({ base, url }) => {
    const fail = (target, headers) => new Promise((resolve, reject) => {
      const ws = new WebSocket(target, headers ? { headers } : undefined);
      ws.on('error', () => {});
      const timer = setTimeout(() => reject(new Error('no rejection')), 3000);
      ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); res.resume(); resolve(res.statusCode); });
      ws.on('error', err => {
        const match = String(err.message).match(/\b(403|503)\b/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      ws.on('open', () => { clearTimeout(timer); ws.close(); reject(new Error('opened')); });
    });
    assert.equal(await fail(`${url}/desktop`, { origin: 'https://evil.example' }), 403);
    assert.equal(await fail(`${url}/desktop?x=1`), 403);
    assert.equal(await fail(`${url}/api/desktop/ws`), 403);
    assert.equal(await new Promise(resolve => get(base + '/vendor/novnc/core/rfb.js', { headers: { Origin: 'https://evil.example' } }, res => { res.resume(); resolve(res.statusCode); })), 403);
    assert.equal(wayvnc.starts(), 0);
  });
});

test('a failed capture is 503 and does not stay running', async t => {
  const wayvnc = fakeWayVnc({ fail: true });
  await withApp(t, { wayvnc }, async ({ url }) => {
    const status = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${url}/desktop`);
      ws.on('error', () => {});
      ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
      ws.on('open', () => { ws.close(); reject(new Error('opened')); });
    });
    assert.equal(status, 503);
    assert.equal(wayvnc.starts(), 1);
    await new Promise(r => setTimeout(r, 40));
    assert.equal(wayvnc.stops(), 0, 'a start that never owned a child is a no-op stop at the manager; bridge must not pretend it is running');
  });
});

test('bytes flow over the bridge; last viewer stops an owned capture; unowned capture is left alone', async t => {
  const echo = await echoServer();
  t.after(() => echo.close());
  const owned = fakeWayVnc({ port: echo.port, owned: true });
  await withApp(t, { wayvnc: owned }, async ({ url }) => {
    assert.equal(owned.starts(), 0);
    const a = new WebSocket(`${url}/desktop`);
    const b = new WebSocket(`${url}/desktop`);
    await once(a, 'open'); await once(b, 'open');
    assert.equal(owned.starts(), 1);
    a.send(Buffer.from('one'), { binary: true });
    assert.equal(Buffer.from((await once(a, 'message'))[0]).toString(), 'one');
    b.send(Buffer.from('two'), { binary: true });
    assert.equal(Buffer.from((await once(b, 'message'))[0]).toString(), 'two');
    await new Promise(r => setTimeout(r, 40));
    assert.equal(owned.stops(), 0, 'an attached viewer keeps capture awake');
    a.close(); await once(a, 'close');
    await new Promise(r => setTimeout(r, 40));
    assert.equal(owned.stops(), 0, 'the first of two viewers leaving must not stop capture');
    b.close(); await once(b, 'close');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(owned.stops(), 1);
  });

  const echo2 = await echoServer();
  t.after(() => echo2.close());
  const unowned = fakeWayVnc({ port: echo2.port, owned: false });
  await withApp(t, { wayvnc: unowned }, async ({ url }) => {
    const ws = new WebSocket(`${url}/desktop`);
    const status = await new Promise((resolve, reject) => {
      ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
      ws.on('open', () => { ws.close(); reject(new Error('opened unowned stream')); });
      ws.on('error', () => {});
    });
    assert.equal(status, 503);
    assert.equal(unowned.starts(), 1);
    assert.equal(unowned.stops(), 0, 'must not stop a capture this process does not own');
  });
});

function gatedWayVnc({ port }) {
  let starts = 0, stops = 0, stopped = false;
  let release = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  let state = { running: false, ready: false, owned: false, host: '127.0.0.1', port, pid: null, error: null };
  return {
    starts: () => starts,
    stops: () => stops,
    release: () => release(),
    async start() {
      starts += 1;
      state = { ...state, running: true, owned: true, pid: 7 };
      await gate;
      if (stopped) return { ...state };
      state = { ...state, ready: true, running: true, owned: true, pid: 7, error: null };
      return { ...state };
    },
    async stop() {
      stopped = true;
      stops += 1;
      state = { ...state, running: false, ready: false, owned: false, pid: null };
      release();
    },
    status: () => ({ ...state }),
  };
}

test('stop waits for SIGKILL exit and never marks a dead child ready', async () => {
  let spawned = 0, sigkillAt = 0, exited = false;
  const manager = new WayVncManager({
    executable: '/bin/true', readyTimeoutMs: 1500, termTimeoutMs: 20, killTimeoutMs: 400,
    spawnProcess: (_cmd, args) => {
      spawned += 1;
      const host = args.at(-2);
      const port = Number(args.at(-1));
      const bound = createNetServer();
      bound.listen(port, host);
      const child = fakeChild();
      child.kill = sig => {
        if (sig === 'SIGTERM') return;
        sigkillAt = Date.now();
        setTimeout(() => {
          bound.close();
          child.exitCode = 0;
          exited = true;
          child.emit('exit', 0, 'SIGKILL');
        }, 40);
      };
      return child;
    },
  });
  assert.equal((await manager.start()).ready, true);
  const stopping = manager.stop();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(exited, false);
  assert.equal(manager.child != null, true, 'child stays until it actually exits');
  assert.equal(manager.status().ready, false);
  await stopping;
  assert.equal(exited, true);
  assert.ok(Date.now() - sigkillAt >= 35);
  assert.equal(manager.child, null);
  assert.equal(manager.status().owned, false);
  assert.equal(spawned, 1);
});

test('a concurrent stop aborts start; a late listener is not adopted as ready', async () => {
  let port;
  const manager = new WayVncManager({
    executable: '/bin/true', readyTimeoutMs: 400, termTimeoutMs: 20,
    spawnProcess: (_cmd, args) => {
      port = Number(args.at(-1));
      const child = fakeChild();
      queueMicrotask(() => { child.exitCode = 1; child.emit('exit', 1, null); });
      return child;
    },
  });
  const starting = manager.start();
  const stopping = manager.stop();
  const started = await starting;
  await stopping;
  assert.equal(started.ready, false);
  assert.equal(manager.status().running, false);
  const stranger = createNetServer();
  await new Promise(resolve => stranger.listen(port, '127.0.0.1', resolve));
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(manager.status().ready, false);
    assert.equal(manager.status().owned, false);
  } finally { await new Promise(resolve => stranger.close(resolve)); }
});

test('closing the server during startup rejects the upgrade and stops capture', async t => {
  const echo = await echoServer();
  t.after(() => echo.close());
  const wayvnc = gatedWayVnc({ port: echo.port });
  const root = await mkdtemp(join(tmpdir(), 'guey-desk-shut-'));
  const app = await createGueyServer({ port: 0, stateDir: root, runtime: stubRuntime(), wayvnc, desktopIdleMs: 20 });
  const address = await app.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/desktop`);
  ws.on('error', () => {});
  await new Promise(resolve => { const tmr = setInterval(() => { if (wayvnc.starts() > 0) { clearInterval(tmr); resolve(); } }, 5); });
  await app.close();
  assert.equal(wayvnc.stops(), 1);
  assert.notEqual(ws.readyState, WebSocket.OPEN);
  await rm(root, { recursive: true, force: true });
});

test('a socket that dies during startup does not leave capture running', async t => {
  const echo = await echoServer();
  t.after(() => echo.close());
  const wayvnc = gatedWayVnc({ port: echo.port });
  await withApp(t, { wayvnc, desktopIdleMs: 15 }, async ({ url }) => {
    const ws = new WebSocket(`${url}/desktop`);
    ws.on('error', () => {});
    await new Promise(resolve => { const tmr = setInterval(() => { if (wayvnc.starts() > 0) { clearInterval(tmr); resolve(); } }, 5); });
    ws.terminate();
    wayvnc.release();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(wayvnc.stops(), 1);
  });
});

function waitClose(ws, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('close', onClose);
      try { ws.terminate(); } catch { /* already gone */ }
      reject(new Error(label));
    }, ms);
    function onClose(code, reason) {
      clearTimeout(timer);
      resolve([code, reason]);
    }
    ws.once('close', onClose);
  });
}

test('inbound TCP backpressure closes a stalled input stream', async t => {
  const peers = new Set();
  const server = createNetServer(socket => {
    peers.add(socket);
    socket.pause();
    socket.on('close', () => peers.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of peers) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const wayvnc = fakeWayVnc({ port: server.address().port, owned: true });
  await withApp(t, { wayvnc, desktopMaxTcpBuffer: 64 }, async ({ url }) => {
    const ws = new WebSocket(`${url}/desktop`);
    t.after(() => { try { ws.terminate(); } catch { /* already gone */ } });
    await once(ws, 'open');
    // writableLength only counts Node's userspace queue. A small write is
    // absorbed by the kernel even when the peer is paused, so the cap never
    // trips until the send buffer fills. Push until the bridge closes us.
    const chunk = Buffer.alloc(64 * 1024);
    const closed = waitClose(ws, 5000, 'expected congested close 1013');
    for (let i = 0; i < 64 && ws.readyState === WebSocket.OPEN; i++) ws.send(chunk);
    const [code] = await closed;
    assert.equal(code, 1013);
  });
});

test('desktop-close during a slow open does not leave the canvas remembered open', async t => {
  const wayvnc = fakeWayVnc({ port: 9, owned: true });
  await withApp(t, { wayvnc }, async ({ url }) => {
    const view = new WebSocket(`${url}/pi`);
    const agent = new WebSocket(`${url}/pi`);
    t.after(() => { try { view.terminate(); } catch { /* gone */ } try { agent.terminate(); } catch { /* gone */ } });
    await once(view, 'open');
    await once(agent, 'open');
    let lastSnap;
    const onAgent = raw => {
      const m = JSON.parse(raw);
      if (m.type === 'snapshot') lastSnap = m.data;
    };
    agent.on('message', onAgent);
    view.send(JSON.stringify({ id: 'h', type: 'hello', kind: 'desktop', width: 800, height: 600, dpr: 1, visible: true }));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('hello timeout')), 2000);
      const onMsg = raw => {
        const m = JSON.parse(raw);
        if (m.type === 'response' && m.id === 'h') { clearTimeout(timer); view.off('message', onMsg); resolve(); }
      };
      view.on('message', onMsg);
    });
    let sawOpen = false;
    view.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.type !== 'control') return;
      if (m.name === 'desktop-open') {
        sawOpen = true;
        setTimeout(() => view.send(JSON.stringify({ id: m.id, type: 'control-result' })), 150);
      } else {
        view.send(JSON.stringify({ id: m.id, type: 'control-result' }));
      }
    });
    const openReq = new Promise(resolve => {
      const onMsg = raw => {
        const m = JSON.parse(raw);
        if (m.type === 'response' && m.id === 'o1') { agent.off('message', onMsg); resolve(m); }
      };
      agent.on('message', onMsg);
    });
    agent.send(JSON.stringify({ id: 'o1', type: 'desktop-open' }));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no desktop-open control')), 2000);
      const poll = setInterval(() => { if (sawOpen) { clearInterval(poll); clearTimeout(timer); resolve(); } }, 5);
    });
    const closeReq = new Promise(resolve => {
      const onMsg = raw => {
        const m = JSON.parse(raw);
        if (m.type === 'response' && m.id === 'c1') { agent.off('message', onMsg); resolve(m); }
      };
      agent.on('message', onMsg);
    });
    agent.send(JSON.stringify({ id: 'c1', type: 'desktop-close' }));
    assert.equal((await closeReq).success, true);
    assert.equal((await openReq).success, true);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(lastSnap?.desktopOpen, false);
  });
});

test('desktop-close stops wayvnc immediately', async t => {
  const wayvnc = fakeWayVnc({ port: 9, owned: true });
  await withApp(t, { wayvnc, desktopIdleMs: 30_000 }, async ({ url }) => {
    const agent = client(`${url}/pi`);
    await once(agent.ws, 'open');
    await agent.wait(m => m.type === 'snapshot');
    assert.equal((await agent.command('desktop-open')).success, true);
    assert.equal((await agent.command('desktop-close')).success, true);
    assert.equal(wayvnc.stops(), 1);
    assert.equal(wayvnc.status().running, false);
  });
});

test('desktop-open is one canvas: remembered with no viewer, then fans out to every hello', async t => {
  const wayvnc = fakeWayVnc({ port: 9, owned: true });
  const root = await mkdtemp(join(tmpdir(), 'guey-desk-ctl-'));
  const app = await createGueyServer({ port: 0, stateDir: root, runtime: stubRuntime(), wayvnc, desktopIdleMs: 20 });
  const address = await app.listen();
  const url = `ws://127.0.0.1:${address.port}/pi`;
  try {
    const agent = client(url);
    await once(agent.ws, 'open');
    const first = await agent.wait(m => m.type === 'snapshot');
    assert.equal(first.data.desktopOpen, false);
    assert.equal((await agent.command('desktop-open')).success, true);
    assert.equal((await agent.wait(m => m.type === 'snapshot' && m.data.desktopOpen === true)).data.desktopOpen, true);

    const phone = client(url);
    const desk = client(url);
    await once(phone.ws, 'open');
    await once(desk.ws, 'open');
    assert.equal((await phone.wait(m => m.type === 'snapshot')).data.desktopOpen, true, 'a later device must see the canvas already open');
    const seen = { phone: [], desk: [] };
    for (const [name, sock] of [['phone', phone], ['desk', desk]]) {
      sock.ws.on('message', raw => {
        const m = JSON.parse(raw);
        if (m.type === 'control' && m.name.startsWith('desktop-')) {
          seen[name].push(m.name);
          sock.ws.send(JSON.stringify({ id: m.id, type: 'control-result' }));
        }
      });
    }
    assert.equal((await phone.command('hello', { kind: 'phone' })).data.kind, 'phone');
    assert.equal((await desk.command('hello', { kind: 'desktop' })).data.kind, 'desktop');
    assert.equal((await agent.command('desktop-open')).success, true);
    assert.deepEqual(seen.phone, ['desktop-open']);
    assert.deepEqual(seen.desk, ['desktop-open']);
    assert.equal((await agent.command('desktop-close')).success, true);
    assert.deepEqual(seen.phone, ['desktop-open', 'desktop-close']);
    assert.deepEqual(seen.desk, ['desktop-open', 'desktop-close']);
    phone.ws.close();
    desk.ws.close();
    agent.ws.close();
  } finally {
    await app.close();
    assert.equal(wayvnc.stops() >= 1 || wayvnc.starts() === 0, true);
    await rm(root, { recursive: true, force: true });
  }
});

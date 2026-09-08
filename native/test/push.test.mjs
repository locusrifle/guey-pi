import { test } from 'node:test';
import { get } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once, EventEmitter } from 'node:events';
import { createPublicKey, verify } from 'node:crypto';
import { WebSocket } from 'ws';
import { createGueyServer } from '../../server.mjs';
import {
  allowedPushUrl, applicationServerKey, b64url, createPush, generateVapidKeys, vapidHeader,
} from '../push.mjs';

function stubRuntime(snapshot = {}) {
  const events = new EventEmitter();
  let current = { sessionId: 't', messages: [], busy: false, ...snapshot };
  return {
    events,
    snapshot: () => ({ ...current }),
    set(next) { current = { ...current, ...next }; events.emit('change'); },
    async command() { throw new Error('Unsupported command'); },
    async close() {},
  };
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

function fakeSub(host = 'fcm.googleapis.com') {
  return {
    endpoint: `https://${host}/ps/ok`,
    keys: { p256dh: b64url(Buffer.alloc(65, 7)), auth: b64url(Buffer.alloc(16, 9)) },
  };
}

async function withApp(t, fields, run) {
  const root = await mkdtemp(join(tmpdir(), 'guey-push-'));
  const runtime = fields.runtime ?? stubRuntime();
  const app = await createGueyServer({ port: 0, stateDir: root, runtime, desktopIdleMs: 20, ...fields });
  const address = await app.listen();
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return run({ app, runtime, root, address, base: `http://127.0.0.1:${address.port}`, url: `ws://127.0.0.1:${address.port}` });
}

test('only browser push services are accepted as endpoints', () => {
  assert.equal(allowedPushUrl('https://fcm.googleapis.com/fcm/send/abc'), true);
  assert.equal(allowedPushUrl('https://web.push.apple.com/x'), true);
  assert.equal(allowedPushUrl('https://updates.push.services.mozilla.com/wpush/v2/x'), true);
  assert.equal(allowedPushUrl('http://fcm.googleapis.com/x'), false);
  assert.equal(allowedPushUrl('https://evil.example/steal'), false);
  assert.equal(allowedPushUrl('https://127.0.0.1/ps'), false);
});

test('VAPID JWT is ES256 over the push-service origin', () => {
  const keys = generateVapidKeys();
  const header = vapidHeader({
    keys, endpoint: 'https://fcm.googleapis.com/x', subject: 'mailto:maintainer@example.invalid', expiresAt: 1_800_000_000_000,
  });
  const token = header.match(/^vapid t=([^ ]+), k=/)[1];
  const [h, p, s] = token.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:maintainer@example.invalid');
  const ok = verify('sha256', Buffer.from(`${h}.${p}`), {
    key: createPublicKey({ key: keys.publicKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363',
  }, Buffer.from(s, 'base64url'));
  assert.equal(ok, true);
  assert.equal(applicationServerKey(keys.publicKey)[0], 0x04);
});

test('a gone endpoint is dropped; a visible phone suppresses the ping', async () => {
  const gone = fakeSub();
  const live = { ...fakeSub(), endpoint: 'https://fcm.googleapis.com/ps/keep' };
  const sent = [];
  const push = await createPush({
    keys: generateVapidKeys(),
    fetch: async (url, init) => {
      sent.push({ url, hasAuth: Boolean(init.headers.Authorization), ttl: init.headers.TTL });
      return { status: url.endsWith('/ok') ? 410 : 201, text: async () => '' };
    },
  });
  await push.subscribe(gone);
  await push.subscribe(live);
  assert.deepEqual(await push.ping(), { sent: 1, remaining: 1 });
  assert.equal(push.list()[0], live.endpoint);
  assert.equal(sent.length, 2);
});

test('same-origin vapid key; subscribe then ping only when the phone is not looking', async t => {
  const sent = [];
  const push = await createPush({
    keys: generateVapidKeys(),
    fetch: async (url, init) => { sent.push({ url, urgency: init.headers.Urgency }); return { status: 201, text: async () => '' }; },
  });
  const runtime = stubRuntime({ busy: true });
  await withApp(t, { runtime, push }, async ({ base, url }) => {
    assert.equal((await fetch(`${base}/sw.js`)).status, 200);
    assert.equal((await fetch(`${base}/manifest.webmanifest`)).status, 200);
    const vapid = await fetch(`${base}/push/vapid`);
    assert.equal(vapid.status, 200);
    assert.equal((await vapid.json()).publicKey, push.publicKey);
    assert.equal(await new Promise(resolve => get(base + '/push/vapid', { headers: { Origin: 'https://evil.example' } }, res => { res.resume(); resolve(res.statusCode); })), 403);

    const phone = client(`${url}/pi`);
    await once(phone.ws, 'open');
    await phone.wait(m => m.type === 'snapshot');
    assert.equal((await phone.command('hello', { kind: 'phone', visible: false })).data.visible, false);
    const sub = fakeSub();
    assert.equal((await phone.command('push-subscribe', { subscription: sub })).success, true);
    assert.equal((await phone.command('push-subscribe', { subscription: { endpoint: 'https://evil.example/x', keys: sub.keys } })).success, false);
    runtime.set({ busy: false });
    await new Promise(r => setTimeout(r, 80));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, sub.endpoint);
    assert.equal(sent[0].urgency, 'high');

    sent.length = 0;
    await phone.command('hello', { kind: 'phone', visible: true });
    runtime.set({ busy: true });
    await new Promise(r => setTimeout(r, 80));
    runtime.set({ busy: false });
    await new Promise(r => setTimeout(r, 80));
    assert.equal(sent.length, 0, 'a looking phone must not be pinged');
    phone.ws.close();
  });
});

test('a failed runtime does not ping on the way down', async t => {
  const sent = [];
  const push = await createPush({
    keys: generateVapidKeys(),
    fetch: async url => { sent.push(url); return { status: 201, text: async () => '' }; },
  });
  await push.subscribe(fakeSub());
  const runtime = stubRuntime({ busy: true });
  await withApp(t, { runtime, push }, async () => {
    runtime.set({ busy: false, failed: 'terminal ended' });
    await new Promise(r => setTimeout(r, 80));
    assert.equal(sent.length, 0);
  });
});

import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ALLOWED = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
  /^wns\.windows\.com$/,
];

export function b64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey: publicKey.export({ format: 'jwk' }),
    privateKey: privateKey.export({ format: 'jwk' }),
  };
}

export function applicationServerKey(jwk) {
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
}

export function allowedPushUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  return ALLOWED.some(rule => rule.test(host));
}

function asSubscription(value) {
  const endpoint = String(value?.endpoint ?? '');
  const p256dh = String(value?.keys?.p256dh ?? '');
  const auth = String(value?.keys?.auth ?? '');
  if (!allowedPushUrl(endpoint)) throw new Error('Push endpoint is not a browser push service');
  if (p256dh.length < 20 || p256dh.length > 200 || auth.length < 8 || auth.length > 200) {
    throw new Error('Push subscription keys are the wrong size');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) {
    throw new Error('Push subscription keys must be base64url');
  }
  return { endpoint, keys: { p256dh, auth }, createdAt: new Date().toISOString() };
}

export function vapidHeader({ keys, endpoint, subject, expiresAt }) {
  const audience = new URL(endpoint).origin;
  const payload = { aud: audience, exp: Math.floor(expiresAt / 1000), sub: subject };
  const unsigned = `${b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64url(JSON.stringify(payload))}`;
  const signature = sign('sha256', Buffer.from(unsigned), {
    key: keys.privateKey, format: 'jwk', type: 'pkcs8', dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${b64url(applicationServerKey(keys.publicKey))}`;
}

export async function createPush(options = {}) {
  const stateDir = options.stateDir;
  const subject = options.subject ?? process.env.GUEY_PUSH_SUBJECT ?? 'https://github.com/locusrifle/guey-pi';
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const path = stateDir ? join(stateDir, 'push-vapid.json') : null;
  const listPath = stateDir ? join(stateDir, 'push-subscriptions.json') : null;
  let keys = options.keys;
  if (!keys && path) {
    try { keys = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!keys?.publicKey?.x || !keys?.privateKey?.d) {
    keys = generateVapidKeys();
    if (path) {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify(keys)}\n`, { mode: 0o600 });
    }
  }
  let subscriptions = [];
  if (listPath) {
    try { subscriptions = JSON.parse(await readFile(listPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!Array.isArray(subscriptions)) subscriptions = [];
  }
  async function persist() {
    if (!listPath) return;
    await writeFile(listPath, `${JSON.stringify(subscriptions, null, 2)}\n`, { mode: 0o600 });
  }
  const publicKey = b64url(applicationServerKey(keys.publicKey));
  return {
    publicKey,
    list: () => subscriptions.map(row => row.endpoint),
    async subscribe(raw) {
      const row = asSubscription(raw);
      subscriptions = [row, ...subscriptions.filter(item => item.endpoint !== row.endpoint)].slice(0, 8);
      await persist();
      return { ok: true, endpoint: row.endpoint };
    },
    async ping() {
      const now = options.now?.() ?? Date.now();
      const next = [];
      let sent = 0;
      for (const row of subscriptions) {
        try {
          const response = await fetchImpl(row.endpoint, {
            method: 'POST',
            headers: {
              TTL: '120',
              Urgency: 'high',
              Authorization: vapidHeader({ keys, endpoint: row.endpoint, subject, expiresAt: now + 12 * 60 * 60 * 1000 }),
            },
          });
          if (response.status === 404 || response.status === 410) continue;
          if (response.status >= 400) {
            await response.text().catch(() => '');
            next.push(row);
            continue;
          }
          sent += 1;
          next.push(row);
        } catch {
          next.push(row);
        }
      }
      if (next.length !== subscriptions.length) {
        subscriptions = next;
        await persist();
      }
      return { sent, remaining: subscriptions.length };
    },
  };
}

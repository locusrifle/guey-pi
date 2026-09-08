import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { readFile, mkdir, open, readFile as read, readdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { createRuntime } from './native/runtime.mjs';
import { transcribeAudio } from './native/transcribe.mjs';
import { CONTROLS } from './native/controls.mjs';
import { tuiThemeCss } from './native/tui-theme.mjs';
import { createDesktopBridge } from './native/desktop.mjs';
import { createPush } from './native/push.mjs';
import { resolveProduct, PERSONAL_CONTROL_IDS } from './native/product.mjs';
import { applySetting, settingsView } from './native/settings-io.mjs';

export function privateHost(host) {
  if (['127.0.0.1', '::1'].includes(host)) return true;
  const parts = host.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.otf': 'font/otf', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
// Served from a directory, so the stylesheets and fonts of the design system
// come across whole. Only what resolves inside native/public is readable, and
// only these types: a traversal or an unknown extension is a 404, not a file.
function assetPath(publicDir, urlPath) {
  const wanted = urlPath === '/' ? '/index.html' : urlPath;
  if (wanted.includes('\0') || wanted.includes('..')) return null;
  const full = resolve(publicDir, `.${wanted}`);
  if (full !== publicDir && !full.startsWith(publicDir + sep)) return null;
  const type = TYPES[extname(full)];
  return type ? { full, type } : null;
}

export async function createGueyServer(options = {}) {
  // Bind comes from the caller. The live unit passes LOCUS_SITE_* at the
  // entrypoint; tests and agent probes must not inherit that address, or
  // `port: 0` listens on the tailnet and a fetch to 127.0.0.1 never returns.
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 5057;
  if (!privateHost(host)) throw new Error('GUEY is a private console: bind a loopback or tailnet IP');
  const cwd = resolve(options.cwd ?? process.env.GUEY_CWD ?? process.cwd());
  const product = resolveProduct(options);
  const personal = product === 'locusrifle';
  const controls = personal ? CONTROLS : CONTROLS.filter(c => !PERSONAL_CONTROL_IDS.has(c.id));
  const stateDir = resolve(options.stateDir ?? process.env.GUEY_STATE_DIR ?? join(homedir(), personal ? '.local/state/guey-pi' : '.local/state/guey-desktop'));
  const publicDir = resolve(import.meta.dirname, 'native/public');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  // One owner per GUEY store. Never share this store with another GUEY instance.
  const lockPath = join(stateDir, 'owner.pid');
  try {
    const pid = Number(await read(lockPath, 'utf8'));
    if (pid > 0) { try { process.kill(pid, 0); throw new Error(`GUEY store is owned by process ${pid}`); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    await unlink(lockPath);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.close();
  let runtime;
  // Same agentDir as the laptop TUI: sessions, extensions, skills, settings.
  // Desktop passes noExtensions itself. Tests pass an injected runtime.
  try {
    runtime = options.runtime ?? await createRuntime({
      cwd, stateDir, sessionDir: options.sessionDir, agentDir: options.agentDir,
      runtimeDir: options.runtimeDir, liveSessions: options.liveSessions,
      authentication: options.authentication, ownArchive: options.ownArchive ?? !personal,
      serviceOptions: options.serviceOptions,
    });
  }
  catch (e) { await unlink(lockPath); throw e; }
  const clients = new Set();
  const push = personal ? (options.push ?? await createPush({ stateDir })) : { publicKey: '', ping: async () => {}, subscribe: async () => ({}), close: async () => {} };
  const desktop = personal ? (options.desktop ?? createDesktopBridge({
    wayvnc: options.wayvnc,
    idleMs: options.desktopIdleMs,
    maxTcpBuffer: options.desktopMaxTcpBuffer,
    wayvncOptions: options.wayvncOptions,
  })) : { handleUpgrade: (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'), close: async () => {} };
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  let themeName = runtime.session?.settingsManager?.getTheme?.() || 'dark';
  let themeRev = 0;
  try {
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
    if (settings.theme) themeName = String(settings.theme);
  } catch {}
  const extraOrigins = options.origins ?? (process.env.GUEY_ORIGINS ?? '').split(',').filter(Boolean);
  // Host/Origin pinning stops a hostile page in a browser on the tailnet from
  // scripting this console. A reverse proxy (tailscale serve) forwards its own
  // name, so each configured origin is trusted with and without its port —
  // reaching the same process through https://<tailnet name>/ must still work.
  const originHosts = extraOrigins.map(o => new URL(o));
  const validRequest = req => {
    const expectedHost = `${host.includes(':') ? `[${host}]` : host}:${server.address()?.port ?? port}`;
    const trustedHosts = new Set([expectedHost, ...originHosts.flatMap(u => [u.host, u.hostname])]);
    // A proxy may or may not append the scheme's default port to its own name.
    // Stripping it only ever matches a configured hostname, never a stray port
    // on the bind address: `<bind ip>:9999` still fails.
    const bare = req.headers.host?.replace(/:\d+$/, '');
    if (!trustedHosts.has(req.headers.host) && !trustedHosts.has(bare)) return false;
    if (!req.headers.origin) return true;
    return [`http://${expectedHost}`, ...originHosts.map(u => u.origin)].includes(req.headers.origin);
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
    if (!validRequest(req)) { res.writeHead(403).end(`Private origin required. This console answers to its own bind, plus GUEY_ORIGINS. Rejected Host: ${req.headers.host ?? '(none)'}${req.headers.origin ? `, Origin: ${req.headers.origin}` : ''}`); return; }
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://local').pathname); } catch { res.writeHead(400).end('Bad path'); return; }
    if (path === '/transcribe' && req.method === 'POST') {
      if (!personal) { res.writeHead(404).end('Not found'); return; }
      const chunks = [];
      let n = 0;
      try {
        for await (const chunk of req) {
          n += chunk.length;
          if (n > 8 * 1024 * 1024) { res.writeHead(413).end('clip too large'); return; }
          chunks.push(chunk);
        }
        const mime = (req.headers['content-type'] || 'audio/webm').split(';')[0];
        const text = await transcribeAudio(Buffer.concat(chunks), mime);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ text }));
      } catch (error) {
        const missing = error.code === 'ENOENT';
        res.writeHead(missing ? 503 : 502).end(missing ? 'no openai key' : 'transcribe failed');
      }
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (path === '/theme.css') {
      try {
        const css = await tuiThemeCss(themeName, agentDir);
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.end(css);
      } catch (error) { res.writeHead(500).end('theme failed'); }
      return;
    }
    if (path === '/push/vapid') {
      if (!personal) { res.writeHead(404).end('Not found'); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ publicKey: push.publicKey })); return;
    }
    if (path === '/health') {
      const s = runtime.snapshot();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: !s.failed, ui: 'native-gui', product, runtime: 'pi-sdk', pid: process.pid, clients: clients.size, cwd: s.cwd, sessionId: s.sessionId, sessionFile: s.sessionFile, busy: s.busy })); return;
    }
    const wanted = (path === '/' || path === '/index.html') && product === 'stock' ? '/stock.html' : path;
    const asset = assetPath(publicDir, wanted);
    if (!asset) { res.writeHead(404).end('Not found'); return; }
    try {
      const body = await readFile(asset.full);
      res.setHeader('Content-Type', asset.type.startsWith('text/') || asset.type.endsWith('javascript') ? `${asset.type}; charset=utf-8` : asset.type);
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const send = (ws, value) => {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify(value));
  };
  // Snapshots of a watched TUI are routinely >8MB. Closing at that size made
  // the GUI reconnect forever (1013). Keep the socket; send the latest when
  // the previous frame has drained.
  const sendSnapshot = (ws, raw) => {
    if (ws.readyState !== 1) return false;
    if (ws.bufferedAmount > 1024 * 1024) return false;
    ws.send(raw);
    return true;
  };
  const listed = () => [...clients].filter(ws => ws.readyState === 1).map(ws => ({
    kind: ws.meta?.kind ?? 'unknown', width: ws.meta?.width, height: ws.meta?.height, dpr: ws.meta?.dpr, visible: ws.meta?.visible,
  }));
  const phoneIsLooking = () => [...clients].some(ws => ws.readyState === 1 && ws.meta?.kind === 'phone' && ws.meta?.visible === true);
  // The laptop screen is one canvas, not one tab. Screenshots still name a
  // device because those pixels differ; the overlay does not.
  let desktopOpen = false;
  let desktopSeq = 0;
  const view = data => ({ ...data, product, controls, clients: listed(), theme: themeName, themeRev, desktopOpen: personal ? desktopOpen : false });
  const waiting = new Map();
  const views = () => [...clients].filter(ws => ws.readyState === 1 && (ws.meta?.kind === 'phone' || ws.meta?.kind === 'desktop'));
  const clientTargets = (client) => {
    const want = client === 'all' ? null : client;
    const targets = [...clients].filter(ws => {
      if (ws.readyState !== 1) return false;
      if (!want) return true;
      return (ws.meta?.kind ?? 'unknown') === want;
    });
    if (want && !targets.length) throw new Error(`no ${want} client connected`);
    if (!targets.length) throw new Error('no browser connected');
    if (!want && targets.length > 1 && new Set(targets.map(ws => ws.meta?.kind)).size > 1) {
      throw new Error('phone and desktop are both connected; say which');
    }
    return targets;
  };
  const askClient = (ws, name) => new Promise((resolve, reject) => {
    const id = `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${name} timed out`)); }, 12000);
    waiting.set(id, message => { clearTimeout(timer); waiting.delete(id); resolve(message); });
    send(ws, { type: 'control', id, name });
  });
  const capture = async (c) => {
    const targets = clientTargets(c.client);
    const files = [];
    for (const ws of targets) {
      const result = await askClient(ws, 'capture');
      if (result.error) throw new Error(result.error);
      if (result.mime !== 'image/png' || typeof result.data !== 'string') throw new Error('capture returned no png');
      const kind = ws.meta?.kind ?? 'view';
      const path = join(stateDir, targets.length === 1 ? 'view.png' : `view-${kind}.png`);
      await writeFile(path, Buffer.from(result.data, 'base64'), { mode: 0o600 });
      files.push({ kind, path, width: result.width, height: result.height });
    }
    return { files };
  };
  const desktopControl = async (_c, name) => {
    const next = name === 'desktop-open';
    const token = ++desktopSeq;
    desktopOpen = next;
    changed();
    for (const ws of views()) {
      try {
        const result = await askClient(ws, name);
        if (result?.error) throw new Error(result.error);
      } catch {
        if (next) throw new Error('a view could not open the desktop');
      }
    }
    if (token !== desktopSeq) return { ok: true, desktopOpen };
    if (!next) await desktop.release?.();
    return { ok: true, desktopOpen };
  };
  let timer;
  let retryTimer;
  let wasBusy = Boolean(runtime.snapshot().busy);
  const flushSnapshots = () => {
    const snap = runtime.snapshot();
    const raw = JSON.stringify({ type: 'snapshot', data: view(snap) });
    let blocked = false;
    for (const ws of clients) {
      if (!sendSnapshot(ws, raw)) blocked = true;
    }
    if (blocked && !retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; flushSnapshots(); }, 80);
    }
    if (wasBusy && !snap.busy && !snap.failed && !phoneIsLooking()) void push.ping();
    wasBusy = Boolean(snap.busy);
  };
  const changed = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flushSnapshots();
    }, 40);
  };
  runtime.events.on('change', changed);
  let themeTimer;
  const refreshTheme = async () => {
    try {
      const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
      if (settings.theme) themeName = String(settings.theme);
    } catch {}
    themeRev++;
    changed();
  };
  const watchers = [];
  for (const path of [join(agentDir, 'settings.json'), join(agentDir, 'themes')]) {
    try { watchers.push(watch(path, () => { clearTimeout(themeTimer); themeTimer = setTimeout(refreshTheme, 80); })); } catch {}
  }
  async function listThemeNames() {
    const names = new Set(['dark', 'light']);
    for (const dir of [join(agentDir, 'themes'), join(import.meta.dirname, 'themes')]) {
      try { for (const file of await readdir(dir)) if (file.endsWith('.json')) names.add(file.slice(0, -5)); } catch {}
    }
    try { for (const theme of runtime.session?.resourceLoader?.getThemes()?.themes ?? []) if (theme.name) names.add(theme.name); } catch {}
    const list = [...names].sort();
    if (names.has('light') && names.has('dark')) list.push('light/dark');
    return list;
  }
  async function savedThemeName() {
    try { const from = runtime.session?.settingsManager?.getThemeSetting?.(); if (from) return String(from); } catch {}
    try {
      const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
      if (settings.theme) return String(settings.theme);
    } catch {}
    return 'dark';
  }
  async function persistTheme(name) {
    const sm = runtime.session?.settingsManager;
    if (sm?.setTheme) { sm.setTheme(name); await sm.flush(); return; }
    let settings = {};
    try { settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')); } catch {}
    settings.theme = name;
    await writeFile(join(agentDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  }
  async function readSettingsFile() {
    try { return JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')); } catch { return {}; }
  }
  async function handleSettings(c) {
    try {
      return await runtime.command({ ...c, type: 'settings' });
    } catch (error) {
      const msg = error?.message ?? '';
      if (!/belongs to the terminal|Unsupported command/.test(msg)) throw error;
    }
    const settings = await readSettingsFile();
    if (!c.key) return { ...settingsView(settings), theme: settings.theme ?? themeName };
    const next = applySetting(settings, c.key, c.value);
    await writeFile(join(agentDir, 'settings.json'), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return { ...settingsView(next), theme: next.theme ?? themeName };
  }
  async function applyTheme(name, persist) {
    const names = await listThemeNames();
    if (!names.includes(name)) throw new Error(`Unknown theme: ${name}`);
    themeName = name;
    if (persist) await persistTheme(name);
    themeRev++;
    changed();
    return { theme: themeName, themeRev, saved: persist ? themeName : await savedThemeName() };
  }
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { socket.destroy(); return; }
    if (!validRequest(req) || url.search) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    if (url.pathname === '/desktop') {
      if (!personal) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      void desktop.handleUpgrade(req, socket, head); return;
    }
    if (url.pathname !== '/pi') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    sockets.handleUpgrade(req, socket, head, ws => {
      clients.add(ws); send(ws, { type: 'snapshot', data: view(runtime.snapshot()) });
      ws.on('error', () => {});
      ws.on('close', () => { clients.delete(ws); changed(); }); // detach does NOT abort or dispose Pi
      ws.on('message', async raw => {
        let c;
        try {
          c = JSON.parse(raw.toString());
          if (!c || Array.isArray(c) || typeof c.type !== 'string' || typeof c.id !== 'string') throw new Error('Command requires string id and type');
          if (c.type === 'control-result') { waiting.get(c.id)?.(c); return; }
          if (c.type === 'hello') {
            ws.meta = {
              kind: c.kind === 'phone' ? 'phone' : 'desktop',
              width: Number(c.width) || 0, height: Number(c.height) || 0, dpr: Number(c.dpr) || 1,
              visible: c.visible === true,
            };
            send(ws, { type: 'response', id: c.id, success: true, data: ws.meta }); changed(); return;
          }
          if (c.type === 'push-subscribe' || c.type === 'capture' || c.type === 'desktop-open' || c.type === 'desktop-close') {
            if (!personal) throw new Error('Not available in stock Guey');
            if (c.type === 'push-subscribe') {
              send(ws, { type: 'response', id: c.id, success: true, data: await push.subscribe(c.subscription) }); return;
            }
            if (c.type === 'capture') {
              send(ws, { type: 'response', id: c.id, success: true, data: await capture(c) }); return;
            }
            send(ws, { type: 'response', id: c.id, success: true, data: await desktopControl(c, c.type) }); return;
          }
          if (c.type === 'themes') {
            send(ws, { type: 'response', id: c.id, success: true, data: { names: await listThemeNames(), current: themeName, saved: await savedThemeName() } }); return;
          }
          if (c.type === 'theme') {
            if (typeof c.name !== 'string') throw new Error('Theme name must be text');
            send(ws, { type: 'response', id: c.id, success: true, data: await applyTheme(c.name, Boolean(c.persist)) }); return;
          }
          if (c.type === 'settings') {
            send(ws, { type: 'response', id: c.id, success: true, data: await handleSettings(c) }); return;
          }
          const data = await runtime.command(c);
          send(ws, { type: 'response', id: c.id, success: true, data: c.type === 'snapshot' ? view(data) : data }); changed();
        } catch (e) { send(ws, { type: 'response', id: c?.id, success: false, error: e.message }); }
      });
    });
  });
  return {
    server, runtime, stateDir, sockets, desktop,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server.address())); }),
    async close() {
      clearTimeout(timer); clearTimeout(themeTimer); runtime.events.off('change', changed);
      for (const watcher of watchers) watcher.close();
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      await desktop.close();
      await new Promise(r => server.close(r));
      await runtime.close(); await unlink(lockPath);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createGueyServer({
    host: process.env.LOCUS_SITE_HOST,
    port: process.env.LOCUS_SITE_PORT ? Number(process.env.LOCUS_SITE_PORT) : undefined,
  });
  try { const address = await app.listen(); console.log(`GUEY native GUI: http://${address.address}:${address.port} (${app.stateDir})`); }
  catch (error) { await app.close(); throw error; }
  let closing = false;
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal, async () => { if (closing) return; closing = true; await app.close(); process.exit(0); });
}

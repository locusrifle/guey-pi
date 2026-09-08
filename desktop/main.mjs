import { fork, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, unlink, open, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { privateHost } from '../server.mjs';

const self = fileURLToPath(import.meta.url);
const state = resolveStateDir();
const profile = join(state, 'agent');
const endpoint = join(state, 'desktop.json');
const [command = 'start', ...args] = process.argv.slice(2);
const delay = ms => new Promise(r => setTimeout(r, ms));
const birth = async pid => (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ').at(-1).split(' ')[19];

function resolveStateDir() {
  const override = process.env.GUEY_DESKTOP_STATE_DIR;
  if (override) {
    if (!override.startsWith('/')) throw new Error('GUEY_DESKTOP_STATE_DIR must be absolute');
    return override;
  }
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) {
    if (!xdg.startsWith('/')) throw new Error('XDG_STATE_HOME must be absolute');
    return join(xdg, 'guey-desktop');
  }
  return join(homedir(), '.local/state/guey-desktop');
}

function desktopBind() {
  const ip = (process.env.GUEY_DESKTOP_HOST || '127.0.0.1').trim();
  if (!privateHost(ip)) throw new Error(`Guey must bind a loopback or tailnet IP, not ${ip}`);
  const rawPort = process.env.GUEY_DESKTOP_PORT;
  const port = rawPort == null || rawPort === '' ? 0 : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('GUEY_DESKTOP_PORT must be an integer 0–65535');
  const host = ip.includes(':') ? `[${ip}]` : ip;
  const origins = [];
  const url = (process.env.GUEY_DESKTOP_URL || '').trim().replace(/\/$/, '');
  if (url) origins.push(url);
  if (port > 0) origins.push(`http://${host}:${port}`);
  for (const part of (process.env.GUEY_DESKTOP_ORIGINS || '').split(',')) {
    const origin = part.trim().replace(/\/$/, '');
    if (origin) origins.push(origin);
  }
  return { ip, port, url, origins: [...new Set(origins)] };
}

async function running() {
  let info;
  try { info = JSON.parse(await readFile(endpoint, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    if (await birth(info.pid) !== info.birth) return null;
    const argv = (await readFile(`/proc/${info.pid}/cmdline`, 'utf8')).split('\0');
    if (!argv.includes(self) || !argv.includes('--serve')) return null;
    return info;
  } catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return null; throw e; }
}

function launch(cmd, args) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    const timer = setTimeout(() => { child.unref(); resolve(true); }, 3000);
    const done = ok => { clearTimeout(timer); resolve(ok); };
    child.on('error', () => done(false));
    child.on('exit', code => done(code === 0));
  });
}

async function openWindow(url) {
  if (process.env.GUEY_NO_BROWSER === '1') return;
  // A normal browser page (address bar and all), not Chromium --app=.
  const tries = [];
  if (process.env.GUEY_OPEN) tries.push(process.env.GUEY_OPEN.split(' ').concat(url));
  tries.push(['xdg-open', url]);
  tries.push(['chromium', url]);
  for (const [cmd, ...args] of tries) {
    if (await launch(cmd, args)) return;
  }
  console.error(`Could not open Guey window; open ${url} manually.`);
}

async function serve(cwd) {
  // Stock Guey: same credentials/settings as the TUI (~/.pi/agent auth, models,
  // settings) but a separate session archive under this launcher's state.
  // Auto-resume never opens ~/.pi/agent/sessions, so an unadvertised locusrifle
  // writer is not joined. GUEY_ISOLATE=1 is a packaged-test sandbox for
  // resources and sessions, not credential or security isolation:
  // ModelRuntime still reads ~/.pi/agent auth and models.
  process.env.GUEY_PRODUCT = process.env.GUEY_PRODUCT || 'stock';
  const isolate = process.env.GUEY_ISOLATE === '1';
  const userAgent = join(homedir(), '.pi/agent');
  const agentDir = isolate ? profile : userAgent;
  const sessionDir = isolate ? join(agentDir, 'sessions') : join(state, 'sessions');
  const bind = desktopBind();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  delete process.env.PI_PACKAGE_DIR;
  process.env.PI_SKIP_VERSION_CHECK = '1';
  process.env.PI_TELEMETRY = '0';
  const { createGueyServer } = await import('../server.mjs');
  const { SettingsManager, ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const settingsManager = SettingsManager.create(agentDir, agentDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(userAgent, 'auth.json'),
    modelsPath: join(userAgent, 'models.json'),
  });
  const app = await createGueyServer({
    host: bind.ip, port: bind.port, origins: bind.origins, cwd, stateDir: state, product: 'stock',
    agentDir, sessionDir, ownArchive: true, liveSessions: !isolate, authentication: true,
    serviceOptions: {
      settingsManager,
      modelRuntime,
      ...(isolate ? {
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
        resourceLoaderReloadOptions: { resolveProjectTrust: async () => false },
      } : {}),
    },
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try { await app.close(); await settingsManager.flush(); await unlink(endpoint).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
    finally { process.exit(0); }
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, close);
  try {
    const address = await app.listen();
    const local = `http://${bind.ip.includes(':') ? `[${bind.ip}]` : bind.ip}:${address.port}`;
    const info = { pid: process.pid, birth: await birth(process.pid), url: bind.url || local, cwd: app.runtime.snapshot().cwd };
    await writeFile(endpoint + '.tmp', JSON.stringify(info), { mode: 0o600 });
    await rename(endpoint + '.tmp', endpoint);
    process.send?.(info); process.disconnect?.();
  } catch (e) { await app.close(); throw e; }
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (process.platform !== 'linux' || major < 22 || (major === 22 && minor < 19)) throw new Error('Guey requires Linux and Node.js >=22.19');
  if (!['start', 'stop', 'status', '--serve', '--help'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command === '--help') {
    console.log('guey [start [WORKSPACE] | stop | status]\nStart listens on loopback (allocated port) and opens a browser page; closing it leaves Pi running. stop aborts any active turn.\nState: GUEY_DESKTOP_STATE_DIR, else $XDG_STATE_HOME/guey-desktop, else ~/.local/state/guey-desktop\nPrivate bind: GUEY_DESKTOP_HOST, GUEY_DESKTOP_PORT, GUEY_DESKTOP_URL, GUEY_DESKTOP_ORIGINS\nSet GUEY_NO_BROWSER=1 for headless use.');
    return;
  }
  if (args.length > (['start', '--serve'].includes(command) ? 1 : 0)) throw new Error('Unexpected arguments; see guey --help');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  if (command === '--serve') { await serve(args[0]); return; }
  const existing = await running();
  if (command === 'status') { if (!existing) { console.log('Guey is stopped'); process.exitCode = 1; } else console.log(JSON.stringify(existing)); return; }
  if (command === 'stop') {
    if (!existing) { console.log('Guey is stopped'); return; }
    process.kill(existing.pid, 'SIGTERM');
    for (let i = 0; i < 300 && await running(); i++) await delay(100);
    if (await running()) throw new Error('Guey has not stopped; see desktop.log (no forced kill sent)');
    console.log('Guey stopped'); return;
  }
  if (existing) {
    if (args[0] && resolve(args[0]) !== existing.cwd) throw new Error('Guey is already running in another workspace; stop it before changing workspace');
    console.log(existing.url); await openWindow(existing.url); return;
  }
  const cwd = resolve(args[0] ?? (process.env.GUEY_ISOLATE === '1' ? join(state, 'workspace') : homedir()));
  if (!args[0] && process.env.GUEY_ISOLATE === '1') await mkdir(cwd, { recursive: true, mode: 0o700 });
  if (!(await stat(cwd)).isDirectory()) throw new Error('Workspace must be a directory');
  const log = await open(join(state, 'desktop.log'), 'a', 0o600);
  try {
    const child = fork(self, ['--serve', cwd], { detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc'] });
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Startup timed out; see desktop.log')); }, 30000);
      child.once('message', info => { clearTimeout(timer); resolve(info); });
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Startup failed (${code}); see ${join(state, 'desktop.log')}`)); });
    });
    child.unref(); console.log(info.url); await openWindow(info.url);
  } finally { await log.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

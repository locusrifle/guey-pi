import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function executable(path) {
  try { accessSync(path, fsConstants.X_OK); return true; } catch { return false; }
}

export function defaultWayVncExecutable() {
  if (process.env.GUEY_WAYVNC) return process.env.GUEY_WAYVNC;
  if (executable('/usr/bin/wayvnc')) return '/usr/bin/wayvnc';
  return resolve(homedir(), 'locus/projects/phone-portal/.runtime/usr/bin/wayvnc');
}

export function defaultWayVncRuntimeDir(command = defaultWayVncExecutable()) {
  if (process.env.GUEY_WAYVNC_RUNTIME) return process.env.GUEY_WAYVNC_RUNTIME;
  const marker = `${sep}phone-portal${sep}.runtime${sep}`;
  const at = command.indexOf(marker);
  if (at >= 0) return command.slice(0, at + marker.length - 1);
  return '';
}

export function probeTcp(host, port, timeoutMs = 500) {
  return new Promise(resolveProbe => {
    const socket = createConnection({ host, port });
    const finish = ready => {
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(ready);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function freeLoopbackPort() {
  for (let i = 0; i < 8; i++) {
    const server = createServer();
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const port = server.address().port;
    await new Promise(resolveClose => server.close(resolveClose));
    // Never land on the conventional VNC port: adopting whoever already
    // answered there is how a private console becomes a stranger's display.
    if (port !== 5900) return port;
  }
  throw new Error('could not reserve a loopback port');
}

async function focusedOutput(environment) {
  if (environment.GUEY_OUTPUT?.trim()) return environment.GUEY_OUTPUT.trim();
  try {
    const result = await execFileAsync('hyprctl', ['monitors', '-j'], {
      env: environment, timeout: 2000, encoding: 'utf8',
    });
    const monitors = JSON.parse(String(result.stdout));
    return String(monitors.find(m => m.focused && !m.disabled)?.name
      ?? monitors.find(m => !m.disabled)?.name
      ?? '');
  } catch { return ''; }
}

export class WayVncManager {
  constructor(options = {}) {
    this.options = options;
    this.child = null;
    this.stopping = false;
    this._lock = Promise.resolve();
    this.state = {
      running: false, ready: false, owned: false, output: null,
      host: '127.0.0.1', port: options.port ?? null, pid: null, error: null,
    };
  }

  status() { return { ...this.state }; }

  _locked(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.then(() => {}, () => {});
    return run;
  }

  start() { return this._locked(() => this._start()); }

  stop() {
    this.stopping = true;
    this.state = { ...this.state, ready: false };
    return this._locked(() => this._stop());
  }

  async _start() {
    if (this.stopping) return this.status();
    if (this.child && this.state.ready) return this.status();
    if (this.child) await this._kill(this.child);
    if (this.stopping) return this.status();
    const host = this.options.host ?? '127.0.0.1';
    if (host !== '127.0.0.1' && host !== '::1') {
      this.state.error = 'wayvnc must bind loopback';
      return this.status();
    }
    const port = this.options.port ?? await freeLoopbackPort();
    if (this.stopping) return this.status();
    if (await probeTcp(host, port)) {
      this.state.error = `${host}:${port} is already taken`;
      return this.status();
    }
    if (this.stopping) return this.status();
    const environment = { ...process.env, ...this.options.environment };
    const output = this.options.output ?? await focusedOutput(environment);
    if (this.stopping) return this.status();
    const command = this.options.executable ?? defaultWayVncExecutable();
    if (command.includes('/') && !executable(command)) {
      this.state.error = `wayvnc is not installed at ${command}`;
      return this.status();
    }
    const args = [
      ...(output ? ['--output', output] : ['--desktop']),
      '--max-fps', String(this.options.maxFps ?? 60),
      '--render-cursor',
      '--disable-resizing',
      '--name', 'locusrifle',
      host,
      String(port),
    ];
    const runtimeDir = this.options.runtimeDir ?? defaultWayVncRuntimeDir(command);
    if (runtimeDir) {
      environment.LD_LIBRARY_PATH = [resolve(runtimeDir, 'usr/lib'), environment.LD_LIBRARY_PATH].filter(Boolean).join(':');
    }
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const child = spawnProcess(command, args, { env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    this.state = { running: true, ready: false, owned: true, output: output || null, host, port, pid: child.pid ?? null, error: null };
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
    child.once('error', error => {
      if (this.child !== child) return;
      this.child = null;
      this.state = { ...this.state, running: false, ready: false, owned: false, pid: null, error: error.message };
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) {
        this.state = { ...this.state, running: false, ready: false, owned: false, pid: null };
        return;
      }
      const reason = stderr.trim() || `wayvnc exited (${signal ? `signal ${signal}` : `code ${String(code)}`})`;
      this.state = { ...this.state, running: false, ready: false, owned: false, pid: null, error: reason };
    });

    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 5000);
    while (Date.now() < deadline) {
      if (this.stopping || this.child !== child) break;
      if (await probeTcp(host, port, 250)) {
        if (this.stopping || this.child !== child) break;
        this.state = { ...this.state, ready: true, error: null };
        return this.status();
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    if (this.child === child) await this._kill(child);
    if (!this.state.error && !this.stopping) this.state.error = `wayvnc did not open ${host}:${port}`;
    return this.status();
  }

  async _stop() {
    await this._kill(this.child);
    this.stopping = false;
    return this.status();
  }

  async _kill(child) {
    if (!child) {
      this.state = { ...this.state, running: false, ready: false, owned: false, pid: null };
      return;
    }
    this.state = { ...this.state, ready: false };
    if (child.exitCode !== null) {
      if (this.child === child) this.child = null;
      this.state = { ...this.state, running: false, ready: false, owned: false, pid: null };
      return;
    }
    const exited = new Promise(resolve => {
      const finish = () => { child.off('exit', finish); child.off('error', finish); resolve(); };
      child.on('exit', finish);
      child.on('error', finish);
    });
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    const termMs = this.options.termTimeoutMs ?? 1000;
    const first = await Promise.race([
      exited.then(() => 'exit'),
      new Promise(resolve => setTimeout(() => resolve('term'), termMs)),
    ]);
    if (first !== 'exit' && child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      const killMs = this.options.killTimeoutMs ?? 1000;
      await Promise.race([
        exited,
        new Promise(resolve => setTimeout(resolve, killMs)),
      ]);
    } else if (first !== 'exit') {
      await exited;
    }
    if (this.child === child) this.child = null;
    this.state = { ...this.state, running: false, ready: false, owned: false, pid: null };
  }
}

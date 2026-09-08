import { connect as connectTcp } from 'node:net';
import { WebSocketServer } from 'ws';
import { WayVncManager } from './wayvnc.mjs';

function asBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data.map(part => Buffer.isBuffer(part) ? part : Buffer.from(part)));
  return Buffer.from(data);
}

export function createDesktopBridge(options = {}) {
  const wayvnc = options.wayvnc ?? new WayVncManager(options.wayvncOptions ?? {});
  const idleMs = options.idleMs ?? 1500;
  const maxTcpBuffer = options.maxTcpBuffer ?? 8 * 1024 * 1024;
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 2 * 1024 * 1024 });
  const inflight = new Set();
  let startPromise = null;
  let idleTimer = null;
  let stopping = false;

  const cancelIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; };
  const busy = () => sockets.clients.size + inflight.size;
  const scheduleIdleStop = () => {
    cancelIdle();
    const status = wayvnc.status();
    if (stopping || busy() > 0 || !status.running || status.owned === false) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!stopping && busy() === 0 && wayvnc.status().owned !== false) void wayvnc.stop();
    }, idleMs);
    idleTimer.unref();
  };

  const ensure = async () => {
    cancelIdle();
    if (stopping) return wayvnc.status();
    const current = wayvnc.status();
    if (current.ready && current.owned !== false) return current;
    if (!startPromise) startPromise = wayvnc.start().finally(() => { startPromise = null; });
    return startPromise;
  };

  sockets.on('connection', (socket, req) => {
    cancelIdle();
    socket.once('close', scheduleIdleStop);
    socket.once('error', scheduleIdleStop);
    const host = wayvnc.status().host ?? '127.0.0.1';
    const port = wayvnc.status().port;
    if (!port) {
      socket.close(1011, 'desktop has no port');
      return;
    }
    const tcp = connectTcp({ host, port });
    let connected = false;
    let paused = false;
    tcp.once('connect', () => { connected = true; });
    tcp.on('data', data => {
      if (socket.readyState !== 1) return;
      if (socket.bufferedAmount > maxTcpBuffer) {
        socket.close(1013, 'Desktop stream is congested');
        return;
      }
      socket.send(data, { binary: true });
    });
    tcp.once('error', error => {
      if (socket.readyState === 1) socket.close(1011, String(error.message).slice(0, 100));
    });
    tcp.once('close', () => {
      if (socket.readyState === 1 && connected) socket.close(1000, 'Desktop stream closed');
    });
    socket.on('message', data => {
      if (tcp.destroyed) return;
      const ok = tcp.write(asBuffer(data));
      if (tcp.writableLength > maxTcpBuffer) {
        socket.close(1013, 'Desktop input is congested');
        tcp.destroy();
        return;
      }
      if (!ok && !paused) {
        paused = true;
        try { socket.pause(); } catch { /* already closed */ }
        tcp.once('drain', () => {
          paused = false;
          try { socket.resume(); } catch { /* already closed */ }
        });
      }
    });
    socket.once('close', () => tcp.destroy());
    socket.once('error', () => tcp.destroy());
    void req;
  });

  function reject(socket, status, reason) {
    inflight.delete(socket);
    if (socket.destroyed) return;
    try { socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`); } catch { /* gone */ }
    socket.destroy();
  }

  return {
    sockets, wayvnc,
    inflight,
    async handleUpgrade(req, socket, head) {
      if (stopping) { reject(socket, 503, 'Service Unavailable'); return; }
      inflight.add(socket);
      const dropped = () => {
        if (!inflight.delete(socket)) return;
        scheduleIdleStop();
      };
      socket.once('close', dropped);
      socket.once('error', dropped);
      try {
        const desktop = await ensure();
        if (stopping || socket.destroyed || !desktop.ready || desktop.owned === false) {
          if (!socket.destroyed) reject(socket, 503, 'Service Unavailable');
          else inflight.delete(socket);
          scheduleIdleStop();
          return;
        }
        inflight.delete(socket);
        sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req));
      } catch {
        if (!socket.destroyed) reject(socket, 503, 'Service Unavailable');
        else inflight.delete(socket);
        scheduleIdleStop();
      }
    },
    async release() {
      cancelIdle();
      for (const client of [...sockets.clients]) {
        try { client.close(1000, 'desktop closed'); } catch { /* already gone */ }
      }
      if (startPromise) await startPromise.catch(() => wayvnc.status());
      await wayvnc.stop();
    },
    async close() {
      stopping = true;
      cancelIdle();
      for (const socket of [...inflight]) reject(socket, 503, 'Service Unavailable');
      inflight.clear();
      await wayvnc.stop();
      if (startPromise) await startPromise.catch(() => wayvnc.status());
      for (const client of sockets.clients) client.close(1001, 'desktop stopping');
      await new Promise(resolve => sockets.close(() => resolve()));
    },
  };
}

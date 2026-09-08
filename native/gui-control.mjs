#!/usr/bin/env node
// Fire a harness command with no UI. Used by the agent:
//   node native/gui-control.mjs capture phone
//   node native/gui-control.mjs desktop-open
import { WebSocket } from 'ws';

const [type, client] = process.argv.slice(2);
if (!type) {
  console.error('usage: node native/gui-control.mjs <command> [phone|desktop|all]');
  process.exit(2);
}
const host = process.env.LOCUS_SITE_HOST || '127.0.0.1';
const port = process.env.LOCUS_SITE_PORT || '5057';
const url = `ws://${host}:${port}/pi`;
const ws = new WebSocket(url, { headers: { Host: `${host}:${port}` } });
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
const pending = new Map();
ws.on('message', raw => {
  const message = JSON.parse(raw);
  if (message.type === 'response') pending.get(message.id)?.(message);
});
const send = (id, payload) => new Promise(resolve => {
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, ...payload }));
});
const response = await send('1', { type, ...(client ? { client } : {}) });
ws.close();
if (!response.success) {
  console.error(response.error);
  process.exit(1);
}
if (response.data !== undefined) console.log(JSON.stringify(response.data, null, 2));

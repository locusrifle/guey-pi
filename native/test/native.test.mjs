import { test } from 'node:test';
import { get } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once, EventEmitter } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { WebSocket } from 'ws';
import { SessionManager } from '../pi-sdk.mjs';
import { createRuntime } from '../runtime.mjs';
import { createExtensionUI } from '../extension-ui.mjs';
import { createGueyServer, privateHost } from '../../server.mjs';
import { tuiThemeCss } from '../tui-theme.mjs';

// A truthful stand-in for a running TUI: live pid, 0600 advert, real 0600 socket.
async function fakeTui(runtimeDir, fields, pid = process.pid) {
	const socketPath = join(runtimeDir, `${pid}.sock`);
	const json = join(runtimeDir, `${pid}.json`);
	const server = createNetServer();
	await new Promise(r => server.listen(socketPath, r));
	await chmod(socketPath, 0o600);
	await writeFile(json, JSON.stringify({ id: `tui-${pid}`, kind: 'tui', pid, socketPath, startedAt: new Date().toISOString(), ...fields }), { mode: 0o600 });
	return { async close() { await rm(json, { force: true }); await new Promise(r => server.close(r)); await rm(socketPath, { force: true }); } };
}

function client(url, options) {
  const ws = new WebSocket(url, options); let id = 0;
  const inbox = [], waiters = [];
  ws.on('message', data => { const message=JSON.parse(data); inbox.push(message); for(const f of [...waiters]) f(); });
  function wait(predicate) {
    return new Promise((resolve,reject) => {
      const timer=setTimeout(()=>{waiters.splice(waiters.indexOf(check),1);reject(new Error('WS timeout'));},10000);
      function check(){const i=inbox.findIndex(predicate);if(i>=0){clearTimeout(timer);waiters.splice(waiters.indexOf(check),1);resolve(inbox.splice(i,1)[0]);}}
      waiters.push(check);check();
    });
  }
  return { ws, wait, async command(type, fields={}) { const request=String(++id);ws.send(JSON.stringify({id:request,type,...fields}));return wait(m=>m.type==='response'&&m.id===request); } };
}

test('private bind and extension dialogs reject bad/expired responses; abort and timeout resolve safely', async () => {
  for(const host of ['0.0.0.0','::','192.168.1.2','8.8.8.8','100.128.0.1']) assert.equal(privateHost(host),false);
  for(const host of ['127.0.0.1','::1','100.98.240.45']) assert.equal(privateHost(host),true);
  const a=createExtensionUI(()=>{});
  const p=a.ui.select('Pick',['a','b']); const id=a.state.dialogs[0].id;
  assert.throws(()=>a.respond({id,value:'not an option'}),/Invalid/);
  a.respond({id,value:'b'});assert.equal(await p,'b');assert.throws(()=>a.respond({id,value:'b'}),/expired/);
  const ac=new AbortController(); const q=a.ui.confirm('Allow','?',{signal:ac.signal}); ac.abort();assert.equal(await q,false);
  assert.equal(await a.ui.input('Timeout','',{timeout:5}),undefined);
  const r=a.ui.editor('Edit','draft');a.reset();assert.equal(await r,undefined);
  a.ui.pasteToEditor('not submitted');assert.equal(a.state.editor.paste,true);
});

test('supported SDK loads skills/extensions, dispatches commands and replaces/resumes without writing external archives', async () => {
  const root=await mkdtemp(join(tmpdir(),'guey-sdk-test-'));const agent=join(root,'agent'),cwd=join(root,'work'),stateDir=join(root,'store');
  await mkdir(join(agent,'skills','fixture'),{recursive:true});await mkdir(join(agent,'extensions'),{recursive:true});await mkdir(cwd);
  await writeFile(join(agent,'skills','fixture','SKILL.md'),'---\nname: fixture\ndescription: deterministic test skill\n---\nTest skill.');
  await writeFile(join(agent,'extensions','fixture.ts'),`export default function(pi) {
    pi.registerCommand('fixture', {handler:async(_args,ctx)=>{ctx.ui.notify('fixture command ran');}});
    pi.registerCommand('fixture-dialog', {handler:async(_args,ctx)=>{const answer=await ctx.ui.confirm('Fixture question','Proceed?');ctx.ui.notify('answer:'+answer);}});
    pi.on('session_start',(_e,ctx)=>ctx.ui.setStatus('fixture','loaded'));
  }`);
  const sessionDir=join(stateDir,'sessions');
  const runtimeDir=join(root,'runtime');await mkdir(runtimeDir,{recursive:true,mode:0o700});
  const host=await createRuntime({cwd,agentDir:agent,stateDir,sessionDir,runtimeDir});
  try {
    assert.ok(host.snapshot().resources.skills.includes('fixture'));assert.ok(host.snapshot().resources.extensions.some(e=>e.endsWith('fixture.ts')));
    assert.equal(host.snapshot().ui.statuses.fixture,'loaded');
    assert.equal((await host.command({type:'prompt',text:'/fixture'})).accepted,true);
    assert.equal(host.snapshot().ui.notifications.at(-1).message,'fixture command ran');
    const prompt=host.command({type:'prompt',text:'/fixture-dialog'});
    await new Promise(r=>setTimeout(r,20));const dialog=host.snapshot().ui.dialogs[0];assert.equal(dialog.title,'Fixture question');
    await host.command({type:'dialog',dialogId:dialog.id,confirmed:true});await prompt;
    await assert.rejects(host.command({type:'prompt',text:''}),/Prompt must/);
    await assert.rejects(host.command({type:'model',provider:'invalid',modelId:'none'}),/Unknown/);
    await assert.rejects(host.command({type:'resume',path:'/etc/passwd'}),/Unknown session/);
    const original=host.snapshot().sessionId;await host.command({type:'new'});assert.notEqual(host.snapshot().sessionId,original);
    assert.equal(host.snapshot().ui.statuses.fixture,'loaded');
    // SDK fixture session, not a hand-rolled JSONL/context reconstruction.
    const external=SessionManager.create(cwd,join(agent,'sessions','fixture'));
    external.appendMessage({role:'user',content:'fixture history',timestamp:Date.now()});
    external.appendMessage({role:'assistant',content:[{type:'text',text:'saved answer'}],timestamp:Date.now(),stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    const path=external.getSessionFile();
    // Handoff: nothing holds this file, so the GUI continues it in place.
    assert.equal((await host.command({type:'sessions'})).find(r=>r.path===path).copyOnResume,false);
    await host.command({type:'resume',path});assert.equal(host.snapshot().sessionFile,path);
    assert.ok(host.snapshot().messages.some(m=>m.content?.[0]?.text==='saved answer'));

    // A second archived session: the one the GUI will be sitting in later.
    const second=SessionManager.create(cwd,join(agent,'sessions','fixture'));
    second.appendMessage({role:'user',content:'phone side',timestamp:Date.now()});
    second.appendMessage({role:'assistant',content:[{type:'text',text:'phone reply'}],timestamp:Date.now(),stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    const own=second.getSessionFile();
    await host.command({type:'new'});await host.command({type:'resume',path:own});
    assert.equal(host.snapshot().sessionFile,own);

    // A terminal holding a file changes the answer: fork, never two writers.
    const before=await readFile(path,'utf8');
    const advert=await fakeTui(runtimeDir,{sessionFile:path,sessionId:external.getSessionId(),cwd});
    try {
      const row=(await host.command({type:'sessions'})).find(r=>r.path===path);
      assert.equal(row.copyOnResume,true);assert.equal(row.liveOwner.pid,process.pid);
      await host.command({type:'resume',path});
      assert.notEqual(host.snapshot().sessionFile,path);
      assert.ok(host.snapshot().messages.some(m=>m.content?.[0]?.text==='saved answer'));
      assert.equal(await readFile(path,'utf8'),before,'the terminal-owned file must be untouched');
    } finally { await advert.close(); }

    // A terminal claiming the session we are already in stops us writing to it.
    await host.command({type:'resume',path:own});
    assert.equal(host.snapshot().takenOver,null);
    const claim=await fakeTui(runtimeDir,{sessionFile:own,sessionId:host.snapshot().sessionId,cwd},process.ppid);
    try {
      assert.equal(host.snapshot().takenOver.pid,process.ppid);
      await assert.rejects(host.command({type:'prompt',text:'/fixture'}),/is writing this session/);
    } finally { await claim.close(); }
    assert.equal(host.snapshot().takenOver,null);
    assert.equal((await host.command({type:'prompt',text:'/fixture'})).accepted,true);
  } finally { await host.close();await rm(root,{recursive:true,force:true}); }
});

test('GUI server loads user extensions from agentDir (same door as the TUI)', async () => {
  const root=await mkdtemp(join(tmpdir(),'guey-same-agent-'));const agent=join(root,'agent'),cwd=join(root,'work');
  await mkdir(join(agent,'extensions'),{recursive:true});await mkdir(cwd);
  await writeFile(join(agent,'extensions','ping.ts'),`export default function(pi) {
    pi.registerCommand('ping', {handler:async(_args,ctx)=>{ctx.ui.notify('pong');}});
  }`);
  const app=await createGueyServer({
    port:0,host:'127.0.0.1',cwd,agentDir:agent,stateDir:join(root,'store'),
    sessionDir:join(root,'store','sessions'),runtimeDir:join(root,'runtime'),liveSessions:false,
  });
  const address=await app.listen();
  try {
    const a=client(`ws://127.0.0.1:${address.port}/pi`);
    await once(a.ws,'open');
    const snap=await a.wait(m=>m.type==='snapshot');
    assert.ok(snap.data.resources.extensions.some(e=>e.endsWith('ping.ts')),'extension must load');
    assert.ok(snap.data.commands.some(c=>c.name==='ping'),'command must be on the snapshot the GUI renders');
    a.ws.close();
  } finally { await app.close(); await rm(root,{recursive:true,force:true}); }
});

test('HTTP/WS failures, independent browsers, reconnect and store ownership', async () => {
  const root=await mkdtemp(join(tmpdir(),'guey-http-test-'));
  let closed=false,aborts=0,runs=0;
  const events=new EventEmitter();const data={cwd:root,sessionId:'test',busy:false,messages:[]};
  const runtime={events,snapshot:()=>data,async command(c){if(c.type==='prompt'){runs++;data.busy=true;events.emit('change');setTimeout(()=>{data.messages.push({role:'assistant',content:'survived disconnect'});data.busy=false;events.emit('change');},80);return {accepted:true};}if(c.type==='abort'){aborts++;return;}throw new Error('Unsupported command');},async close(){closed=true;}};
  const app=await createGueyServer({port:0,stateDir:root,runtime,origins:['https://proxy.example.net']});const address=await app.listen();const base=`http://127.0.0.1:${address.port}`,url=base.replace('http','ws')+'/pi';
  try {
    assert.equal((await fetch(base+'/health')).status,200);
    assert.equal((await fetch(base+'/%zz')).status,400);
    assert.equal((await fetch(base+'/vendor/xterm.js')).status,404);
    assert.equal((await fetch(base+'/%2e%2e%2fpackage.json')).status,404);
    assert.equal((await fetch(base,{headers:{Origin:'https://evil.example'}})).status,403);
    assert.equal(await new Promise(resolve => get(base,{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);})),403);
    // Reached through a reverse proxy that forwards its own name (tailscale
    // serve): the page, and the socket the page then opens, must both pass.
    const viaHost=(headers)=>new Promise(resolve=>get(base,{headers},res=>{res.resume();resolve(res.statusCode);}));
    assert.equal(await viaHost({Host:'proxy.example.net'}),200);
    assert.equal(await viaHost({Host:'proxy.example.net:443'}),200);
    assert.equal(await viaHost({Host:'proxy.example.net',Origin:'https://proxy.example.net'}),200);
    assert.equal(await viaHost({Host:'proxy.example.net',Origin:'https://evil.example'}),403);
    // Trusting a proxy name must not trust a stray port on our own bind.
    assert.equal(await viaHost({Host:`127.0.0.1:${address.port+1}`}),403);
    const proxied=new WebSocket(url,{headers:{Host:'proxy.example.net'},origin:'https://proxy.example.net'});
    await once(proxied,'open');proxied.close();
    const body=await (await fetch(base,{headers:{Origin:'https://evil.example'}})).text();
    assert.match(body,/Rejected Host/);
    await assert.rejects(createGueyServer({port:0,stateDir:root,runtime}),/owned/);
    const hostile=new WebSocket(url,{origin:'https://evil.example'});hostile.on('error',()=>{});const [error]=await once(hostile,'error');assert.match(error.message,/403/);
    const a=client(url);await once(a.ws,'open');await a.wait(m=>m.type==='snapshot');
    a.ws.send('not JSON');assert.equal((await a.wait(m=>m.type==='response')).success,false);
    assert.equal((await a.command('unknown')).success,false);
    assert.equal((await a.command('prompt',{text:'work'})).success,true);a.ws.close();
    await new Promise(r=>setTimeout(r,140));
    assert.equal(closed,false);assert.equal(aborts,0);assert.equal(runs,1);
    const b=client(url);await once(b.ws,'open');const snap=await b.wait(m=>m.type==='snapshot');assert.equal(snap.data.messages[0].content,'survived disconnect');b.ws.close();
    const gone=new WebSocket(base.replace('http','ws')+'/dictate');gone.on('error',()=>{});
    assert.match((await once(gone,'error'))[0].message,/403/);
  } finally {await app.close();await rm(root,{recursive:true,force:true});}
});

test('hello tags a client; capture writes a png; missing client fails', async () => {
  const root=await mkdtemp(join(tmpdir(),'guey-view-'));
  const events=new EventEmitter();
  const runtime={events,snapshot:()=>({sessionId:'t',messages:[]}),async command(){throw new Error('Unsupported command');},async close(){}};
  const app=await createGueyServer({port:0,stateDir:root,runtime});const address=await app.listen();
  const url=`ws://127.0.0.1:${address.port}/pi`;
  const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  try {
    const a=client(url);await once(a.ws,'open');
    const snap=await a.wait(m=>m.type==='snapshot');
    assert.ok(snap.data.controls.some(row=>row.id==='capture'&&row.where==='client'));
    assert.equal((await a.command('capture',{client:'phone'})).success,false);
    a.ws.on('message', raw => {
      const m=JSON.parse(raw);
      if (m.type==='control' && m.name==='capture') a.ws.send(JSON.stringify({id:m.id,type:'control-result',mime:'image/png',data:pixel,width:1,height:1}));
    });
    assert.equal((await a.command('hello',{kind:'phone',width:390,height:844,dpr:2})).data.kind,'phone');
    const shot=await a.command('capture',{client:'phone'});
    assert.equal(shot.success,true);
    assert.equal(shot.data.files[0].kind,'phone');
    const png=await readFile(shot.data.files[0].path);
    assert.equal(png[0],0x89);
    assert.equal((await a.command('capture',{client:'desktop'})).success,false);
  } finally {await app.close();await rm(root,{recursive:true,force:true});}
});

test('TUI theme css is served and a settings.json change bumps the snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-theme-'));
  const agent = join(root, 'agent');
  await mkdir(join(agent, 'themes'), { recursive: true });
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ theme: 'garden' }));
  await writeFile(join(agent, 'themes', 'garden.json'), JSON.stringify({
    name: 'garden',
    vars: { orange: '#f27722', text: '#d9dfe2' },
    colors: { accent: 'orange', text: 'text' },
    export: { pageBg: '#24292c', cardBg: '#32383c' },
  }));
  const events = new EventEmitter();
  const runtime = { events, snapshot: () => ({ sessionId: 't', messages: [] }), async command() {}, async close() {} };
  const app = await createGueyServer({ port: 0, stateDir: join(root, 'store'), runtime, agentDir: agent });
  const address = await app.listen();
  try {
    const css = await fetch(`http://127.0.0.1:${address.port}/theme.css`).then(r => r.text());
    assert.match(css, /--tui-accent: #f27722/);
    const a = client(`ws://127.0.0.1:${address.port}/pi`);
    await once(a.ws, 'open');
    const snap = await a.wait(m => m.type === 'snapshot');
    assert.equal(snap.data.theme, 'garden');
    const rev = snap.data.themeRev;
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ theme: 'dark' }));
    const next = await a.wait(m => m.type === 'snapshot' && m.data.themeRev !== rev);
    assert.equal(next.data.theme, 'dark');
    a.ws.close();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('port 0 stays on loopback even when the live bind env is set', async () => {
  const previous = { host: process.env.LOCUS_SITE_HOST, port: process.env.LOCUS_SITE_PORT };
  process.env.LOCUS_SITE_HOST = '100.98.240.45';
  process.env.LOCUS_SITE_PORT = '5057';
  const root = await mkdtemp(join(tmpdir(), 'guey-bind-'));
  const events = new EventEmitter();
  const runtime = { events, snapshot: () => ({ sessionId: 't', messages: [] }), async command() {}, async close() {} };
  let app;
  try {
    app = await createGueyServer({ port: 0, stateDir: root, runtime });
    const address = await app.listen();
    assert.equal(address.address, '127.0.0.1');
    assert.notEqual(address.port, 5057);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/health`)).status, 200);
  } finally {
    if (previous.host === undefined) delete process.env.LOCUS_SITE_HOST; else process.env.LOCUS_SITE_HOST = previous.host;
    if (previous.port === undefined) delete process.env.LOCUS_SITE_PORT; else process.env.LOCUS_SITE_PORT = previous.port;
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('auto light/dark follows the OS scheme without a personal theme', async () => {
  const auto = await tuiThemeCss('light/dark', join(tmpdir(), 'no-such-agent'));
  assert.match(auto, /prefers-color-scheme: light/);
  assert.match(auto, /prefers-color-scheme: dark/);
});

test('theme command previews without writing, persist saves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-theme-pick-'));
  const agent = join(root, 'agent');
  await mkdir(join(agent, 'themes'), { recursive: true });
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ theme: 'dark' }));
  await writeFile(join(agent, 'themes', 'garden.json'), JSON.stringify({
    name: 'garden', vars: { orange: '#f27722', text: '#d9dfe2' }, colors: { accent: 'orange', text: 'text' }, export: { pageBg: '#24292c' },
  }));
  const events = new EventEmitter();
  const runtime = { events, snapshot: () => ({ sessionId: 't', messages: [] }), async command() {}, async close() {} };
  const app = await createGueyServer({ port: 0, stateDir: join(root, 'store'), runtime, agentDir: agent });
  const address = await app.listen();
  try {
    const a = client(`ws://127.0.0.1:${address.port}/pi`);
    await once(a.ws, 'open');
    const listed = await a.command('themes');
    assert.ok(listed.data.names.includes('garden'));
    assert.equal(listed.data.saved, 'dark');
    const preview = await a.command('theme', { name: 'garden' });
    assert.equal(preview.data.theme, 'garden');
    assert.equal(preview.data.saved, 'dark');
    assert.match(await fetch(`http://127.0.0.1:${address.port}/theme.css`).then(r => r.text()), /--tui-accent: #f27722/);
    assert.equal(JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8')).theme, 'dark');
    const saved = await a.command('theme', { name: 'garden', persist: true });
    assert.equal(saved.data.saved, 'garden');
    assert.equal(JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8')).theme, 'garden');
    a.ws.close();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { createGueyServer } from '../../server.mjs';

// A real browser against the real server, with a scripted runtime in place of a
// model: the frontend contract, not the agent, is what this file proves.
function browserPath() {
	const bundled = chromium.executablePath();
	if (existsSync(bundled)) return undefined; // playwright's own download
	for (const path of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable']) if (existsSync(path)) return path;
	return null;
}

function waitForCommand(runtime, predicate) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { clearInterval(poll); reject(new Error('No matching command reached the runtime')); }, 10000);
		const poll = setInterval(() => {
			const found = runtime.sent.find(predicate);
			if (found) { clearInterval(poll); clearTimeout(timer); resolve(found); }
		}, 10);
	});
}

function scriptedRuntime(cwd) {
	const events = new EventEmitter();
	const data = {
		sessionId: 'browser-test', sessionFile: join(cwd, 'session.jsonl'), cwd, name: 'browser',
		model: { id: 'fixture-model', provider: 'fixture', name: 'Fixture', contextWindow: 1000 }, thinkingLevel: 'off',
		busy: false, operation: null, failed: null, commands: [], messages: [], partial: null, runningTools: [],
		queue: { steering: [], followUp: [] }, stats: { tokens: { total: 12, input: 1200, output: 300, cacheRead: 4000, cacheWrite: 0 }, cost: 0.5, contextUsage: { tokens: 80, contextWindow: 1000, percent: 8 } },
		ui: { dialogs: [], statuses: {}, widgets: {}, notifications: [], editor: null },
		resources: { skills: ['fixture'], extensions: [], tools: ['bash'] }, diagnostics: [],
	};
	const changed = () => events.emit('change');
	const sent = [];
	const runtime = {
		events, sent, data, snapshot: () => data,
		async command(c) {
			sent.push(c);
			switch (c.type) {
				case 'prompt':
					if (c.behavior === 'steer') {
						data.queue.steering.push(c.text); changed();
						return { accepted: true };
					}
					if (c.behavior === 'followUp') {
						data.queue.followUp.push(c.text); changed();
						return { accepted: true };
					}
					data.messages.push({
						role: 'user',
						content: [{ type: 'text', text: c.text }, ...(Array.isArray(c.images) ? c.images : [])],
						timestamp: Date.now(),
					});
					data.busy = true; changed();
					return { accepted: true };
				case 'abort': {
					const queue = data.queue; data.queue = { steering: [], followUp: [] }; data.busy = false; changed();
					return queue;
				}
				case 'dequeue': {
					const queue = data.queue; data.queue = { steering: [], followUp: [] }; changed();
					return queue;
				}
				case 'sessions': return [
					{ id: 'own', path: join(cwd, 'own.jsonl'), cwd, name: 'Own session', modified: Date.now(), messageCount: 2, copyOnResume: false },
					{ id: 'ext', path: '/elsewhere/live.jsonl', cwd: '/elsewhere', firstMessage: 'terminal session', modified: Date.now(), messageCount: 9, copyOnResume: true, liveOwner: { pid: 4242, startedAt: new Date().toISOString() } },
				];
				case 'models': return [{ provider: 'fixture', id: 'fixture-model', name: 'Fixture' }];
				case 'name': data.name = c.name; changed(); return;
				case 'attach': data.live = { pid: c.pid, connected: true, closed: false, waiting: null }; changed(); return { pid: c.pid };
				case 'detach': delete data.live; changed(); return;
				case 'new': data.messages = []; data.sessionId = 'fresh'; changed(); return;
				default: throw new Error(`Unsupported command: ${c.type}`);
			}
		},
		async close() {},
	};
	return runtime;
}

test('a real browser drives the harness: streaming, tools, dialogs, slash commands, watching and reconnect', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-test-'));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime });
	const address = await app.listen();
	const base = `http://127.0.0.1:${address.port}`;
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	const crashes = [];
	page.on('pageerror', e => crashes.push(e.message));
	try {
		await page.goto(base);
		// The design system has to actually arrive: a missing stylesheet still renders.
		await page.waitForFunction(() => getComputedStyle(document.body).fontFamily.includes('Commit Mono'));
		await page.emulateMedia({ colorScheme: 'light' });
		assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(18, 18, 18)');
		await page.emulateMedia({ colorScheme: 'dark' });
		assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(18, 18, 18)');
		const themeCss = await page.evaluate(async () => (await fetch('/theme.css')).text());
		assert.match(themeCss, /--tui-accent:/);
		assert.match(await page.getAttribute('#tui-theme', 'href'), /theme\.css/);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		assert.match(await page.textContent('#entry-pi-label'), /fixture-model/);
		assert.match(await page.textContent('#entry-spend'), /\$0\.500/);
		assert.equal(await page.evaluate(() => document.getElementById('terminal-entry').classList.contains('open')), false);
		assert.equal(await page.locator('#entry-hint').count(), 0);
		await page.keyboard.press('Alt+h');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		assert.equal(await page.isVisible('.drop-handle'), true);

		// Sending: the prompt reaches the runtime and the composer clears.
		await page.fill('#entry-input', 'hello pi');
		await page.press('#entry-input', 'Enter');
		await page.waitForSelector('.entry-line.user:has-text("hello pi")');
		assert.equal(await page.inputValue('#entry-input'), '');
		const prompt = runtime.sent.find(c => c.type === 'prompt');
		assert.equal(prompt?.text, 'hello pi');

		// Streaming partial, a running tool, then the settled transcript.
		runtime.data.partial = { role: 'assistant', content: [{ type: 'thinking', thinking: 'weighing it' }, { type: 'text', text: 'partial ans' }] };
		runtime.data.runningTools = [{ toolCallId: 't1', toolName: 'bash', args: { command: 'ls' }, result: { content: [{ type: 'text', text: 'a\nb' }] } }];
		runtime.data.busy = true; runtime.data.operation = 'working';
		runtime.events.emit('change');
		await page.waitForSelector('.entry-line.assistant:has-text("partial ans")');
		await page.waitForSelector('.entry-line.thinking:has-text("weighing it")');
		await page.waitForSelector('.entry-tool.pending .entry-tool-title:has-text("ls")');
		await page.waitForSelector('#entry-input-zone.working');

		runtime.data.partial = null; runtime.data.runningTools = [];
		runtime.data.messages.push(
			{ role: 'assistant', content: [{ type: 'text', text: 'final **answer**' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }] },
			{ role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: 'a\nb', isError: false },
		);
		runtime.data.busy = false; runtime.events.emit('change');
		await page.waitForSelector('.entry-line.assistant strong:has-text("answer")');
		await page.waitForSelector('.entry-tool.ok .entry-tool-cmd');
		assert.equal(await page.isVisible('.entry-tool.ok .entry-tool-output'), true);
		assert.match(await page.textContent('.entry-tool.ok .entry-tool-cmd'), /\$ ls/);

		// Tool output is inserted as text, never as markup.
		runtime.data.messages.push({ role: 'toolResult', toolCallId: 't2', toolName: 'read', content: '<img src=x onerror=alert(1)>', isError: false });
		runtime.events.emit('change');
		await page.waitForSelector('.entry-tool .entry-tool-title:has-text("read")');
		assert.equal(await page.evaluate(() => document.querySelectorAll('#entry-output img').length), 0);

		// Slash menu, and a command that takes an argument.
		await page.fill('#entry-input', '/na');
		await page.waitForSelector('#slash-menu .slash-name:text-is("name")');
		await page.fill('#entry-input', '/name renamed');
		await page.press('#entry-input', 'Enter');
		await waitForCommand(runtime, c => c.type === 'name' && c.name === 'renamed');
		assert.equal(runtime.data.name, 'renamed');
		assert.equal(await page.inputValue('#entry-input'), '');

		// Extension dialogs are answered in the terminal's own list style.
		runtime.data.ui.dialogs = [{ id: 'd1', method: 'select', title: 'Pick a branch', options: ['main', 'next'] }];
		runtime.events.emit('change');
		await page.waitForSelector('#entry-dialog:not([hidden]) .entry-dialog-title:has-text("Pick a branch")');
		const answered = waitForCommand(runtime, c => c.type === 'dialog');
		await page.click('.entry-dialog-option:has-text("next")');
		assert.equal((await answered).value, 'next');
		runtime.data.ui.dialogs = []; runtime.events.emit('change');

		// Watching a terminal session, from the session list.
		await page.fill('#entry-input', '/resume');
		await page.press('#entry-input', 'Enter');
		await page.waitForSelector('.entry-dialog-option:has-text("terminal session")');
		const watch = waitForCommand(runtime, c => c.type === 'attach');
		await page.click('.entry-dialog-option:has-text("▶")');
		assert.equal((await watch).pid, 4242);
		await page.waitForSelector('body.watching');
		const stop = waitForCommand(runtime, c => c.type === 'detach');
		await page.fill('#entry-input', '/detach');
		await page.press('#entry-input', 'Enter');
		await stop;
		await page.waitForSelector('body:not(.watching)');

		runtime.data.busy = true; runtime.data.operation = 'working'; runtime.events.emit('change');
		await page.waitForSelector('#entry-input-zone.working');
		const stopped = waitForCommand(runtime, c => c.type === 'abort');
		await page.locator('#entry-input').focus();
		await page.keyboard.press('Escape');
		await stopped;

		// Drafts survive a reload; an extension's editor pastes into that draft and never submits.
		await page.fill('#entry-input', 'kept draft');
		await page.reload();
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+h');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		assert.equal(await page.inputValue('#entry-input'), 'kept draft');
		await page.fill('#entry-input', '');
		const before = runtime.sent.length;
		runtime.data.ui.editor = { id: 'e1', text: 'dictated words', paste: true };
		runtime.events.emit('change');
		await page.waitForFunction(() => document.getElementById('entry-input').value === 'dictated words');
		assert.equal(runtime.sent.length, before, 'a pasted editor value must not submit');

		// A dropped socket reconnects, onto the transcript the runtime kept meanwhile.
		runtime.data.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'kept across the drop' }] });
		for (const ws of app.sockets.clients) ws.terminate();
		await page.waitForSelector('#entry-model-status:has-text("reconnecting")');
		await page.waitForSelector('.entry-line.assistant:has-text("kept across the drop")', { timeout: 15000 });

		assert.deepEqual(crashes, []);
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('attaching an image shows it in the composer, then in the transcript', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-attach-'));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+h');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
		await page.setInputFiles('#entry-files', { name: 'phone.png', mimeType: 'image/png', buffer: png });
		await page.waitForSelector('#entry-pending:not([hidden]) img.entry-image');
		assert.equal(await page.textContent('.entry-attach span'), '1');

		await page.click('#entry-pending .entry-pending-chip');
		await page.waitForSelector('#entry-pending', { state: 'hidden' });
		assert.equal(await page.textContent('.entry-attach span'), '+');

		await page.setInputFiles('#entry-files', { name: 'phone.png', mimeType: 'image/png', buffer: png });
		await page.waitForSelector('#entry-pending:not([hidden]) img.entry-image');
		await page.press('#entry-input', 'Enter');
		await page.waitForSelector('.entry-line.user img.entry-image');
		assert.equal(await page.isHidden('#entry-pending'), true);
		assert.equal(await page.textContent('.entry-attach span'), '+');
		const sent = runtime.sent.find(c => c.type === 'prompt' && Array.isArray(c.images));
		assert.equal(sent.text, 'See attached.');
		assert.equal(sent.images[0].type, 'image');
		assert.equal(sent.images[0].mimeType, 'image/jpeg');
		assert.ok(sent.images[0].data.length > 0);

		// Tool text that looks like markup still must not become an image.
		runtime.data.messages.push({ role: 'toolResult', toolCallId: 'xss', toolName: 'read', content: '<img src=x onerror=alert(1)>', isError: false });
		runtime.events.emit('change');
		await page.waitForSelector('.entry-tool .entry-tool-title:has-text("read")');
		assert.equal(await page.evaluate(() => document.querySelectorAll('#entry-output .entry-tool img').length), 0);
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('steering and follow-up queues show in the editor chrome', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-queue-'));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+h');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		runtime.data.busy = true; runtime.data.operation = 'working'; runtime.events.emit('change');
		await page.waitForSelector('#entry-input-zone.working');
		await page.fill('#entry-input', 'steer this way');
		await page.press('#entry-input', 'Enter');
		await page.waitForSelector('.entry-queue-line:has-text("Steering: steer this way")');
		const steered = runtime.sent.find(c => c.type === 'prompt' && c.behavior === 'steer');
		assert.equal(steered.text, 'steer this way');
		await page.fill('#entry-input', 'after you finish');
		await page.locator('#entry-input').focus();
		await page.keyboard.press('Alt+Enter');
		await page.waitForSelector('.entry-queue-line:has-text("Follow-up: after you finish")');
		await page.waitForSelector('.entry-queue-hint:has-text("Alt+Up")');
		const follow = runtime.sent.find(c => c.type === 'prompt' && c.behavior === 'followUp');
		assert.equal(follow.text, 'after you finish');
		await page.keyboard.press('Alt+ArrowUp');
		await page.waitForFunction(() => document.getElementById('entry-queue')?.hidden);
		assert.match(await page.inputValue('#entry-input'), /steer this way/);
		assert.match(await page.inputValue('#entry-input'), /after you finish/);
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('swipe left on the harness opens sessions and can start a new one', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-sessions-'));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+h');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		await page.waitForSelector('#session-rail', { state: 'attached' });
		await page.evaluate(() => {
			const target = document.getElementById('entry-output') || document.getElementById('entry-terminal');
			const at = (x, type) => target.dispatchEvent(new PointerEvent(type, {
				bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', button: 0, clientX: x, clientY: 80,
			}));
			at(360, 'pointerdown');
			at(40, 'pointermove');
			at(40, 'pointerup');
		});
		await page.waitForFunction(() => document.getElementById('session-rail')?.classList.contains('open'));
		const rail = await page.textContent('#session-rail');
		assert.match(rail, /sessions/);
		assert.match(rail, /live|pid 4242|terminal session/);
		assert.equal(rail.includes('Own session'), false);
		await page.click('.session-rail-new');
		await page.waitForFunction(() => !document.getElementById('session-rail')?.classList.contains('open'));
		assert.ok(runtime.sent.some(c => c.type === 'new'));
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('compaction summary is the TUI completed box, expandable', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-compact-'));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+h');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		runtime.data.messages = [
			{ role: 'compactionSummary', tokensBefore: 250983, summary: 'Kept the session rail and garden charcoal.' },
			{ role: 'user', content: 'hello' },
		];
		runtime.events.emit('change');
		await page.waitForFunction(() => (document.querySelector('.entry-compaction')?.textContent || '').includes('[compaction]'));
		const collapsed = await page.textContent('.entry-compaction');
		assert.match(collapsed, /Compacted from 250[,\u00a0]?983 tokens/);
		assert.match(collapsed, /ctrl\+o to expand/);
		assert.equal(collapsed.includes('session rail'), false);
		await page.evaluate(() => document.querySelector('.entry-compaction-label')?.click());
		await page.waitForFunction(() => (document.querySelector('.entry-compaction')?.textContent || '').includes('session rail'));
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('theme picker arrows preview without saving, escape restores', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-theme-'));
	const agent = join(root, 'agent');
	await mkdir(join(agent, 'themes'), { recursive: true });
	await writeFile(join(agent, 'settings.json'), JSON.stringify({ theme: 'dark' }));
	const runtime = scriptedRuntime(root);
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'store'), runtime, agentDir: agent });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await page.keyboard.press('Alt+h');
		await page.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		await page.fill('#entry-input', '/theme');
		await page.press('#entry-input', 'Enter');
		await page.waitForSelector('#entry-dialog:not([hidden]) .entry-dialog-option');
		await page.keyboard.press('ArrowDown');
		await page.waitForFunction(async () => (await (await fetch('/theme.css')).text()).includes('#f27722'));
		assert.equal(JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8')).theme, 'dark');
		await page.keyboard.press('Escape');
		await page.waitForFunction(async () => !(await (await fetch('/theme.css')).text()).includes('#f27722'));
		assert.equal(JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8')).theme, 'dark');
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('desktop panel sits outside the transcript, survives rerender, and closes', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-desk-'));
	const runtime = scriptedRuntime(root);
	let starts = 0;
	const wayvnc = {
		async start() {
			starts += 1;
			return { running: false, ready: false, owned: false, error: 'test stub', host: '127.0.0.1', port: null, pid: null };
		},
		async stop() {},
		status: () => ({ running: false, ready: false, owned: false, error: 'test stub', host: '127.0.0.1', port: null, pid: null }),
	};
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime, wayvnc, desktopIdleMs: 20 });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	const page = await browser.newPage();
	try {
		await page.goto(`http://127.0.0.1:${address.port}`);
		await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		assert.equal(await page.evaluate(async () => (await fetch('/vendor/novnc/core/rfb.js')).status), 200);
		assert.equal(starts, 0, 'loading the harness must not start capture');
		await page.fill('#entry-input', '/desktop');
		await page.press('#entry-input', 'Enter');
		await page.waitForSelector('#desk-panel');
		assert.equal(await page.evaluate(() => {
			const panel = document.getElementById('desk-panel');
			return Boolean(panel) && panel.parentElement?.id === 'locus-world' && !document.getElementById('entry-output').contains(panel);
		}), true);
		assert.equal(await page.locator('#desk-panel .desk-keys').count(), 0);
		assert.equal(await page.locator('#desk-panel .desk-rotate').count(), 1);
		assert.equal(await page.locator('#desk-panel .desk-mode').count(), 1);
		const deskBox = await page.locator('#desk-panel').evaluate(n => {
			const r = n.getBoundingClientRect();
			const s = n.querySelector('.desk-screen')?.getBoundingClientRect();
			return { w: r.width, h: r.height, sw: s?.width ?? 0, sh: s?.height ?? 0 };
		});
		assert.ok(deskBox.w < 1280 - 20 && deskBox.h < 720 - 20, `desktop should be a window, got ${deskBox.w}x${deskBox.h}`);
		assert.ok(Math.abs(deskBox.w - deskBox.sw) < 3 && Math.abs(deskBox.h - deskBox.sh) < 3, `desktop surface ${deskBox.sw}x${deskBox.sh} must fill ${deskBox.w}x${deskBox.h}`);
		runtime.data.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'transcript moved' }] });
		runtime.events.emit('change');
		await page.waitForSelector('.entry-line.assistant:has-text("transcript moved")');
		assert.equal(await page.locator('#desk-panel').count(), 1, 'the panel must survive a transcript rerender');
		await page.click('#desk-panel .desk-close');
		await page.waitForSelector('#desk-panel', { state: 'detached' });

		const agent = new WebSocket(`ws://127.0.0.1:${address.port}/pi`);
		await new Promise((resolve, reject) => { agent.once('open', resolve); agent.once('error', reject); });
		const reply = (id, type) => new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${type} timed out`)), 8000);
			const onMessage = raw => {
				const message = JSON.parse(raw);
				if (message.type === 'response' && message.id === id) {
					clearTimeout(timer); agent.off('message', onMessage);
					message.success ? resolve(message) : reject(new Error(message.error));
				}
			};
			agent.on('message', onMessage);
			agent.send(JSON.stringify({ id, type, client: 'desktop' }));
		});
		const opened = reply('open-1', 'desktop-open');
		await page.waitForSelector('#desk-panel');
		assert.equal((await opened).success, true);
		const closed = reply('close-1', 'desktop-close');
		await page.waitForSelector('#desk-panel', { state: 'detached' });
		assert.equal((await closed).success, true);
		agent.close();
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('a later browser inherits the open desktop canvas without a new /desktop', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-desk-join-'));
	const runtime = scriptedRuntime(root);
	const wayvnc = {
		async start() { return { running: false, ready: false, owned: false, error: 'test stub', host: '127.0.0.1', port: null, pid: null }; },
		async stop() {},
		status: () => ({ running: false, ready: false, owned: false, error: 'test stub', host: '127.0.0.1', port: null, pid: null }),
	};
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime, wayvnc, desktopIdleMs: 20 });
	const address = await app.listen();
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	try {
		const desk = await browser.newPage();
		await desk.goto(`http://127.0.0.1:${address.port}`);
		await desk.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
		await desk.fill('#entry-input', '/desktop');
		await desk.press('#entry-input', 'Enter');
		await desk.waitForSelector('#desk-panel');
		const phone = await browser.newPage();
		await phone.goto(`http://127.0.0.1:${address.port}`);
		await phone.waitForSelector('#desk-panel');
		assert.equal(await phone.locator('#desk-panel').count(), 1);
		await desk.click('#desk-panel .desk-close');
		await phone.waitForSelector('#desk-panel', { state: 'detached' });
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

const RFB_STUB = `
export default class RFB extends EventTarget {
  constructor() {
    super();
    window.__rfbBuilt = (window.__rfbBuilt || 0) + 1;
    window.__rfbLast = this;
  }
  disconnect() {
    window.__rfbDisconnected = (window.__rfbDisconnected || 0) + 1;
    this.dispatchEvent(new CustomEvent('disconnect', { detail: { clean: true } }));
  }
  sendKey() {}
}
`;

async function deskPage(browser, base, routeBody) {
	const page = await browser.newPage();
	await page.route('**/vendor/novnc/core/rfb.js', routeBody);
	await page.goto(base);
	await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
	return page;
}

function deskAgent(port) {
	const agent = new WebSocket(`ws://127.0.0.1:${port}/pi`);
	const ready = new Promise((resolve, reject) => { agent.once('open', resolve); agent.once('error', reject); });
	const reply = (id, type) => new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${type} timed out`)), 8000);
		const onMessage = raw => {
			const message = JSON.parse(raw);
			if (message.type === 'response' && message.id === id) {
				clearTimeout(timer); agent.off('message', onMessage);
				resolve(message);
			}
		};
		agent.on('message', onMessage);
		agent.send(JSON.stringify({ id, type, client: 'desktop' }));
	});
	return { agent, ready, reply };
}

test('delayed RFB import: close does not reopen, reopen is a new instance, failures clean up', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-browser-desk-race-'));
	const runtime = scriptedRuntime(root);
	const wayvnc = {
		async start() { return { running: false, ready: false, owned: false, error: 'test stub', host: '127.0.0.1', port: null, pid: null }; },
		async stop() {},
		status: () => ({ running: false, ready: false, owned: false, error: 'test stub', host: '127.0.0.1', port: null, pid: null }),
	};
	const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime, wayvnc, desktopIdleMs: 20 });
	const address = await app.listen();
	const base = `http://127.0.0.1:${address.port}`;
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	try {
		const delayed = await deskPage(browser, base, async route => {
			await new Promise(resolve => setTimeout(resolve, 200));
			await route.fulfill({ status: 200, contentType: 'text/javascript', body: RFB_STUB });
		});
		const a = deskAgent(address.port);
		await a.ready;
		const imported = delayed.waitForRequest('**/vendor/novnc/core/rfb.js');
		const first = a.reply('o1', 'desktop-open');
		await imported;
		assert.equal((await a.reply('c1', 'desktop-close')).success, true);
		await first;
		await new Promise(resolve => setTimeout(resolve, 250));
		assert.equal(await delayed.locator('#desk-panel').count(), 0, 'close during import must not create a panel');
		assert.equal(await delayed.evaluate(() => window.__rfbBuilt || 0), 0);
		assert.equal((await a.reply('o2', 'desktop-open')).success, true);
		await delayed.waitForSelector('#desk-panel');
		assert.equal(await delayed.evaluate(() => window.__rfbBuilt), 1);
		assert.equal((await a.reply('c2', 'desktop-close')).success, true);
		await delayed.waitForSelector('#desk-panel', { state: 'detached' });
		a.agent.close();
		await delayed.close();

		const importPage = await deskPage(browser, base, route => route.abort('failed'));
		const b = deskAgent(address.port);
		await b.ready;
		assert.equal((await b.reply('o3', 'desktop-open')).success, false);
		assert.equal(await importPage.locator('#desk-panel').count(), 0);
		b.agent.close();
		await importPage.close();

		const constructPage = await deskPage(browser, base, route => route.fulfill({
			status: 200, contentType: 'text/javascript',
			body: 'export default class RFB { constructor() { throw new Error("construct failed"); } }',
		}));
		const c = deskAgent(address.port);
		await c.ready;
		assert.equal((await c.reply('o4', 'desktop-open')).success, false);
		assert.equal(await constructPage.locator('#desk-panel').count(), 0);
		c.agent.close();
		await constructPage.close();
	} finally {
		await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
	}
});

test('stock Guey is a full-window Pi shell without personal controls; locusrifle keeps them', async (t) => {
	const executablePath = browserPath();
	if (executablePath === null) return t.skip('No chromium available; run `npx playwright install chromium`');
	const root = await mkdtemp(join(tmpdir(), 'guey-product-browser-'));
	const runtime = scriptedRuntime(root);
	const stock = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'stock'), runtime, product: 'stock' });
	const personal = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'personal'), runtime, product: 'locusrifle' });
	const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
	try {
		const sAddr = await stock.listen();
		const pAddr = await personal.listen();
		const stockPage = await browser.newPage();
		const personalPage = await browser.newPage();
		await personalPage.goto(`http://127.0.0.1:${pAddr.port}`);
		await personalPage.waitForSelector('#harness-reach');
		assert.equal(await personalPage.locator('#entry-files').count(), 1);
		assert.equal(await personalPage.locator('#harness-reach').count(), 1);
		assert.equal(await personalPage.locator('#grid-keys').count(), 0);
		assert.equal(await personalPage.evaluate(() => document.getElementById('terminal-entry').classList.contains('open')), false);
		await personalPage.mouse.move(200, 8);
		await personalPage.mouse.down();
		await personalPage.mouse.move(200, 140, { steps: 8 });
		await personalPage.mouse.up();
		await personalPage.waitForFunction(() => document.getElementById('terminal-entry').classList.contains('open'));
		assert.equal(await personalPage.evaluate(() => {
			const h = document.getElementById('entry-terminal').getBoundingClientRect().height;
			return Math.abs(h - innerHeight * 0.5) < 4;
		}), true, 'harness should be half the viewport');
		await personalPage.locator('.drop-handle').hover();
		await personalPage.mouse.down();
		const handle = await personalPage.locator('.drop-handle').boundingBox();
		await personalPage.mouse.move(handle.x + handle.width / 2, handle.y - 90, { steps: 10 });
		await personalPage.mouse.up();
		await personalPage.waitForFunction(() => !document.getElementById('terminal-entry').classList.contains('open'));

		async function assertStockFills(page, size) {
			await page.setViewportSize(size);
			await page.goto(`http://127.0.0.1:${sAddr.port}`);
			await page.waitForFunction(() => (document.getElementById('entry-pi-label')?.textContent || '').includes('fixture-model'));
			const g = await page.evaluate(() => {
				const term = document.getElementById('entry-terminal');
				const status = document.querySelector('.entry-status');
				const out = document.getElementById('entry-output');
				const tr = term.getBoundingClientRect();
				const sr = status.getBoundingClientRect();
				const or = out.getBoundingClientRect();
				const model = getComputedStyle(document.getElementById('entry-pi-label'));
				return {
					vh: innerHeight, vw: innerWidth,
					termH: tr.height, termW: tr.width, termTop: tr.top,
					statusBottom: sr.bottom, outH: or.height,
					modelBorder: model.borderStyle,
				};
			});
			assert.equal(await page.locator('#entry-files').count(), 0);
			assert.equal(await page.locator('#harness-reach').count(), 0);
			assert.equal(await page.locator('#grid-keys').count(), 0);
			assert.ok(g.termTop === 0 && g.termH >= g.vh - 2, `stock terminal ${g.termH}px of ${g.vh}px at ${size.width}x${size.height}`);
			assert.ok(g.statusBottom >= g.vh - 4, `status ${g.statusBottom} not at bottom of ${g.vh}`);
			assert.ok(g.outH > g.vh * 0.4, `transcript ${g.outH} too short for ${g.vh}`);
			assert.equal(g.modelBorder, 'none');
			return g;
		}
		await assertStockFills(stockPage, { width: 1280, height: 800 });
		await assertStockFills(stockPage, { width: 390, height: 844 });
		await stockPage.fill('#entry-input', 'stock hello');
		await stockPage.press('#entry-input', 'Enter');
		await stockPage.waitForSelector('.entry-line.user:has-text("stock hello")');
		const userBox = await stockPage.locator('.entry-line.user').evaluate(n => {
			const s = getComputedStyle(n);
			return { pad: parseFloat(s.paddingLeft), margin: s.marginLeft };
		});
		assert.ok(userBox.pad >= 6, `user box padding ${userBox.pad}`);
		assert.equal(userBox.margin, '0px');

		runtime.data.partial = { role: 'assistant', content: [{ type: 'thinking', thinking: '**weighing it**' }, { type: 'text', text: 'partial ans' }] };
		runtime.data.runningTools = [{ toolCallId: 't1', toolName: 'bash', args: { command: 'ls /tmp' }, result: { content: [{ type: 'text', text: Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n') }] } }];
		runtime.data.busy = true; runtime.data.operation = 'working';
		runtime.events.emit('change');
		await stockPage.waitForSelector('.entry-line.thinking');
		await stockPage.waitForSelector('#entry-work:has-text("Working")');
		assert.equal(await stockPage.locator('#entry-output .entry-thinking').count(), 0);
		assert.equal(await stockPage.locator('#entry-output .entry-tool.question').count(), 0);
		assert.equal(await stockPage.locator('.entry-line.thinking:has-text("**")').count(), 0);
		assert.match(await stockPage.textContent('.entry-line.thinking'), /weighing it/);
		const thinkStyle = await stockPage.locator('.entry-line.thinking').evaluate(n => getComputedStyle(n).fontStyle);
		assert.equal(thinkStyle, 'italic');
		await stockPage.waitForSelector('.entry-tool.pending .entry-tool-output');
		assert.equal(await stockPage.isVisible('.entry-tool.pending .entry-tool-output'), true);
		assert.match(await stockPage.textContent('.entry-tool.pending .entry-tool-cmd'), /\$ ls \/tmp/);
		assert.match(await stockPage.textContent('.entry-tool.pending .entry-tool-output'), /earlier lines/);
		assert.equal(await stockPage.locator('#entry-output .entry-tool').count(), 1);
		assert.equal(await stockPage.locator('.entry-tool.pending[data-tool-id="t1"]').count(), 1);
		assert.doesNotMatch(await stockPage.textContent('.entry-tool.pending .entry-tool-title'), /↳|✓|✕/);

		runtime.data.partial = { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls /tmp' } }] };
		runtime.events.emit('change');
		await stockPage.waitForSelector('.entry-tool.pending[data-tool-id="t1"]');
		assert.equal(await stockPage.locator('#entry-output .entry-tool').count(), 1, 'running + toolCall must stay one display');

		runtime.data.partial = null; runtime.data.runningTools = [];
		runtime.data.messages.push(
			{ role: 'assistant', content: [{ type: 'thinking', thinking: '**done**' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls /tmp', timeout: 15 } }] },
			{ role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n'), isError: false, details: { durationMs: 2600 } },
		);
		runtime.data.busy = false; runtime.events.emit('change');
		await stockPage.waitForSelector('.entry-tool.ok .entry-tool-output');
		assert.equal(await stockPage.isVisible('.entry-tool.ok .entry-tool-output'), true);
		assert.match(await stockPage.textContent('.entry-tool.ok .entry-tool-cmd'), /\$ ls \/tmp/);
		assert.match(await stockPage.textContent('.entry-tool.ok .entry-tool-timeout'), /timeout 15s/);
		assert.match(await stockPage.textContent('.entry-tool.ok .entry-tool-meta'), /Took 2\.6s/);
		assert.equal(await stockPage.locator('#entry-output .entry-tool').count(), 1);
		assert.equal(await stockPage.locator('#entry-output .entry-tool.question').count(), 0);
		const cmdWeight = await stockPage.locator('.entry-tool.ok .entry-tool-cmd strong').evaluate(n => getComputedStyle(n).fontWeight);
		assert.ok(Number(cmdWeight) >= 600, `toolTitle should be bold, got ${cmdWeight}`);
		const outColor = await stockPage.locator('.entry-tool.ok .entry-tool-output').evaluate(n => getComputedStyle(n).color);
		assert.ok(outColor);

		const collapsed = await stockPage.textContent('.entry-tool.ok .entry-tool-output');
		assert.match(collapsed, /ctrl\+o to expand/);
		const toolBg = await stockPage.locator('.entry-tool.ok[data-tool-id="t1"]').evaluate(n => getComputedStyle(n).backgroundColor);
		assert.notEqual(toolBg, 'rgba(0, 0, 0, 0)');
		assert.match(await stockPage.textContent('#entry-spend'), /8\.0%\/1\.0k/);
		assert.doesNotMatch(await stockPage.textContent('.entry-status'), /watching pid|reconnecting/);
		assert.match(await stockPage.textContent('#entry-pi-label'), /fixture-model/);
		await stockPage.click('.entry-tool.ok .entry-tool-title');
		assert.match(await stockPage.textContent('.entry-tool.ok .entry-tool-output'), /line0/);
		assert.doesNotMatch(await stockPage.textContent('.entry-tool.ok .entry-tool-output'), /\+ to expand/);

		runtime.data.messages.push(
			{ role: 'assistant', content: [{ type: 'toolCall', id: 't-err', name: 'bash', arguments: { command: 'false' } }] },
			{ role: 'toolResult', toolCallId: 't-err', toolName: 'bash', content: 'boom', isError: true },
		);
		runtime.events.emit('change');
		await stockPage.waitForSelector('.entry-tool.error[data-tool-id="t-err"]');
		assert.match(await stockPage.textContent('.entry-tool.error .entry-tool-output'), /boom/);

		runtime.data.messages.push(
			{ role: 'assistant', content: [{ type: 'text', text: 'see `settings-io` and `` `code` `` and `read` now' }, { type: 'toolCall', id: 't-read', name: 'read', arguments: { path: '/tmp/foo.js' } }] },
			{ role: 'toolResult', toolCallId: 't-read', toolName: 'read', content: 'file body', isError: false },
			{ role: 'toolResult', toolCallId: 'orphan-1', toolName: 'read', content: 'orphan body', isError: false },
		);
		runtime.events.emit('change');
		await stockPage.waitForSelector('.entry-line.assistant code:has-text("settings-io")');
		const codeTexts = await stockPage.locator('.entry-line.assistant code').allTextContents();
		assert.deepEqual(codeTexts, ['settings-io', '`code`', 'read']);
		const codeColor = await stockPage.locator('.entry-line.assistant code').first().evaluate(n => getComputedStyle(n).color);
		const mdCode = await stockPage.evaluate(() => {
			const probe = document.createElement('span');
			probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--tui-mdCode').trim();
			document.body.append(probe);
			const color = getComputedStyle(probe).color;
			probe.remove();
			return color;
		});
		assert.equal(codeColor, mdCode);
		await stockPage.waitForSelector('.entry-tool[data-tool-id="t-read"] .entry-tool-path');
		assert.match(await stockPage.textContent('.entry-tool[data-tool-id="t-read"] .entry-tool-path'), /\/tmp\/foo\.js/);
		const pathColor = await stockPage.locator('.entry-tool[data-tool-id="t-read"] .entry-tool-path').evaluate(n => getComputedStyle(n).color);
		const accent = await stockPage.evaluate(() => {
			const probe = document.createElement('span');
			probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--tui-accent').trim();
			document.body.append(probe);
			const color = getComputedStyle(probe).color;
			probe.remove();
			return color;
		});
		assert.equal(pathColor, accent);
		await stockPage.waitForSelector('.entry-tool[data-tool-id="orphan-1"]');
		assert.equal(await stockPage.locator('.entry-tool[data-tool-id="orphan-1"]').count(), 1);
		assert.equal(await stockPage.locator('.entry-tool[data-tool-id="t1"]').count(), 1);
		assert.equal(await stockPage.locator('.entry-tool[data-tool-id="t-err"]').count(), 1);

		const titleBorder = await stockPage.locator('.entry-tool-title').first().evaluate(n => getComputedStyle(n).borderStyle);
		assert.equal(titleBorder, 'none');
		const toolBorder = await stockPage.locator('.entry-tool.ok[data-tool-id="t1"]').evaluate(n => getComputedStyle(n).borderStyle);
		assert.equal(toolBorder, 'none');

		runtime.data.busy = true; runtime.data.operation = 'compacting';
		runtime.events.emit('change');
		await stockPage.waitForSelector('#entry-work:has-text("Compacting context")');
		assert.match(await stockPage.textContent('#entry-work'), /escape to cancel/);
		runtime.data.busy = false; runtime.data.operation = null;
		runtime.events.emit('change');

		await stockPage.fill('#entry-input', '/');
		await stockPage.waitForSelector('#slash-menu:not([hidden]) .slash-item');
		const slashNames = await stockPage.locator('.slash-name').allTextContents();
		assert.deepEqual(slashNames, ['settings', 'model', 'tree', 'thinking', 'scoped-models']);
		assert.match(await stockPage.textContent('#slash-menu'), /Open settings menu/);
		assert.match(await stockPage.textContent('.slash-count'), /^\(1\/\d+\)$/);
		for (let i = 0; i < 5; i++) await stockPage.keyboard.press('ArrowDown');
		const scrolled = await stockPage.locator('.slash-name').allTextContents();
		assert.equal(scrolled.includes('settings'), false);
		assert.ok(scrolled.includes('export') || scrolled.includes('copy'), scrolled.join(','));
		assert.match(await stockPage.textContent('.slash-count'), /^\(6\/\d+\)$/);
		const slashBg = await stockPage.locator('.slash-item.active').evaluate(n => getComputedStyle(n).backgroundColor);
		assert.equal(slashBg, 'rgba(0, 0, 0, 0)');
		const slashParent = await stockPage.locator('#slash-menu').evaluate(n => n.parentElement?.id);
		assert.notEqual(slashParent, 'entry-input-zone');
		const zoneH = await stockPage.locator('#entry-input-zone').evaluate(n => n.getBoundingClientRect().height);
		assert.ok(zoneH >= 18 && zoneH < 90, `input zone ${zoneH} should match TUI editor, not swallow the list`);
		await stockPage.fill('#entry-input', '/settings');
		await stockPage.press('#entry-input', 'Enter');
		await stockPage.waitForSelector('#entry-dialog.tui-settings .tui-setting:has-text("Auto-compact")');
		const settingLabels = await stockPage.locator('.tui-setting-label').allTextContents();
		assert.deepEqual(settingLabels.slice(0, 5), ['Auto-compact', 'Auto-resize images', 'Block images', 'Skill commands', 'Show hardware cursor']);
		assert.match(await stockPage.textContent('.tui-setting-desc'), /Automatically compact context/);
		assert.match(await stockPage.textContent('#entry-dialog'), /Type to search/);
		assert.match(await stockPage.textContent('.slash-count'), /\(1\/\d+\)/);
		const inputShown = await stockPage.locator('#entry-input-zone').evaluate(n => getComputedStyle(n).display !== 'none');
		assert.equal(inputShown, true);
		await stockPage.locator('#entry-dialog').focus();
		await stockPage.keyboard.type('theme');
		await stockPage.waitForSelector('.tui-setting-label:has-text("Theme")');
		await stockPage.keyboard.press('Enter');
		await stockPage.waitForSelector('.tui-setting-heading:has-text("Theme")');
		assert.match(await stockPage.textContent('#entry-dialog'), /Automatic/);
		await stockPage.keyboard.press('Escape');
		await stockPage.waitForSelector('.tui-setting-label:has-text("Theme")');
		assert.notEqual(2, 1);
	} finally {
		await browser.close(); await stock.close(); await personal.close(); await rm(root, { recursive: true, force: true });
	}
});

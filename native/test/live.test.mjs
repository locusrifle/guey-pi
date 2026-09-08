import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../runtime.mjs';

// A stand-in for the guey-live bridge inside a running `pi`, speaking the
// protocol its own tests pin: LF JSONL, a locus.ready greeting, unicast
// responses, and locusSeq-stamped live events.
async function fakeBridge(runtimeDir, { pid = process.pid, sessionFile = '/tmp/terminal-session.jsonl', cwd = '/tmp/guey-fixture-workspace' } = {}) {
	const socketPath = join(runtimeDir, `${pid}.sock`);
	const received = [];
	let socket = null, seq = 0;
	let messages = [{ role: 'user', content: 'what is in this repo?' }];
	const server = createServer(s => {
		socket = s;
		write({ type: 'locus.ready', pi: true, cwd, source: 'tui', sessionId: 'terminal-1', sessionFile,
			capabilities: ['get_state', 'get_messages', 'get_session_stats', 'prompt', 'steer', 'abort', 'set_model', 'set_session_name'] });
		let buffer = '';
		s.on('data', chunk => {
			buffer += chunk.toString();
			let i;
			while ((i = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
				if (!line) continue;
				const cmd = JSON.parse(line); received.push(cmd);
				if (cmd.type === 'get_state') reply(cmd, { model: { id: 'gpt-5.6-sol', provider: 'openai' }, thinkingLevel: 'medium', isStreaming: true, sessionFile, sessionId: 'terminal-1', sessionName: 'laptop work', cwd });
				else if (cmd.type === 'get_messages') reply(cmd, { messages });
				else if (cmd.type === 'get_session_stats') reply(cmd, { tokens: { total: 4321 }, cost: 0.25 });
				else if (cmd.type === 'get_available_models') reply(cmd, { models: [{ provider: 'openai', id: 'gpt-5.6-sol' }] });
				else if (cmd.type === 'clear_queue') reply(cmd, { steering: ['actually stop'], followUp: [] });
				else reply(cmd, undefined);
			}
		});
		s.on('error', () => {});
	});
	await new Promise(r => server.listen(socketPath, r));
	await chmod(socketPath, 0o600);
	await writeFile(join(runtimeDir, `${pid}.json`), JSON.stringify({ id: `tui-${pid}`, kind: 'tui', pid, cwd, sessionId: 'terminal-1', sessionFile, socketPath, startedAt: new Date().toISOString() }), { mode: 0o600 });
	function write(value) { socket?.write(`${JSON.stringify(value)}\n`); }
	function reply(cmd, data) { write({ type: 'response', id: cmd.id, command: cmd.type, success: true, data }); }
	return {
		received, socketPath,
		emit(event) { write({ ...event, locusSeq: ++seq }); },
		settle(message) { messages = [...messages, message]; this.emit({ type: 'message_end', message }); this.emit({ type: 'agent_settled' }); },
		dropTerminal() { socket?.destroy(); },
		async close() { socket?.destroy(); await new Promise(r => server.close(r)); await rm(join(runtimeDir, `${pid}.json`), { force: true }); await rm(socketPath, { force: true }); },
	};
}

const settles = async (host, predicate, why) => {
	for (let i = 0; i < 200; i++) { if (predicate(host.snapshot())) return; await new Promise(r => setTimeout(r, 25)); }
	assert.fail(why);
};

test('watching a terminal session: streams its turn, pushes text into it, and never claims its file', async () => {
	const root = await mkdtemp(join(tmpdir(), 'guey-live-test-'));
	const agent = join(root, 'agent'), cwd = join(root, 'work'), stateDir = join(root, 'store');
	const sessionDir = join(stateDir, 'sessions'), runtimeDir = join(root, 'runtime');
	await mkdir(agent, { recursive: true }); await mkdir(cwd, { recursive: true });
	await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const host = await createRuntime({ cwd, agentDir: agent, stateDir, sessionDir, runtimeDir });
	const bridge = await fakeBridge(runtimeDir);
	try {
		const ownSession = host.snapshot().sessionFile;

		// The terminal shows up as attachable, and attaching swaps what the GUI shows.
		const rows = await host.command({ type: 'live' });
		assert.equal(rows.length, 1); assert.equal(rows[0].pid, process.pid);
		await host.command({ type: 'attach', pid: process.pid });
		await settles(host, s => s.messages.length === 1, 'transcript never arrived');
		let snap = host.snapshot();
		assert.equal(snap.live.pid, process.pid);
		assert.equal(snap.name, 'laptop work');
		assert.equal(snap.model.id, 'gpt-5.6-sol');
		assert.equal(snap.busy, true, 'the terminal was mid-turn');
		assert.equal(snap.messages[0].content, 'what is in this repo?');
		assert.equal(snap.stats.tokens.total, 4321);

		// A turn streaming in the terminal appears here as it happens.
		bridge.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
		bridge.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } });
		bridge.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'let me look' } });
		bridge.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 1 } });
		bridge.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'It is a ' } });
		bridge.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Pi package.' } });
		await settles(host, s => s.partial?.content?.[1]?.text === 'It is a Pi package.', 'deltas never assembled');
		assert.equal(host.snapshot().partial.content[0].thinking, 'let me look');

		bridge.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } });
		bridge.emit({ type: 'tool_execution_update', toolCallId: 't1', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'README.md' }] } });
		await settles(host, s => s.runningTools[0]?.result?.content?.[0]?.text === 'README.md', 'tool progress never arrived');
		bridge.emit({ type: 'tool_execution_end', toolCallId: 't1' });
		await settles(host, s => s.runningTools.length === 0, 'finished tool still shown as running');

		// When the real message lands, the locally assembled one is dropped for it.
		bridge.settle({ role: 'assistant', content: [{ type: 'text', text: 'It is a Pi package.' }] });
		await settles(host, s => s.messages.length === 2 && !s.partial, 'settled transcript never replaced the partial');

		// Typing here reaches the terminal's agent.
		await host.command({ type: 'prompt', text: 'now run the tests' });
		await settles(host, () => bridge.received.some(c => c.type === 'prompt' && c.message === 'now run the tests'), 'prompt never reached the terminal');
		await host.command({ type: 'prompt', text: 'actually stop', behavior: 'steer' });
		await settles(host, () => bridge.received.some(c => c.type === 'steer' && c.message === 'actually stop'), 'steer never reached the terminal');
		await settles(host, s => s.queue?.steering?.includes('actually stop'), 'steer never appeared in the queue chrome');
		const pulled = await host.command({ type: 'dequeue' });
		assert.deepEqual(pulled.steering, ['actually stop']);
		assert.equal(host.snapshot().queue.steering.length, 0);
		assert.ok(bridge.received.some(c => c.type === 'clear_queue'));
		bridge.emit({ type: 'queue_update', steering: [], followUp: ['after this turn'] });
		await settles(host, s => s.queue?.followUp?.includes('after this turn') && s.queue.steering.length === 0, 'follow-up queue never arrived from the terminal');
		await host.command({ type: 'abort' });
		assert.ok(bridge.received.some(c => c.type === 'abort'));

		await host.command({ type: 'reload' });
		assert.ok(bridge.received.some(c => c.type === 'reload'));
		// Dialogs belong to the keyboard. Session switching is GUI chrome.
		await assert.rejects(host.command({ type: 'dialog' }), /belongs to the terminal/);
		assert.equal(host.snapshot().live.pid, process.pid);

		// A prompt the terminal is answering at its own keyboard is announced, not offered as a dialog.
		bridge.emit({ type: 'locus.tui_waiting', waiting: true, kind: 'select', title: 'Pick a branch' });
		await settles(host, s => Boolean(s.ui.statuses.terminal), 'terminal-waiting was not surfaced');
		assert.equal(host.snapshot().ui.dialogs.length, 0);
		bridge.emit({ type: 'locus.tui_waiting', waiting: false });

		// Detaching returns to the GUI's own session, still exactly where it was.
		await host.command({ type: 'detach' });
		assert.equal(host.snapshot().sessionFile, ownSession);
		assert.equal(host.snapshot().live, undefined);

		// If the terminal exits while watched, say so instead of pretending.
		await host.command({ type: 'attach', pid: process.pid });
		await settles(host, s => s.live?.connected, 'never reconnected');
		bridge.dropTerminal();
		await settles(host, s => s.live?.closed, 'terminal exit went unnoticed');
		assert.match(host.snapshot().failed, /ended/);
		await assert.rejects(host.command({ type: 'prompt', text: 'anyone there?' }), /terminal session ended/i);
		assert.equal(host.snapshot().sessionFile, ownSession, 'a dead terminal must drop us back on our own session');
	} finally { await bridge.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('while watching, attach switches terminals and /new leaves watch', async () => {
	const root = await mkdtemp(join(tmpdir(), 'guey-switch-watch-'));
	const agent = join(root, 'agent'), cwd = join(root, 'work'), stateDir = join(root, 'store');
	const sessionDir = join(stateDir, 'sessions'), runtimeDir = join(root, 'runtime');
	await mkdir(agent, { recursive: true }); await mkdir(cwd, { recursive: true });
	await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const host = await createRuntime({ cwd, agentDir: agent, stateDir, sessionDir, runtimeDir });
	const first = process.pid, second = process.ppid;
	const a = await fakeBridge(runtimeDir, { pid: first, sessionFile: '/tmp/a.jsonl' });
	const b = await fakeBridge(runtimeDir, { pid: second, sessionFile: '/tmp/b.jsonl' });
	try {
		await host.command({ type: 'attach', pid: first });
		await settles(host, s => s.live?.pid === first, 'never watched first terminal');
		await host.command({ type: 'attach', pid: second });
		await settles(host, s => s.live?.pid === second, 'watch did not switch');
		assert.notEqual(host.snapshot().live.pid, first);
		await host.command({ type: 'new' });
		assert.equal(host.snapshot().live, undefined);
	} finally { await a.close(); await b.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});

// A phone has no filesystem the agent can reach, so an attachment must become a
// path before the turn starts. Watching a terminal is the path the phone takes,
// and it used to drop `files` on the floor: the browser sent them, nothing wrote
// them, and the agent was told to look at an attachment that did not exist.
test('a file attached on the phone reaches a watched terminal as a path on disk', async () => {
	const root = await mkdtemp(join(tmpdir(), 'guey-live-upload-'));
	const agent = join(root, 'agent'), cwd = join(root, 'work'), stateDir = join(root, 'store');
	const runtimeDir = join(root, 'runtime');
	await mkdir(agent, { recursive: true }); await mkdir(cwd, { recursive: true });
	await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const host = await createRuntime({ cwd, agentDir: agent, stateDir, sessionDir: join(stateDir, 'sessions'), runtimeDir });
	const bridge = await fakeBridge(runtimeDir, { cwd });
	try {
		await host.command({ type: 'attach', pid: process.pid });
		await settles(host, s => s.live?.connected, 'never attached');

		await host.command({
			type: 'prompt',
			text: 'See attached.',
			files: [{ name: 'receipt.pdf', data: Buffer.from('%PDF-1.4 pretend').toString('base64') }],
		});
		await settles(host, () => bridge.received.some(c => c.type === 'prompt'), 'prompt never reached the terminal');
		const sent = bridge.received.find(c => c.type === 'prompt');
		const dest = join(cwd, 'uploads', 'receipt.pdf');
		assert.equal(sent.message, `See attached.\n\n[uploaded file: ${dest}]`);
		assert.equal(await readFile(dest, 'utf8'), '%PDF-1.4 pretend');

		// An image goes as Pi's own flat ImageContent, never Anthropic's nested
		// shape — a `source` block reaches the provider as `data:undefined` and
		// then poisons every later turn in the session file.
		await host.command({
			type: 'prompt',
			text: 'and this',
			images: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
		});
		await settles(host, () => bridge.received.filter(c => c.type === 'prompt').length === 2, 'second prompt never arrived');
		const withImage = bridge.received.filter(c => c.type === 'prompt')[1];
		assert.deepEqual(withImage.images, [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }]);
	} finally { await bridge.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('attaching refuses a terminal that is not advertising', async () => {
	const root = await mkdtemp(join(tmpdir(), 'guey-live-miss-'));
	const runtimeDir = join(root, 'runtime');
	await mkdir(join(root, 'agent'), { recursive: true }); await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const host = await createRuntime({ cwd: root, agentDir: join(root, 'agent'), stateDir: join(root, 'store'), sessionDir: join(root, 'store', 'sessions'), runtimeDir });
	try {
		await assert.rejects(host.command({ type: 'attach', pid: 999999 }), /no longer advertising/);
		assert.deepEqual(await host.command({ type: 'live' }), []);
	} finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

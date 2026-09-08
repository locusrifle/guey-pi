import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { absorbUploads } from './uploads.mjs';

async function readPiSettings() {
	try {
		const settings = JSON.parse(await readFile(join(process.env.PI_AGENT_DIR || join(homedir(), '.pi/agent'), 'settings.json'), 'utf8'));
		return {
			defaultProvider: settings.defaultProvider,
			defaultModel: settings.defaultModel,
			defaultThinkingLevel: settings.defaultThinkingLevel,
			hideThinkingBlock: Boolean(settings.hideThinkingBlock),
			compaction: settings.compaction?.enabled !== false,
			retry: settings.retry !== false && settings.retryEnabled !== false,
			steeringMode: settings.steeringMode ?? 'all',
			followUpMode: settings.followUpMode ?? 'all',
			defaultProjectTrust: settings.defaultProjectTrust ?? 'ask',
			theme: settings.theme,
		};
	} catch {
		return { compaction: true, retry: true, steeringMode: 'all', followUpMode: 'all', defaultProjectTrust: 'ask' };
	}
}

// A client of a running terminal `pi` that carries the guey-live extension.
//
// The terminal owns the session and stays its only writer. This connection
// watches: it replays the transcript, follows the turn as it streams, and can
// push text or an abort into it. It never opens the session file.
//
// The settled transcript is always re-read from the bridge (`get_messages`)
// rather than rebuilt here — Pi's own view is the truth. Only the in-flight
// assistant message is assembled locally from deltas, and it is thrown away
// the moment the real message lands.
export function connectLive({ socketPath, pid, onChange }) {
	const state = {
		pid, connected: false, closed: false, error: null, waiting: null,
		ready: null, info: null, messages: [], partial: null, runningTools: {},
		capabilities: [], commands: [], stats: null, models: null,
		queue: { steering: [], followUp: [] },
	};
	let socket = null, nextId = 0, refreshTimer = null, seen = -1;
	const pending = new Map();
	const changed = () => onChange?.();
	const setQueue = next => {
		state.queue = {
			steering: [...(next?.steering ?? [])],
			followUp: [...(next?.followUp ?? [])],
		};
	};
	const enqueue = (kind, text) => {
		const value = String(text ?? '').trim();
		if (!value || (kind !== 'steering' && kind !== 'followUp')) return;
		if (state.queue[kind].includes(value)) return;
		state.queue[kind].push(value);
		changed();
	};
	const dropQueued = text => {
		const value = String(text ?? '').trim();
		if (!value) return;
		for (const kind of ['steering', 'followUp']) {
			const index = state.queue[kind].indexOf(value);
			if (index >= 0) state.queue[kind].splice(index, 1);
		}
	};

	function decorateLiveStats(stats = {}, live = state) {
		let cacheHitRate = stats.cacheHitRate;
		for (const message of live.messages ?? []) {
			if (message?.role !== 'assistant') continue;
			const usage = message.usage ?? {};
			const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			if (prompt > 0) cacheHitRate = ((usage.cacheRead ?? 0) / prompt) * 100;
		}
		const provider = live.info?.model?.provider;
		const usingSubscription = stats.usingSubscription ?? (provider === 'kimi-coding');
		return { ...stats, cacheHitRate, usingSubscription };
	}

	const send = value => {
		if (!socket || socket.destroyed || !socket.writable) return false;
		socket.write(`${JSON.stringify(value)}\n`);
		return true;
	};

	function request(type, fields = {}) {
		const id = `guey-${++nextId}`;
		return new Promise((resolve, reject) => {
			if (!send({ id, type, ...fields })) { reject(new Error('Terminal session is not connected')); return; }
			const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Terminal did not answer ${type}`)); }, 15000);
			pending.set(id, { resolve, reject, timer });
		});
	}

	// Re-reading the whole transcript on every delta would be absurd; a short
	// debounce keeps a streaming turn to a handful of reads.
	function scheduleRefresh(delay = 250) {
		if (refreshTimer) return;
		refreshTimer = setTimeout(async () => {
			refreshTimer = null;
			try {
				const [messages, info, commands] = await Promise.all([
					request('get_messages'),
					request('get_state'),
					request('get_commands').catch(() => null),
				]);
				state.messages = messages?.messages ?? state.messages;
				state.info = info ?? state.info;
				if (Array.isArray(commands?.commands)) state.commands = commands.commands;
				if (info?.queue) setQueue(info.queue);
				try { state.stats = await request('get_session_stats'); } catch {}
				changed();
			} catch (error) { if (!state.closed) { state.error = error.message; changed(); } }
		}, delay);
	}

	function block(index, make) {
		state.partial ??= { role: 'assistant', content: [] };
		while (state.partial.content.length <= index) state.partial.content.push(null);
		state.partial.content[index] ??= make();
		return state.partial.content[index];
	}

	function apply(event) {
		// The bridge stamps a monotonic locusSeq; a gap means we missed events,
		// so fall back to the authoritative transcript rather than guessing.
		if (typeof event.locusSeq === 'number') {
			if (seen >= 0 && event.locusSeq > seen + 1) scheduleRefresh(0);
			seen = event.locusSeq;
		}
		switch (event.type) {
			case 'locus.ready':
				state.ready = event; state.capabilities = event.capabilities ?? [];
				state.connected = true; scheduleRefresh(0); return;
			case 'locus.tui_waiting':
				// The terminal is holding its own prompt open. Only the person at
				// the keyboard can answer it, so say so rather than offering a dialog.
				state.waiting = event.waiting ? { kind: event.kind, title: event.title } : null; changed(); return;
			case 'locus.session_changed':
				state.partial = null; state.runningTools = {}; scheduleRefresh(0); return;
			case 'agent_start': case 'turn_start':
				state.partial = null; changed(); return;
			case 'message_start':
				if (event.message?.role === 'assistant') state.partial = { role: 'assistant', content: [] };
				if (event.message?.role === 'user') {
					const content = event.message.content;
					const text = typeof content === 'string' ? content : (content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
					dropQueued(text);
				}
				changed(); return;
			case 'queue_update':
				setQueue(event); changed(); return;
			case 'message_end':
				state.partial = null; scheduleRefresh(); return;
			case 'agent_settled': case 'agent_end':
				state.partial = null; state.runningTools = {}; scheduleRefresh(); return;
			case 'message_update': {
				const e = event.assistantMessageEvent;
				if (!e) return;
				if (e.type === 'text_start') block(e.contentIndex, () => ({ type: 'text', text: '' }));
				else if (e.type === 'text_delta') block(e.contentIndex, () => ({ type: 'text', text: '' })).text += e.delta ?? '';
				else if (e.type === 'thinking_start') block(e.contentIndex, () => ({ type: 'thinking', thinking: '' }));
				else if (e.type === 'thinking_delta') block(e.contentIndex, () => ({ type: 'thinking', thinking: '' })).thinking += e.delta ?? '';
				else if (e.type === 'toolcall_start') block(e.contentIndex, () => ({ type: 'toolCall', id: e.id, name: e.toolName, arguments: '' }));
				else if (e.type === 'toolcall_delta') block(e.contentIndex, () => ({ type: 'toolCall', id: e.id, name: e.toolName, arguments: '' })).arguments += e.delta ?? '';
				changed(); return;
			}
			case 'tool_execution_start':
				state.runningTools[event.toolCallId] = { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }; changed(); return;
			case 'tool_execution_update':
				if (state.runningTools[event.toolCallId]) state.runningTools[event.toolCallId].result = event.partialResult;
				changed(); return;
			case 'tool_execution_end':
				delete state.runningTools[event.toolCallId]; scheduleRefresh(); return;
			case 'compaction_start': case 'compaction_end':
				scheduleRefresh(); return;
			case 'response': {
				const waiter = pending.get(event.id);
				if (!waiter) return;
				pending.delete(event.id); clearTimeout(waiter.timer);
				event.success ? waiter.resolve(event.data) : waiter.reject(new Error(event.error ?? 'Terminal refused the command'));
				return;
			}
		}
	}

	const opened = new Promise((resolve, reject) => {
		socket = net.createConnection({ path: socketPath });
		socket.setNoDelay(true);
		let buffer = '';
		const decoder = new StringDecoder('utf8');
		socket.on('data', chunk => {
			buffer += decoder.write(chunk);
			let index;
			while ((index = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, index).replace(/\r$/, '');
				buffer = buffer.slice(index + 1);
				if (!line) continue;
				let event;
				try { event = JSON.parse(line); } catch { continue; }
				try { apply(event); } catch (error) { state.error = error.message; changed(); }
				if (event.type === 'locus.ready') resolve();
			}
		});
		socket.on('error', error => { state.error = error.message; state.connected = false; reject(error); changed(); });
		socket.on('close', () => {
			state.connected = false; state.closed = true; state.partial = null; state.runningTools = {};
			for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Terminal session ended')); }
			pending.clear(); changed();
		});
		setTimeout(() => reject(new Error('Terminal did not announce itself')), 10000);
	});

	// A watched session is the terminal's. Anything that would change which
	// session is open, or answer a dialog Pi is showing in the terminal, belongs
	// to the person at that keyboard.
	const refuse = type => { throw new Error(`${type} belongs to the terminal that owns this session. Detach to run it here.`); };

	return {
		state, opened,
		snapshot() {
			const info = state.info ?? {};
			const stats = state.stats ?? {};
			return {
				sessionId: info.sessionId ?? state.ready?.sessionId, sessionFile: info.sessionFile ?? state.ready?.sessionFile,
				cwd: info.cwd ?? state.ready?.cwd, name: info.sessionName, model: info.model ?? null,
				thinkingLevel: info.thinkingLevel ?? 'off',
				busy: Boolean(info.isStreaming) || Boolean(info.isCompacting),
				operation: info.isCompacting ? 'compacting' : null,
				failed: state.closed ? `The terminal session (pid ${state.pid}) ended. Detach to work here.` : state.error,
				takenOver: null,
				live: { pid: state.pid, connected: state.connected, closed: state.closed, waiting: state.waiting, capabilities: state.capabilities },
				commands: state.commands, messages: state.messages, partial: state.partial,
				runningTools: Object.values(state.runningTools),
				queue: { steering: [...state.queue.steering], followUp: [...state.queue.followUp] },
				stats: decorateLiveStats(stats, state),
				ui: {
					dialogs: [], statuses: state.waiting ? { terminal: `The terminal is waiting for an answer at its own keyboard${state.waiting.title ? `: ${state.waiting.title}` : ''}` } : {},
					widgets: {}, notifications: [], editor: null,
				},
				resources: { skills: [], extensions: [], tools: [] },
				diagnostics: [{ type: 'info', message: `Watching a terminal session (pid ${state.pid}). It owns the file; you can send text and abort.` }],
			};
		},
		async command(c) {
			switch (c.type) {
				case 'snapshot': return this.snapshot();
				case 'prompt': {
					// Files land on disk here rather than in the bridge: this side knows
					// the session's cwd and has a filesystem, and the terminal's Pi only
					// ever needs the path.
					const cwd = state.info?.cwd ?? state.ready?.cwd ?? process.cwd();
					const message = absorbUploads(typeof c.text === 'string' ? c.text : '', c.files, cwd);
					if (!message.trim()) throw new Error('Prompt must not be empty');
					const type = c.behavior === 'followUp' ? 'follow_up' : c.behavior === 'steer' ? 'steer' : 'prompt';
					await request(type, { message, streamingBehavior: c.behavior, ...(Array.isArray(c.images) && c.images.length ? { images: c.images } : {}) });
					if (type === 'steer') enqueue('steering', message);
					else if (type === 'follow_up') enqueue('followUp', message);
					return { accepted: true };
				}
				case 'abort': await request('abort'); setQueue({ steering: [], followUp: [] }); changed(); return { steering: [], followUp: [] };
				case 'dequeue': {
					const queue = (await request('clear_queue')) ?? { steering: [], followUp: [] };
					setQueue({ steering: [], followUp: [] });
					changed();
					return queue;
				}
				case 'models': return (await request('get_available_models'))?.models ?? [];
				case 'model': await request('set_model', { provider: c.provider, modelId: c.modelId }); return;
				case 'name': await request('set_session_name', { name: c.name }); return;
				case 'compact': return request('compact', typeof c.text === 'string' && c.text ? { customInstructions: c.text } : {});
				case 'thinking': {
					if (c.level) { await request('set_thinking_level', { level: c.level }); return c.level; }
					const levels = await request('get_available_thinking_levels');
					const info = await request('get_state');
					return { current: info?.thinkingLevel, available: levels?.levels ?? levels ?? [] };
				}
				case 'copy': return (await request('get_last_assistant_text'))?.text ?? '';
				case 'session': {
					const info = await request('get_state');
					const stats = await request('get_session_stats').catch(() => null);
					return { ...info, stats };
				}
				case 'settings':
					if (c.key) return refuse(c.type);
					return readPiSettings();
				case 'reload': await request('reload'); return;
				case 'new': case 'resume': case 'dialog': return refuse(c.type);
				default: throw new Error(`Unsupported command: ${c.type}`);
			}
		},
		close() {
			state.closed = true; clearTimeout(refreshTimer); refreshTimer = null;
			socket?.destroy();
		},
	};
}

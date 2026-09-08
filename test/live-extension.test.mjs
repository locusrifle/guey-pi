import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import gueyLive, {
	SUPPORTED_COMMANDS,
	availableThinkingLevels,
	rejectReason,
	sanitizeModel,
	toRpcMessageUpdate,
} from "../extensions/guey-live/index.ts";
import { toSendUserContent } from "../extensions/guey-live/state.ts";
import { createLfFramer } from "../extensions/guey-live/jsonl.ts";
import { ensureRuntimeDir, unlinkOwn } from "../extensions/guey-live/paths.ts";
import { CumulativeDiff } from "../extensions/guey-live/stream.ts";

async function waitFor(fn, { timeout = 3000, interval = 15 } = {}) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (last) return last;
		await new Promise((r) => setTimeout(r, interval));
	}
	throw new Error(`timeout waiting: ${last}`);
}

function sessionManager(over = {}) {
	const entries = over.entries ?? [];
	return {
		getEntries: () => entries,
		buildContextEntries: () => over.branch ?? entries,
		getLeafId: () => over.leafId ?? entries.at(-1)?.id ?? null,
		getSessionId: () => over.sessionId ?? "sess-1",
		getSessionFile: () => over.sessionFile ?? "/tmp/s.jsonl",
		getSessionName: () => over.name,
		getHeader: () => ({ type: "session", id: "sess-1", cwd: over.cwd ?? "/tmp/work" }),
	};
}

function mockPi() {
	const handlers = new Map();
	const commands = new Map();
	const sent = [];
	const modelsSet = [];
	const thinking = { level: "off" };
	return {
		sent,
		handlers,
		commands,
		registerCommand(name, definition) { commands.set(name, definition); },
		thinking,
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		async emit(event, payload, ctx) {
			const list = handlers.get(event) ?? [];
			for (const handler of list) await handler(payload, ctx);
		},
		sendUserMessage(content, options) {
			sent.push({ content, options });
		},
		async setModel(model) {
			modelsSet.push(model);
			return true;
		},
		modelsSet,
		setSessionName(name) { this.name = name; },
		getSessionName() { return this.name; },
		getCommands() {
			return [{ name: "stats", description: "demo", source: "extension", sourceInfo: { path: "/tmp/ext.ts", scope: "user" } }];
		},
		getThinkingLevel() { return thinking.level; },
		setThinkingLevel(level) { thinking.level = level; },
	};
}

function mockCtx(over = {}) {
	let idle = over.idle ?? true;
	const model = over.model ?? {
		id: "m1",
		name: "Model",
		provider: "demo",
		api: "openai-completions",
		reasoning: true,
		headers: { Authorization: "Bearer SECRET" },
		apiKey: "sk-secret",
		baseUrl: "http://example.invalid",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
	return {
		mode: over.mode ?? "tui",
		cwd: over.cwd ?? "/tmp/work",
		model,
		thinkingLevel: over.thinkingLevel ?? "off",
		isIdle: () => idle,
		setIdle(value) { idle = value; },
		abort() { over.onAbort?.(); if (!over.keepBusy) idle = true; },
		hasPendingMessages: () => Boolean(over.pending),
		getContextUsage: () => over.contextUsage ?? { tokens: 10, contextWindow: 1000, percent: 1 },
		modelRegistry: {
			getAvailable: () => [model],
			find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
		},
		sessionManager: over.sessionManager ?? sessionManager(over),
		ui: { notify: (...args) => { over.notices ??= []; over.notices.push(args); } },
		...over,
		model: over.model ?? model,
	};
}

async function withRuntime(fn) {
	const dir = await mkdtemp(join(tmpdir(), "guey-live-"));
	const prev = process.env.GUEY_PI_RUNTIME_DIR;
	process.env.GUEY_PI_RUNTIME_DIR = dir;
	try {
		return await fn(dir);
	} finally {
		if (prev === undefined) delete process.env.GUEY_PI_RUNTIME_DIR;
		else process.env.GUEY_PI_RUNTIME_DIR = prev;
		await rm(dir, { recursive: true, force: true });
	}
}

function collectSocket(path) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(path);
		const messages = [];
		const framer = createLfFramer((line) => messages.push(JSON.parse(line)));
		socket.on("data", (chunk) => framer.push(chunk));
		socket.once("connect", () => resolve({ socket, messages }));
		socket.once("error", reject);
	});
}

async function rpc(client, cmd, timeout = 3000) {
	const id = cmd.id ?? `t-${Math.random().toString(16).slice(2)}`;
	client.socket.write(`${JSON.stringify({ ...cmd, id })}\n`);
	return waitFor(() => client.messages.find((m) => m.type === "response" && m.id === id), { timeout });
}

describe("guey-live mocked API", () => {
	it("does not bind a socket in the factory or in non-tui modes", async () => {
		await withRuntime(async (dir) => {
			const pi = mockPi();
			gueyLive(pi);
			assert.equal(existsSync(join(dir, `${process.pid}.sock`)), false);
			const rpcCtx = mockCtx({ mode: "rpc" });
			await pi.emit("session_start", { reason: "startup" }, rpcCtx);
			assert.equal(existsSync(join(dir, `${process.pid}.sock`)), false);
			assert.equal(existsSync(join(dir, `${process.pid}.json`)), false);
		});
	});

	it("advertises a 0600 socket and 0700 runtime dir, then cleans only its own files", async () => {
		await withRuntime(async (dir) => {
			writeFileSync(join(dir, "999999.json"), "{}\n");
			const pi = mockPi();
			gueyLive(pi);
			const ctx = mockCtx();
			await pi.emit("session_start", { reason: "startup" }, ctx);
			const sock = join(dir, `${process.pid}.sock`);
			const json = join(dir, `${process.pid}.json`);
			await waitFor(() => existsSync(sock) && existsSync(json));
			assert.equal(lstatSync(dir).mode & 0o777, 0o700);
			assert.equal(lstatSync(json).mode & 0o777, 0o600);
			const ad = JSON.parse(readFileSync(json, "utf8"));
			assert.equal(ad.id, `tui-${process.pid}`);
			assert.equal(ad.kind, "tui");
			assert.equal(ad.pid, process.pid);
			assert.equal(ad.cwd, ctx.cwd);
			assert.equal(ad.sessionId, "sess-1");
			assert.equal(ad.sessionFile, "/tmp/s.jsonl");
			assert.equal(ad.socketPath, sock);
			assert.ok(ad.startedAt);
			await pi.emit("session_shutdown", { reason: "quit" }, ctx);
			await waitFor(() => !existsSync(sock) && !existsSync(json));
			assert.equal(existsSync(join(dir, "999999.json")), true);
		});
	});

	it("refuses a symlinked runtime dir and does not delete through foreign files", async () => {
		const parent = await mkdtemp(join(tmpdir(), "guey-live-sym-"));
		const target = join(parent, "target");
		const link = join(parent, "link");
		mkdirSync(target);
		symlinkSync(target, link);
		const prev = process.env.GUEY_PI_RUNTIME_DIR;
		process.env.GUEY_PI_RUNTIME_DIR = link;
		try {
			assert.throws(() => ensureRuntimeDir(link), /symlink/);
			const planted = join(target, "nope.json");
			writeFileSync(planted, "secret");
			assert.equal(unlinkOwn(join(link, "nope.json")), false);
			assert.equal(readFileSync(planted, "utf8"), "secret");
		} finally {
			if (prev === undefined) delete process.env.GUEY_PI_RUNTIME_DIR;
			else process.env.GUEY_PI_RUNTIME_DIR = prev;
			await rm(parent, { recursive: true, force: true });
		}
	});

	it("speaks JSONL RPC, correlating ids, and announces TUI capabilities", async (t) => {
		await withRuntime(async (dir) => {
			const pi = mockPi();
			gueyLive(pi);
			const entries = [
				{ type: "message", id: "a1", parentId: null, message: { role: "user", content: "hi", timestamp: 1 } },
				{ type: "message", id: "a2", parentId: "a1", message: { role: "assistant", content: [{ type: "text", text: "yo" }], usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.5 } }, timestamp: 2 } },
			];
			const ctx = mockCtx({ entries, leafId: "a2" });
			await pi.emit("session_start", { reason: "startup" }, ctx);
			const client = await collectSocket(join(dir, `${process.pid}.sock`));
			t.after(async () => {
				client.socket.destroy();
				await pi.emit("session_shutdown", { reason: "quit" }, ctx);
			});
			const ready = await waitFor(() => client.messages.find((m) => m.type === "locus.ready"));
			assert.equal(ready.pi, true);
			assert.equal(ready.source, "tui");
			assert.equal(ready.cwd, ctx.cwd);
			assert.equal(ready.sessionId, "sess-1");
			assert.deepEqual(ready.capabilities, [...SUPPORTED_COMMANDS]);

			const state = await rpc(client, { type: "get_state" });
			assert.equal(state.success, true);
			assert.equal(state.data.model.headers, undefined);
			assert.equal(state.data.model.apiKey, undefined);
			assert.equal(state.data.model.id, "m1");
			assert.equal(state.data.isStreaming, false);
			assert.equal(state.data.cwd, ctx.cwd);

			const models = await rpc(client, { type: "get_available_models" });
			assert.equal(models.data.models[0].headers, undefined);
			assert.equal(models.data.models[0].apiKey, undefined);

			const got = await rpc(client, { type: "get_entries" });
			assert.equal(got.success, true);
			assert.equal(got.data.leafId, "a2");
			assert.equal(got.data.entries.length, 2);
			assert.deepEqual(got.data.liveEvents, []);

			const msgs = await rpc(client, { type: "get_messages" });
			assert.equal(msgs.data.messages.length, 2);

			const stats = await rpc(client, { type: "get_session_stats" });
			assert.equal(stats.data.userMessages, 1);
			assert.equal(stats.data.assistantMessages, 1);
			assert.equal(stats.data.cost, 0.5);

			const commands = await rpc(client, { type: "get_commands" });
			assert.equal(commands.data.commands[0].name, "stats");

			ctx.setIdle(false);
			const rejected = await rpc(client, { type: "prompt", message: "too soon" });
			assert.equal(rejected.success, false);

			const steered = await rpc(client, { type: "prompt", message: "now", streamingBehavior: "steer" });
			assert.equal(steered.success, true);
			assert.equal(pi.sent.at(-1).options.expandPromptTemplates, true);
			assert.equal(pi.sent.at(-1).options.deliverAs, "steer");

			ctx.setIdle(true);
			const prompt = await rpc(client, { id: "same", type: "prompt", message: "hello" });
			assert.equal(prompt.id, "same");
			assert.equal(pi.sent.at(-1).options.expandPromptTemplates, true);
			assert.equal(pi.sent.at(-1).options.deliverAs, undefined);

			const clear = await rpc(client, { type: "clear_queue" });
			assert.equal(clear.success, true);
			assert.deepEqual(clear.data, { steering: [], followUp: [] });

			for (const type of ["fork", "clone", "switch_session", "new_session", "bash"]) {
				const res = await rpc(client, { type, entryId: "a1", sessionPath: "/tmp/x", command: "echo hi" });
				assert.equal(res.success, false, type);
				assert.match(res.error, /not available|Unsupported/);
			}

			client.socket.end();
			await pi.emit("session_shutdown", { reason: "quit" }, ctx);
		});
	});

	it("forwards live events as RPC-shaped deltas and replays them after a snapshot", async () => {
		await withRuntime(async (dir) => {
			const pi = mockPi();
			gueyLive(pi);
			const ctx = mockCtx({ idle: false });
			await pi.emit("session_start", { reason: "startup" }, ctx);
			const client = await collectSocket(join(dir, `${process.pid}.sock`));
			await waitFor(() => client.messages.find((m) => m.type === "locus.ready"));
			client.messages.length = 0;

			await pi.emit("agent_start", { type: "agent_start" }, ctx);
			await pi.emit("message_start", { type: "message_start", message: { role: "assistant", content: [], timestamp: 9 } }, ctx);
			await pi.emit("message_update", {
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "Hel" }], usage: { output: 1, cost: { total: 0 } } },
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "Hel",
					partial: { role: "assistant", content: [{ type: "text", text: "Hel" }], headers: { Authorization: "nope" } },
				},
			}, ctx);

			const update = await waitFor(() => client.messages.find((m) => m.type === "message_update"));
			assert.equal(update.message, undefined);
			assert.equal(update.assistantMessageEvent.partial, undefined);
			assert.equal(update.assistantMessageEvent.delta, "Hel");
			assert.equal(JSON.stringify(update).includes("nope"), false);

			const snap = await rpc(client, { type: "get_entries" });
			assert.ok(snap.data.liveEvents.length >= 2);
			assert.equal(snap.data.liveEvents[0].type, "agent_start");
			const liveUpdate = snap.data.liveEvents.find((m) => m.type === "message_update");
			assert.equal(liveUpdate.assistantMessageEvent.partial, undefined);
			assert.equal(liveUpdate.message, undefined);

			await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
			const after = await rpc(client, { type: "get_entries" });
			assert.deepEqual(after.data.liveEvents, []);

			client.socket.end();
			await pi.emit("session_shutdown", { reason: "quit" }, ctx);
		});
	});

	it("broadcasts tui waiting and session_changed without hijacking TUI prompts", async () => {
		await withRuntime(async (dir) => {
			const pi = mockPi();
			gueyLive(pi);
			const ctx = mockCtx();
			await pi.emit("session_start", { reason: "startup" }, ctx);
			const client = await collectSocket(join(dir, `${process.pid}.sock`));
			await waitFor(() => client.messages.find((m) => m.type === "locus.ready"));
			client.messages.length = 0;
			await pi.emit("ui_prompt_start", { reason: "ui_prompt", kind: "confirm", title: "Allow?" }, ctx);
			const waiting = await waitFor(() => client.messages.find((m) => m.type === "locus.tui_waiting"));
			assert.equal(waiting.waiting, true);
			assert.equal(waiting.kind, "confirm");
			assert.equal(waiting.title, "Allow?");
			await pi.emit("model_select", { model: ctx.model, source: "set" }, ctx);
			const changed = await waitFor(() => client.messages.find((m) => m.type === "locus.session_changed"));
			assert.equal(changed.reason, "model");
			client.socket.end();
			await pi.emit("session_shutdown", { reason: "quit" }, ctx);
		});
	});

	it("stamps locusSeq on broadcasts and get_entries so overlap can be dropped", async () => {
		await withRuntime(async (dir) => {
			const pi = mockPi();
			gueyLive(pi);
			const ctx = mockCtx({ idle: false });
			await pi.emit("session_start", { reason: "startup" }, ctx);
			const first = await collectSocket(join(dir, `${process.pid}.sock`));
			await waitFor(() => first.messages.find((m) => m.type === "locus.ready"));
			first.messages.length = 0;

			await pi.emit("agent_start", { type: "agent_start" }, ctx);
			await pi.emit("message_start", { type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } }, ctx);
			await pi.emit("message_update", {
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
			}, ctx);

			const snap1 = await rpc(first, { type: "get_entries" });
			assert.equal(typeof snap1.data.eventSeq, "number");
			assert.ok(snap1.data.liveEvents.length >= 2);
			for (const event of snap1.data.liveEvents) {
				assert.equal(typeof event.locusSeq, "number");
				assert.ok(event.locusSeq <= snap1.data.eventSeq);
			}
			const streamed = first.messages.filter((m) => m.type === "message_update" || m.type === "agent_start" || m.type === "message_start");
			assert.ok(streamed.every((m) => typeof m.locusSeq === "number"));
			const overlap = streamed.filter((m) => m.locusSeq <= snap1.data.eventSeq);
			assert.ok(overlap.length >= 1);

			await pi.emit("message_update", {
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
			}, ctx);
			const after = await waitFor(() => first.messages.find((m) => m.type === "message_update" && m.assistantMessageEvent?.delta === "lo"));
			assert.ok(after.locusSeq > snap1.data.eventSeq);

			const second = await collectSocket(join(dir, `${process.pid}.sock`));
			await waitFor(() => second.messages.find((m) => m.type === "locus.ready"));
			const snap2 = await rpc(second, { type: "get_entries" });
			assert.ok(snap2.data.eventSeq >= snap1.data.eventSeq);
			assert.ok(snap2.data.liveEvents.some((m) => m.assistantMessageEvent?.delta === "Hel"));
			assert.ok(snap2.data.liveEvents.some((m) => m.assistantMessageEvent?.delta === "lo"));

			first.socket.end();
			second.socket.end();
			await pi.emit("session_shutdown", { reason: "quit" }, ctx);
		});
	});

	it("does not keep a persisted assistant in liveEvents after message_end", async () => {
		await withRuntime(async (dir) => {
			const pi = mockPi();
			gueyLive(pi);
			const user = { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hi", timestamp: 1 } };
			const assistant = {
				type: "message",
				id: "a1",
				parentId: "u1",
				message: { role: "assistant", content: [{ type: "text", text: "Hello" }], timestamp: 2 },
			};
			const entries = [user];
			const ctx = mockCtx({ idle: false, entries, leafId: "u1" });
			await pi.emit("session_start", { reason: "startup" }, ctx);
			const client = await collectSocket(join(dir, `${process.pid}.sock`));
			await waitFor(() => client.messages.find((m) => m.type === "locus.ready"));

			await pi.emit("agent_start", { type: "agent_start" }, ctx);
			await pi.emit("message_start", { type: "message_start", message: user.message }, ctx);
			await pi.emit("message_end", { type: "message_end", message: user.message }, ctx);
			const mid = await rpc(client, { type: "get_entries" });
			assert.equal(mid.data.entries.some((e) => e.id === "u1"), true);
			assert.equal(mid.data.liveEvents.some((e) => e.type === "message_end" || e.message?.role === "user"), false);

			entries.push(assistant);
			ctx.sessionManager.getLeafId = () => "a1";
			await pi.emit("message_start", { type: "message_start", message: assistant.message }, ctx);
			await pi.emit("message_update", {
				type: "message_update",
				message: assistant.message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
			}, ctx);
			const streaming = await rpc(client, { type: "get_entries" });
			assert.ok(streaming.data.liveEvents.some((e) => e.assistantMessageEvent?.delta === "Hello"));
			assert.equal(streaming.data.liveEvents.some((e) => e.message?.role === "user"), false);

			await pi.emit("message_end", { type: "message_end", message: assistant.message }, ctx);
			const afterPersist = await rpc(client, { type: "get_entries" });
			assert.equal(afterPersist.data.entries.some((e) => e.id === "a1"), true);
			assert.deepEqual(afterPersist.data.liveEvents, []);

			client.socket.end();
			await pi.emit("session_shutdown", { reason: "quit" }, ctx);
		});
	});

	it("abort is an error if the agent is still running, and shutdown does not revive ctx", async () => {
		await withRuntime(async (dir) => {
			const pi = mockPi();
			gueyLive(pi);
			const oldCtx = mockCtx({ idle: false, keepBusy: true, cwd: "/tmp/old" });
			await pi.emit("session_start", { reason: "startup" }, oldCtx);
			const client = await collectSocket(join(dir, `${process.pid}.sock`));
			await waitFor(() => client.messages.find((m) => m.type === "locus.ready"));
			client.socket.end();
			await pi.emit("session_shutdown", { reason: "quit" }, oldCtx);
			await pi.emit("agent_start", { type: "agent_start" }, oldCtx);
			assert.equal(existsSync(join(dir, `${process.pid}.sock`)), false);

			const fresh = mockCtx({ idle: true, cwd: "/tmp/fresh" });
			await pi.emit("session_start", { reason: "startup" }, fresh);
			const next = await collectSocket(join(dir, `${process.pid}.sock`));
			await waitFor(() => next.messages.find((m) => m.type === "locus.ready"));
			const prompt = await rpc(next, { type: "prompt", message: "from-new" });
			assert.equal(prompt.success, true);
			assert.equal(pi.sent.at(-1).content, "from-new");
			assert.equal(next.messages.find((m) => m.type === "locus.ready").cwd, "/tmp/fresh");
			next.socket.end();
			await pi.emit("session_shutdown", { reason: "quit" }, fresh);

			const busy = mockCtx({ idle: false, keepBusy: true });
			await pi.emit("session_start", { reason: "startup" }, busy);
			const third = await collectSocket(join(dir, `${process.pid}.sock`));
			await waitFor(() => third.messages.find((m) => m.type === "locus.ready"));
			const still = await rpc(third, { type: "abort" }, 12000);
			assert.equal(still.success, false);
			assert.match(still.error, /still running/);

			third.socket.end();
			await pi.emit("session_shutdown", { reason: "quit" }, busy);
		});
	});

	it("keeps JSONL records intact across U+2028/U+2029", async () => {
		await withRuntime(async (dir) => {
			const pi = mockPi();
			gueyLive(pi);
			await pi.emit("session_start", { reason: "startup" }, mockCtx());
			const client = await collectSocket(join(dir, `${process.pid}.sock`));
			await waitFor(() => client.messages.find((m) => m.type === "locus.ready"));
			const text = "line\u2028sep\u2029end";
			const res = await rpc(client, { type: "prompt", message: text });
			assert.equal(res.success, true);
			assert.equal(pi.sent.at(-1).content, text);
			client.socket.end();
			await pi.emit("session_shutdown", { reason: "quit" }, mockCtx());
		});
	});
});

describe("pure helpers", () => {
	it("flattens images to Pi's ImageContent whatever shape they arrive in", () => {
		const flat = toSendUserContent("look", [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
		assert.deepEqual(flat, [
			{ type: "text", text: "look" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);

		// An Anthropic-shaped block used to pass straight through and reach the
		// provider as `data:undefined;base64,undefined`.
		const nested = toSendUserContent("look", [
			{ type: "image", source: { type: "base64", mediaType: "image/jpeg", data: "BBBB" } },
		]);
		assert.deepEqual(nested, [
			{ type: "text", text: "look" },
			{ type: "image", data: "BBBB", mimeType: "image/jpeg" },
		]);
		for (const block of nested) assert.equal(block.source, undefined);

		// A block with no data is dropped, not sent as undefined.
		assert.deepEqual(toSendUserContent("look", [{ type: "image", source: { type: "base64" } }, null]), [
			{ type: "text", text: "look" },
		]);
	});

	it("strips secrets from models and names honest rejections", () => {
		const clean = sanitizeModel({ id: "x", headers: { a: "1" }, apiKey: "z", name: "ok" });
		assert.deepEqual(clean, { id: "x", name: "ok" });
		assert.match(rejectReason("clear_queue"), /Unsupported command/);
		assert.match(rejectReason("fork"), /terminal/);
		assert.match(rejectReason("bash"), /terminal/);
		assert.deepEqual(availableThinkingLevels({ reasoning: false }), ["off"]);
		assert.ok(availableThinkingLevels({ reasoning: true }).includes("high"));
		assert.ok(!availableThinkingLevels({ reasoning: true }).includes("max"));
		assert.ok(availableThinkingLevels({ reasoning: true, thinkingLevelMap: { max: "max" } }).includes("max"));
	});

	it("turns cumulative assistant payloads into frontend deltas", () => {
		const diff = new CumulativeDiff();
		const first = toRpcMessageUpdate({
			message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
		}, diff);
		assert.equal(first[0].assistantMessageEvent.type, "text_start");
		assert.equal(first[1].assistantMessageEvent.delta, "Hello");
		const second = toRpcMessageUpdate({
			message: { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
		}, diff);
		assert.equal(second[0].assistantMessageEvent.delta, "!");
		const stripped = toRpcMessageUpdate({
			usage: { output: 1 },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: { secret: true } },
		});
		assert.equal(stripped.assistantMessageEvent.partial, undefined);
		assert.equal(stripped.message, undefined);
	});
});


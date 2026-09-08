import { chmodSync, lstatSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import type { Socket } from "node:net";
import { attachJsonl, writeJsonl } from "./jsonl.ts";
import {
	cleanupOwnRuntimeFiles,
	ensureRuntimeDir,
	refuseSymlink,
	resolveRuntimeDir,
	socketPath as socketPathFor,
	unlinkOwn,
	writeAdvertisement,
	type TuiAdvertisement,
} from "./paths.ts";
import {
	SUPPORTED_COMMANDS,
	availableThinkingLevels,
	cycleThinkingLevel,
	extractMessages,
	isSupportedCommand,
	mapCommands,
	rejectReason,
	sanitizeModel,
	sessionStatsFromManager,
	toSendUserContent,
} from "./state.ts";
import { CumulativeDiff, LiveEventBuffer, rpcMessageEvent, rpcToolEvent, toRpcMessageUpdate } from "./stream.ts";

type PiLike = {
	sendUserMessage: (content: any, options?: any) => void;
	setModel: (model: any) => Promise<boolean> | boolean;
	setSessionName: (name: string) => void;
	getSessionName: () => string | undefined;
	getCommands: () => any[];
	getThinkingLevel: () => string;
	setThinkingLevel: (level: string) => void;
};

type CtxLike = {
	mode?: string;
	cwd: string;
	isIdle: () => boolean;
	abort: () => void;
	compact?: (options?: { customInstructions?: string; onComplete?: (result: unknown) => void; onError?: (error: Error) => void }) => void;
	hasPendingMessages?: () => boolean;
	getContextUsage?: () => unknown;
	thinkingLevel?: string;
	model?: any;
	modelRegistry?: { getAvailable?: () => any[]; find?: (provider: string, id: string) => any };
	modelRuntime?: { isUsingSubscription?: (provider: string) => boolean };
	scopedModels?: readonly any[];
	sessionManager?: any;
	clearQueue?: () => { steering: string[]; followUp: string[] };
	ui?: {
		notify?: (message: string, kind?: string) => void;
		setTheme?: (name: string) => { success?: boolean; error?: string } | void;
		getEditorText?: () => string;
		setEditorText?: (text: string) => void;
		getEditorComponent?: () => { handleInput?: (data: string) => void } | undefined;
	};
};

function userText(message: any): string {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content.filter((block: any) => block?.type === "text").map((block: any) => block.text ?? "").join("").trim();
}

export class TuiBridge {
	private readonly pi: PiLike;
	private ctx: CtxLike | null = null;
	private server: net.Server | null = null;
	private clients = new Set<Socket>();
	private runtimeDir: string | null = null;
	private sockPath: string | null = null;
	private startedAt: string | null = null;
	private compacting = false;
	private readonly live = new LiveEventBuffer();
	private readonly diff = new CumulativeDiff();
	private stopping = false;
	private generation = 0;
	private eventSeq = 0;
	private settingsWatch: FSWatcher | null = null;
	private lastTheme = "";
	private queued = { steering: [] as string[], followUp: [] as string[] };

	constructor(pi: PiLike) {
		this.pi = pi;
	}

	get advertisementPath(): string | null {
		if (!this.runtimeDir) return null;
		return `${this.runtimeDir}/${process.pid}.json`;
	}

	private settingsPath(): string {
		return join(process.env.PI_AGENT_DIR || join(homedir(), ".pi/agent"), "settings.json");
	}

	private watchSettingsTheme(ctx: CtxLike): void {
		this.settingsWatch?.close();
		this.settingsWatch = null;
		const path = this.settingsPath();
		const readTheme = async () => {
			try {
				const settings = JSON.parse(await readFile(path, "utf8"));
				return typeof settings.theme === "string" ? settings.theme : "";
			} catch {
				return "";
			}
		};
		void readTheme().then((name) => { this.lastTheme = name; });
		try {
			this.settingsWatch = watch(path, () => {
				void readTheme().then((name) => {
					if (!name || name === this.lastTheme) return;
					this.lastTheme = name;
					this.ctx?.ui?.setTheme?.(name);
				});
			});
		} catch {
			/* settings.json may not exist yet */
		}
	}

	async start(ctx: CtxLike): Promise<void> {
		if (ctx.mode !== "tui") return;
		if (this.server && !this.stopping) {
			this.ctx = ctx;
			this.writeAd();
			return;
		}
		await this.stop();
		this.stopping = false;
		this.generation += 1;
		const gen = this.generation;
		this.ctx = ctx;
		this.compacting = false;
		this.queued = { steering: [], followUp: [] };
		this.live.stop();
		this.diff.reset();
		this.eventSeq = 0;
		this.startedAt = new Date().toISOString();
		this.runtimeDir = ensureRuntimeDir(resolveRuntimeDir());
		this.sockPath = socketPathFor(this.runtimeDir);
		refuseSymlink(this.sockPath, "socket path");
		unlinkOwn(this.sockPath);

		const server = net.createServer((socket) => this.onConnection(socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen({ path: this.sockPath!, exclusive: true }, () => {
				server.off("error", reject);
				resolve();
			});
		});
		if (this.stopping || this.generation !== gen) {
			server.close();
			if (this.server === server) this.server = null;
			return;
		}
		this.watchSettingsTheme(ctx);
		try {
			chmodSync(this.sockPath, 0o600);
			const st = lstatSync(this.sockPath);
			if (st.isSymbolicLink()) throw new Error("socket path is a symlink");
			if ((st.mode & 0o777) !== 0o600 && (st.mode & 0o077) !== 0) {
				chmodSync(this.sockPath, 0o600);
			}
		} catch (error) {
			await this.stop();
			throw error;
		}
		this.writeAd();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.generation += 1;
		this.settingsWatch?.close();
		this.settingsWatch = null;
		this.ctx = null;
		this.live.stop();
		const clients = [...this.clients];
		this.clients.clear();
		for (const socket of clients) {
			try { socket.destroy(); } catch { /* ignore */ }
		}
		const server = this.server;
		this.server = null;
		if (server) {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				setTimeout(resolve, 200).unref?.();
			});
		}
		if (this.runtimeDir) cleanupOwnRuntimeFiles(this.runtimeDir);
		this.sockPath = null;
		this.stopping = false;
	}

	onPiEvent(type: string, event: any, ctx: CtxLike): void {
		if (this.stopping || !this.server) return;
		if (ctx?.mode && ctx.mode !== "tui") return;
		if (ctx) this.ctx = ctx;

		if (type === "session_before_compact") {
			this.compacting = true;
			this.broadcast({ type: "compaction_start", reason: event?.reason });
			this.changed("compact");
			return;
		}
		if (type === "session_compact") {
			this.compacting = false;
			this.broadcast({
				type: "compaction_end",
				reason: event?.reason,
				result: event?.compactionEntry ?? event?.result,
				aborted: false,
			});
			this.changed("compact");
			return;
		}
		if (type === "session_compact_failed") {
			this.compacting = false;
			this.broadcast({
				type: "compaction_end",
				reason: event?.reason,
				result: null,
				aborted: Boolean(event?.aborted),
				errorMessage: event?.errorMessage,
			});
			this.changed("compact");
			return;
		}
		if (type === "session_tree") {
			this.changed("tree");
			return;
		}
		if (type === "session_info_changed") {
			this.writeAd();
			this.changed("info");
			return;
		}
		if (type === "model_select") {
			this.changed("model");
			return;
		}
		if (type === "thinking_level_select") {
			this.changed("thinking");
			return;
		}
		if (type === "ui_prompt_start") {
			this.broadcast({
				type: "locus.tui_waiting",
				waiting: true,
				kind: event?.kind,
				title: event?.title,
			});
			return;
		}
		if (type === "ui_prompt_end") {
			this.broadcast({ type: "locus.tui_waiting", waiting: false });
			return;
		}
		if (type === "input") {
			const text = typeof event?.text === "string" ? event.text.trim() : "";
			if (!text) return;
			if (event?.streamingBehavior === "steer") this.queued.steering.push(text);
			else if (event?.streamingBehavior === "followUp") this.queued.followUp.push(text);
			else return;
			this.broadcastQueue();
			return;
		}
		if (type === "agent_start") {
			this.diff.reset();
			this.live.start();
			this.emitLive({ type: "agent_start" });
			return;
		}
		if (type === "agent_end") {
			this.emitLive({ type: "agent_end", messages: event?.messages, willRetry: event?.willRetry });
			return;
		}
		if (type === "agent_settled") {
			this.emitLive({ type: "agent_settled" });
			this.live.stop();
			this.diff.reset();
			return;
		}
		if (type === "turn_start") {
			this.diff.reset();
			this.emitLive({ type: "turn_start" });
			return;
		}
		if (type === "turn_end") {
			this.emitLive({ type: "turn_end", message: event?.message, toolResults: event?.toolResults });
			return;
		}
		if (type === "message_start") {
			const message = event?.message;
			if (message?.role === "user") this.dropQueued(userText(message));
			this.emitLive(rpcMessageEvent("message_start", message));
			return;
		}
		if (type === "message_end") {
			this.emitLive(rpcMessageEvent("message_end", event?.message));
			this.live.clearRecorded();
			return;
		}
		if (type === "message_update") {
			const rpc = toRpcMessageUpdate(event, this.diff);
			if (!rpc) return;
			this.emitLive(rpc);
			return;
		}
		if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
			this.emitLive(rpcToolEvent(type, event));
		}
	}

	private emitLive(event: unknown): void {
		if (Array.isArray(event)) {
			for (const item of event) this.emitLive(item);
			return;
		}
		const stamped = this.envelope(event);
		this.live.push(stamped);
		this.sendAll(stamped);
	}

	private changed(reason: string): void {
		this.broadcast({ type: "locus.session_changed", reason });
	}

	private writeAd(): void {
		if (!this.runtimeDir || !this.sockPath || !this.ctx) return;
		const sm = this.ctx.sessionManager;
		const ad: TuiAdvertisement = {
			id: `tui-${process.pid}`,
			kind: "tui",
			pid: process.pid,
			cwd: this.ctx.cwd,
			sessionId: sm?.getSessionId?.(),
			sessionFile: sm?.getSessionFile?.(),
			name: sm?.getSessionName?.() ?? this.pi.getSessionName?.(),
			socketPath: this.sockPath,
			startedAt: this.startedAt ?? new Date().toISOString(),
		};
		writeAdvertisement(`${this.runtimeDir}/${process.pid}.json`, ad);
	}

	private readyPayload(): Record<string, unknown> {
		const sm = this.ctx?.sessionManager;
		return {
			type: "locus.ready",
			pi: true,
			cwd: this.ctx?.cwd,
			capabilities: [...SUPPORTED_COMMANDS],
			source: "tui",
			sessionId: sm?.getSessionId?.(),
			sessionFile: sm?.getSessionFile?.(),
		};
	}

	private onConnection(socket: Socket): void {
		this.clients.add(socket);
		writeJsonl(socket, this.readyPayload());
		attachJsonl(socket, (line) => {
			void this.onLine(socket, line);
		});
		const drop = () => this.clients.delete(socket);
		socket.on("close", drop);
		socket.on("error", drop);
	}

	private envelope(payload: unknown): unknown {
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
		const rec = payload as Record<string, unknown>;
		if (typeof rec.locusSeq === "number") return payload;
		this.eventSeq += 1;
		return { ...rec, locusSeq: this.eventSeq };
	}

	private sendAll(payload: unknown): void {
		if (payload == null) return;
		for (const socket of this.clients) writeJsonl(socket, payload);
	}

	private broadcast(payload: unknown): void {
		if (payload == null) return;
		if (Array.isArray(payload)) {
			for (const item of payload) this.broadcast(item);
			return;
		}
		this.sendAll(this.envelope(payload));
	}

	private reply(socket: Socket, cmd: any, extra: Record<string, unknown>): void {
		writeJsonl(socket, {
			type: "response",
			id: cmd?.id,
			command: cmd?.type ?? "parse",
			...extra,
		});
	}

	private async onLine(socket: Socket, line: string): Promise<void> {
		let cmd: any;
		try {
			cmd = JSON.parse(line);
		} catch (error) {
			this.reply(socket, { type: "parse" }, { success: false, error: `Failed to parse command: ${(error as Error).message}` });
			return;
		}
		if (!cmd || typeof cmd !== "object" || typeof cmd.type !== "string") {
			this.reply(socket, { type: "parse", id: cmd?.id }, { success: false, error: "Failed to parse command: missing type" });
			return;
		}
		try {
			await this.dispatch(socket, cmd);
		} catch (error) {
			this.reply(socket, cmd, { success: false, error: (error as Error).message ?? String(error) });
		}
	}

	private async dispatch(socket: Socket, cmd: any): Promise<void> {
		const ctx = this.ctx;
		const gen = this.generation;
		if (!ctx || this.stopping) {
			this.reply(socket, cmd, { success: false, error: "TUI bridge is not attached to a session" });
			return;
		}
		if (!isSupportedCommand(cmd.type)) {
			this.reply(socket, cmd, { success: false, error: rejectReason(cmd.type) });
			return;
		}
		switch (cmd.type) {
			case "get_state":
				this.reply(socket, cmd, { success: true, data: this.getState(ctx) });
				return;
			case "get_entries": {
				const data = this.getEntries(ctx, cmd.since);
				if (data.error) {
					this.reply(socket, cmd, { success: false, error: data.error });
					return;
				}
				this.reply(socket, cmd, { success: true, data });
				return;
			}
			case "get_messages":
				this.reply(socket, cmd, { success: true, data: { messages: this.getMessages(ctx) } });
				return;
			case "get_commands":
				this.reply(socket, cmd, { success: true, data: { commands: mapCommands(this.pi.getCommands?.() ?? []) } });
				return;
			case "get_session_stats": {
				const provider = ctx.model?.provider;
				const usingSubscription = provider === "kimi-coding" || Boolean(ctx.modelRuntime?.isUsingSubscription?.(provider));
				this.reply(socket, cmd, { success: true, data: { ...sessionStatsFromManager(ctx.sessionManager, ctx.getContextUsage?.()), usingSubscription } });
				return;
			}
			case "get_available_models": {
				const models = (ctx.modelRegistry?.getAvailable?.() ?? []).map((model) => sanitizeModel(model));
				this.reply(socket, cmd, { success: true, data: { models } });
				return;
			}
			case "set_model": {
				const model = ctx.modelRegistry?.find?.(cmd.provider, cmd.modelId);
				if (!model) {
					this.reply(socket, cmd, { success: false, error: `Model not found: ${cmd.provider}/${cmd.modelId}` });
					return;
				}
				const ok = await this.pi.setModel(model);
				if (this.stopping || this.generation !== gen || this.ctx !== ctx) {
					this.reply(socket, cmd, { success: false, error: "TUI bridge is not attached to a session" });
					return;
				}
				if (!ok) {
					this.reply(socket, cmd, { success: false, error: "Model is not usable in this session" });
					return;
				}
				this.reply(socket, cmd, { success: true, data: sanitizeModel(model) });
				return;
			}
			case "get_available_thinking_levels": {
				const levels = availableThinkingLevels(ctx.model, ctx.thinkingLevel ?? this.pi.getThinkingLevel?.());
				this.reply(socket, cmd, { success: true, data: { levels } });
				return;
			}
			case "set_thinking_level": {
				const levels = availableThinkingLevels(ctx.model, ctx.thinkingLevel ?? this.pi.getThinkingLevel?.());
				if (!levels.includes(cmd.level)) {
					this.reply(socket, cmd, { success: false, error: `Unsupported thinking level: ${cmd.level}` });
					return;
				}
				this.pi.setThinkingLevel(cmd.level);
				this.reply(socket, cmd, { success: true });
				return;
			}
			case "cycle_thinking_level": {
				const current = ctx.thinkingLevel ?? this.pi.getThinkingLevel?.();
				const levels = availableThinkingLevels(ctx.model, current);
				const next = cycleThinkingLevel(levels, current);
				if (next == null) {
					this.reply(socket, cmd, { success: true, data: null });
					return;
				}
				this.pi.setThinkingLevel(next);
				this.reply(socket, cmd, { success: true, data: { level: next } });
				return;
			}
			case "set_session_name":
				this.pi.setSessionName(cmd.name);
				this.writeAd();
				this.reply(socket, cmd, { success: true });
				return;
			case "prompt":
			case "steer":
			case "follow_up":
				this.handlePrompt(socket, cmd, ctx, gen);
				return;
			case "compact": {
				if (!ctx.isIdle()) {
					this.reply(socket, cmd, { success: false, error: "Wait for the current response to finish before compacting." });
					return;
				}
				if (typeof ctx.compact !== "function") {
					this.reply(socket, cmd, { success: false, error: "Compaction is unavailable in this terminal session" });
					return;
				}
				const customInstructions = typeof cmd.customInstructions === "string" ? cmd.customInstructions : undefined;
				ctx.compact({ customInstructions });
				this.reply(socket, cmd, { success: true });
				return;
			}
			case "clear_queue": {
				const queued = this.takeQueue(ctx);
				this.reply(socket, cmd, { success: true, data: queued });
				return;
			}
			case "reload": {
				if (!ctx.isIdle()) {
					this.reply(socket, cmd, { success: false, error: "Wait for the current response to finish before reloading." });
					return;
				}
				this.reply(socket, cmd, { success: true });
				this.pi.sendUserMessage("/guey-reload");
				return;
			}
			case "abort": {
				ctx.abort();
				const deadline = Date.now() + 8000;
				while (!ctx.isIdle() && Date.now() < deadline) {
					if (this.stopping || this.generation !== gen) break;
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				if (this.stopping || this.generation !== gen || this.ctx !== ctx) {
					this.reply(socket, cmd, { success: false, error: "TUI bridge is not attached to a session" });
					return;
				}
				if (!ctx.isIdle()) {
					this.reply(socket, cmd, { success: false, error: "abort requested but agent is still running" });
					return;
				}
				this.reply(socket, cmd, { success: true });
				return;
			}
			default:
				this.reply(socket, cmd, { success: false, error: rejectReason(cmd.type) });
		}
	}

	private handlePrompt(socket: Socket, cmd: any, ctx: CtxLike, gen: number): void {
		if (this.stopping || this.generation !== gen || this.ctx !== ctx) {
			this.reply(socket, cmd, { success: false, error: "TUI bridge is not attached to a session" });
			return;
		}
		const idle = ctx.isIdle();
		let deliverAs = cmd.streamingBehavior ?? (cmd.type === "prompt" ? undefined : cmd.type === "follow_up" ? "followUp" : "steer");
		if (cmd.type === "prompt" && !idle && !deliverAs) {
			this.reply(socket, cmd, { success: false, error: "Agent is streaming; set streamingBehavior to steer or followUp" });
			return;
		}
		if (idle) deliverAs = undefined;
		else if (cmd.type === "steer") deliverAs = "steer";
		else if (cmd.type === "follow_up") deliverAs = "followUp";
		const content = toSendUserContent(cmd.message, cmd.images);
		const options: Record<string, unknown> = { expandPromptTemplates: true };
		if (deliverAs) options.deliverAs = deliverAs;
		if (this.stopping || this.generation !== gen || this.ctx !== ctx) {
			this.reply(socket, cmd, { success: false, error: "TUI bridge is not attached to a session" });
			return;
		}
		this.pi.sendUserMessage(content, options);
		this.reply(socket, cmd, { success: true });
	}

	private getState(ctx: CtxLike) {
		const sm = ctx.sessionManager;
		return {
			model: sanitizeModel(ctx.model) ?? null,
			thinkingLevel: ctx.thinkingLevel ?? this.pi.getThinkingLevel?.(),
			isStreaming: !ctx.isIdle(),
			isCompacting: this.compacting,
			sessionFile: sm?.getSessionFile?.(),
			sessionId: sm?.getSessionId?.(),
			sessionName: sm?.getSessionName?.() ?? this.pi.getSessionName?.(),
			cwd: ctx.cwd,
			messageCount: this.getMessages(ctx).length,
			hasPendingMessages: Boolean(ctx.hasPendingMessages?.()),
			queue: this.queueSnapshot(ctx),
		};
	}

	private queueSnapshot(ctx: CtxLike) {
		if (!ctx.hasPendingMessages?.()) this.queued = { steering: [], followUp: [] };
		return { steering: [...this.queued.steering], followUp: [...this.queued.followUp] };
	}

	takeQueue(ctx: CtxLike = this.ctx as CtxLike) {
		const queued = typeof ctx?.clearQueue === "function"
			? ctx.clearQueue()
			: this.queueSnapshot(ctx);
		const before = ctx?.ui?.getEditorText?.() ?? "";
		try { ctx?.ui?.getEditorComponent?.()?.handleInput?.("\x1b[1;3A"); } catch { /* editor may not take raw keys */ }
		const after = ctx?.ui?.getEditorText?.() ?? "";
		if (after !== before) ctx?.ui?.setEditorText?.(before);
		this.queued = { steering: [], followUp: [] };
		this.broadcastQueue();
		return {
			steering: [...(queued?.steering ?? [])],
			followUp: [...(queued?.followUp ?? [])],
		};
	}

	private dropQueued(text: string) {
		if (!text) return;
		const cut = (list: string[]) => {
			const index = list.indexOf(text);
			if (index >= 0) list.splice(index, 1);
		};
		cut(this.queued.steering);
		cut(this.queued.followUp);
		this.broadcastQueue();
	}

	private broadcastQueue() {
		this.broadcast({ type: "queue_update", steering: [...this.queued.steering], followUp: [...this.queued.followUp] });
		this.changed("queue");
	}

	private getMessages(ctx: CtxLike): unknown[] {
		const sm = ctx.sessionManager;
		const entries = sm?.buildContextEntries?.() ?? sm?.getEntries?.() ?? [];
		return extractMessages(entries);
	}

	private getEntries(ctx: CtxLike, since?: string) {
		const sm = ctx.sessionManager;
		const entries = [...(sm?.getEntries?.() ?? [])];
		const leafId = sm?.getLeafId?.() ?? null;
		const liveEvents = this.live.snapshot();
		const eventSeq = this.eventSeq;
		if (since) {
			const index = entries.findIndex((entry: any) => entry?.id === since);
			if (index < 0) return { error: `Unknown entry id: ${since}` };
			return { entries: entries.slice(index + 1), leafId, liveEvents, eventSeq };
		}
		return { entries, leafId, liveEvents, eventSeq };
	}
}

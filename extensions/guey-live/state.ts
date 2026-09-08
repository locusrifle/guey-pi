export const SUPPORTED_COMMANDS = [
	"get_state",
	"get_entries",
	"get_messages",
	"get_commands",
	"get_session_stats",
	"get_available_models",
	"set_model",
	"get_available_thinking_levels",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_session_name",
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"reload",
	"compact",
	"clear_queue",
] as const;

export type SupportedCommand = (typeof SUPPORTED_COMMANDS)[number];

export const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const STANDARD_THINKING = new Set(["off", "minimal", "low", "medium", "high"]);

const SECRET_KEYS = /^(headers|apiKey|api_key|authorization|auth|key|secret|token|password|credentials)$/i;

export function isSupportedCommand(type: string): type is SupportedCommand {
	return (SUPPORTED_COMMANDS as readonly string[]).includes(type);
}

export function sanitizeValue(value: unknown, depth = 0): unknown {
	if (value == null || depth > 8) return value;
	if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
	if (typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (SECRET_KEYS.test(key)) continue;
		out[key] = sanitizeValue(item, depth + 1);
	}
	return out;
}

export function sanitizeModel(model: unknown): unknown {
	if (!model || typeof model !== "object") return model ?? null;
	return sanitizeValue(model);
}

export function availableThinkingLevels(model: any, current?: string): string[] {
	if (!model?.reasoning) return ["off"];
	const map = model.thinkingLevelMap ?? {};
	const levels: string[] = [];
	for (const level of THINKING_ORDER) {
		const mapped = map[level];
		if (level === "xhigh" || level === "max") {
			if (typeof mapped === "string") levels.push(level);
		} else if (mapped !== null) {
			if (STANDARD_THINKING.has(level)) levels.push(level);
		}
	}
	if (current && !levels.includes(current)) levels.push(current);
	return levels.length ? levels : ["off"];
}

export function cycleThinkingLevel(levels: string[], current: string | undefined): string | null {
	if (!levels.length) return null;
	if (levels.length === 1 && levels[0] === "off") return null;
	const idx = Math.max(0, levels.indexOf(current ?? levels[0]));
	return levels[(idx + 1) % levels.length] ?? null;
}

export function emptyUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function addUsage(acc: ReturnType<typeof emptyUsage>, usage: any, costBox: { cost: number }): void {
	if (!usage || typeof usage !== "object") return;
	acc.input += Number(usage.input ?? 0);
	acc.output += Number(usage.output ?? 0);
	acc.cacheRead += Number(usage.cacheRead ?? 0);
	acc.cacheWrite += Number(usage.cacheWrite ?? 0);
	acc.total += Number(usage.totalTokens ?? (Number(usage.input ?? 0) + Number(usage.output ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0)));
	if (typeof usage.cost?.total === "number") costBox.cost += usage.cost.total;
	else if (typeof usage.cost === "number") costBox.cost += usage.cost;
}

export function sessionStatsFromManager(sessionManager: any, contextUsage: any) {
	const entries = sessionManager?.getEntries?.() ?? [];
	const tokens = emptyUsage();
	const costBox = { cost: 0 };
	let userMessages = 0;
	let assistantMessages = 0;
	let toolCalls = 0;
	let toolResults = 0;
	let cacheHitRate;

	for (const entry of entries) {
		if (entry?.type === "message" && entry.message) {
			const message = entry.message;
			if (message.role === "user") userMessages += 1;
			else if (message.role === "assistant") {
				assistantMessages += 1;
				addUsage(tokens, message.usage, costBox);
				const usage = message.usage ?? {};
				const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
				if (prompt > 0) cacheHitRate = ((usage.cacheRead ?? 0) / prompt) * 100;
				for (const part of message.content ?? []) {
					if (part?.type === "toolCall") toolCalls += 1;
				}
			} else if (message.role === "toolResult") {
				toolResults += 1;
				addUsage(tokens, message.usage, costBox);
			}
		} else if (entry?.type === "compaction" || entry?.type === "branch_summary") {
			addUsage(tokens, entry.usage, costBox);
		}
	}

	return {
		sessionFile: sessionManager?.getSessionFile?.(),
		sessionId: sessionManager?.getSessionId?.(),
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages: userMessages + assistantMessages + toolResults,
		tokens,
		cost: costBox.cost,
		cacheHitRate,
		contextUsage: contextUsage ?? undefined,
	};
}

export function extractMessages(entries: any[]): unknown[] {
	const messages: unknown[] = [];
	for (const entry of entries ?? []) {
		if (entry?.type === "message" && entry.message) messages.push(entry.message);
		else if (entry?.type === "custom_message") {
			messages.push({
				role: "custom",
				customType: entry.customType,
				content: entry.content,
				display: entry.display,
				details: entry.details,
				timestamp: entry.timestamp,
			});
		} else if (entry?.type === "compaction") {
			messages.push({
				role: "compactionSummary",
				summary: entry.summary,
				tokensBefore: entry.tokensBefore,
				timestamp: entry.timestamp,
			});
		} else if (entry?.type === "branch_summary") {
			messages.push({
				role: "branchSummary",
				summary: entry.summary,
				fromId: entry.fromId,
				timestamp: entry.timestamp,
			});
		}
	}
	return messages;
}

export function mapCommands(commands: any[]): unknown[] {
	return (commands ?? []).map((command) => ({
		name: command.name ?? command.invocationName,
		description: command.description,
		source: command.source,
		sourceInfo: command.sourceInfo,
		path: command.sourceInfo?.path ?? command.path,
		location: command.sourceInfo?.scope ?? command.location,
	}));
}

export function toSendUserContent(message: unknown, images?: any[]): string | any[] {
	if (!Array.isArray(images) || images.length === 0) {
		return typeof message === "string" || Array.isArray(message) ? message as any : String(message ?? "");
	}
	const blocks: any[] = [];
	if (typeof message === "string" && message.length) {
		blocks.push({ type: "text", text: message });
	} else if (Array.isArray(message)) {
		blocks.push(...message);
	}
	// Pi's ImageContent is flat — `{ type, data, mimeType }` — and its OpenAI
	// request builder reads those two fields directly to make a data: URL. An
	// Anthropic-shaped `{ source: { ... } }` block survives the session file and
	// then poisons every later turn with `data:undefined;base64,undefined`, so a
	// block of either shape is flattened here and one that carries no data is
	// dropped rather than sent.
	for (const image of images) {
		if (!image || typeof image !== "object") continue;
		const source = image.source && typeof image.source === "object" ? image.source : undefined;
		const data = source?.data ?? image.data;
		if (typeof data !== "string" || !data) continue;
		const mimeType = source?.mediaType ?? source?.mimeType ?? image.mimeType ?? image.mediaType ?? "image/png";
		blocks.push({ type: "image", data, mimeType });
	}
	return blocks;
}

export function rejectReason(type: string): string {
	if (type === "fork" || type === "clone") {
		return `${type} is not available in the TUI live bridge; fork from the terminal so session ownership stays with the TUI`;
	}
	if (type === "switch_session" || type === "new_session") {
		return `${type} is not available in the TUI live bridge; switch or start sessions from the terminal`;
	}
	if (type === "bash" || type === "abort_bash") {
		return `${type} is not available in the TUI live bridge; run ! commands in the terminal`;
	}
	return `Unsupported command: ${type}`;
}

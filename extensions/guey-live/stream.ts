const STREAM_DELTA_TYPES = new Set([
	"text_start",
	"text_delta",
	"text_end",
	"thinking_start",
	"thinking_delta",
	"thinking_end",
	"toolcall_start",
	"toolcall_delta",
	"toolcall_end",
]);

function toolBlock(partial: any, contentIndex: number): any {
	const block = partial?.content?.[contentIndex];
	if (block?.type === "toolCall") return block;
	return null;
}

export function toRpcAssistantEvent(ame: any): any | null {
	if (!ame || typeof ame !== "object") return null;
	if (!STREAM_DELTA_TYPES.has(ame.type)) return null;
	const { partial, ...rest } = ame;
	const cleaned = { ...rest };
	const block = toolBlock(partial, ame.contentIndex);
	if (ame.type === "toolcall_start" || ame.type === "toolcall_delta") {
		if (cleaned.id == null && block?.id) cleaned.id = block.id;
		if (cleaned.toolCallId == null && block?.id) cleaned.toolCallId = block.id;
		if (cleaned.toolName == null && (block?.name || block?.toolName)) {
			cleaned.toolName = block.name ?? block.toolName;
		}
	}
	if (ame.type === "toolcall_end" && cleaned.toolCall && typeof cleaned.toolCall === "object") {
		cleaned.toolCall = { ...cleaned.toolCall };
	}
	return cleaned;
}

export function toRpcMessageUpdate(event: any, diff?: CumulativeDiff): any | any[] | null {
	const usage = event?.usage ?? event?.message?.usage;
	const ame = toRpcAssistantEvent(event?.assistantMessageEvent);
	if (ame) {
		if (diff && event?.message) diff.sync(event.message);
		return { type: "message_update", usage, assistantMessageEvent: ame };
	}
	if (diff && event?.message?.role === "assistant") {
		const deltas = diff.consume(event.message);
		if (!deltas.length) return null;
		return deltas.map((assistantMessageEvent) => ({ type: "message_update", usage, assistantMessageEvent }));
	}
	return null;
}

type BlockState =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "toolCall"; id?: string; name?: string; args: string };

export class CumulativeDiff {
	private blocks: BlockState[] = [];

	reset(): void {
		this.blocks = [];
	}

	sync(message: any): void {
		const content = Array.isArray(message?.content) ? message.content : [];
		this.blocks = content.map((part: any) => snapshotPart(part)).filter(Boolean) as BlockState[];
	}

	consume(message: any): any[] {
		const events: any[] = [];
		const content = Array.isArray(message?.content) ? message.content : [];
		for (let i = 0; i < content.length; i++) {
			const part = content[i];
			const prev = this.blocks[i];
			if (part?.type === "text") {
				const text = String(part.text ?? "");
				if (!prev || prev.kind !== "text") {
					events.push({ type: "text_start", contentIndex: i });
					if (text) events.push({ type: "text_delta", contentIndex: i, delta: text });
					this.blocks[i] = { kind: "text", text };
				} else if (text.startsWith(prev.text)) {
					const delta = text.slice(prev.text.length);
					if (delta) events.push({ type: "text_delta", contentIndex: i, delta });
					prev.text = text;
				} else {
					this.blocks[i] = { kind: "text", text };
				}
			} else if (part?.type === "thinking") {
				const text = String(part.thinking ?? part.text ?? "");
				if (!prev || prev.kind !== "thinking") {
					events.push({ type: "thinking_start", contentIndex: i });
					if (text) events.push({ type: "thinking_delta", contentIndex: i, delta: text });
					this.blocks[i] = { kind: "thinking", text };
				} else if (text.startsWith(prev.text)) {
					const delta = text.slice(prev.text.length);
					if (delta) events.push({ type: "thinking_delta", contentIndex: i, delta });
					prev.text = text;
				} else {
					this.blocks[i] = { kind: "thinking", text };
				}
			} else if (part?.type === "toolCall") {
				const args = stringifyArgs(part.arguments ?? part.input ?? part.args);
				const id = part.id;
				const name = part.name ?? part.toolName;
				if (!prev || prev.kind !== "toolCall" || prev.id !== id) {
					events.push({ type: "toolcall_start", contentIndex: i, id, toolName: name });
					if (args) events.push({ type: "toolcall_delta", contentIndex: i, id, toolName: name, delta: args });
					this.blocks[i] = { kind: "toolCall", id, name, args };
				} else if (args.startsWith(prev.args)) {
					const delta = args.slice(prev.args.length);
					if (delta) events.push({ type: "toolcall_delta", contentIndex: i, id, toolName: name, delta });
					prev.args = args;
				} else {
					this.blocks[i] = { kind: "toolCall", id, name, args };
				}
			}
		}
		return events;
	}
}

function snapshotPart(part: any): BlockState | null {
	if (part?.type === "text") return { kind: "text", text: String(part.text ?? "") };
	if (part?.type === "thinking") return { kind: "thinking", text: String(part.thinking ?? part.text ?? "") };
	if (part?.type === "toolCall") {
		return {
			kind: "toolCall",
			id: part.id,
			name: part.name ?? part.toolName,
			args: stringifyArgs(part.arguments ?? part.input ?? part.args),
		};
	}
	return null;
}

function stringifyArgs(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export class LiveEventBuffer {
	private events: unknown[] = [];
	private recording = false;

	start(): void {
		this.events = [];
		this.recording = true;
	}

	stop(): void {
		this.events = [];
		this.recording = false;
	}

	/** Drop persisted-turn events but keep recording the in-progress stream. */
	clearRecorded(): void {
		this.events = [];
	}

	push(event: unknown): void {
		if (!this.recording || !event) return;
		if (Array.isArray(event)) {
			for (const item of event) this.events.push(item);
			return;
		}
		this.events.push(event);
	}

	snapshot(): unknown[] {
		return [...this.events];
	}

	get active(): boolean {
		return this.recording;
	}
}

export function rpcMessageEvent(type: "message_start" | "message_end", message: unknown) {
	return { type, message };
}

export function rpcToolEvent(type: string, event: any) {
	if (type === "tool_execution_start") {
		return { type, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
	}
	if (type === "tool_execution_update") {
		return {
			type,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			partialResult: event.partialResult,
		};
	}
	if (type === "tool_execution_end") {
		return {
			type,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: event.result,
			isError: event.isError,
		};
	}
	return { type, ...event };
}

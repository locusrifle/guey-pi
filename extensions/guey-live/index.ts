import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TuiBridge } from "./bridge.ts";

export { SUPPORTED_COMMANDS } from "./state.ts";
export { resolveRuntimeDir } from "./paths.ts";
export { TuiBridge } from "./bridge.ts";
export { toRpcMessageUpdate, CumulativeDiff } from "./stream.ts";
export { sanitizeModel, availableThinkingLevels, rejectReason } from "./state.ts";

const PI_EVENTS = [
	"session_info_changed",
	"session_before_compact",
	"session_compact",
	"session_tree",
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"model_select",
	"thinking_level_select",
] as const;

const OPTIONAL_EVENTS = ["session_compact_failed", "ui_prompt_start", "ui_prompt_end", "input"] as const;

export default function gueyLive(pi: ExtensionAPI): void {
	const bridge = new TuiBridge(pi as any);

	pi.registerCommand("guey-reload", {
		description: "Reload keybindings, extensions, skills, prompts, themes, and context files",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		try {
			await bridge.start(ctx as any);
		} catch (error) {
			ctx.ui?.notify?.(`guey-live: ${(error as Error).message}`, "error");
		}
	});

	pi.on("session_shutdown", async (event) => {
		if (event?.reason === "reload") return;
		await bridge.stop();
	});

	for (const type of PI_EVENTS) {
		pi.on(type as any, (event, ctx) => {
			bridge.onPiEvent(type, event, ctx as any);
		});
	}

	const on = pi.on.bind(pi) as (event: string, handler: (event: any, ctx: any) => void) => void;
	for (const type of OPTIONAL_EVENTS) {
		try {
			on(type, (event, ctx) => {
				bridge.onPiEvent(type, event, ctx);
			});
		} catch {
			// Older Pi builds may not emit these.
		}
	}
}

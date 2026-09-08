export const HTTP_IDLE_CHOICES = [
	{ label: '30 sec', ms: 30_000 },
	{ label: '1 min', ms: 60_000 },
	{ label: '2 min', ms: 120_000 },
	{ label: '5 min', ms: 300_000 },
	{ label: 'disabled', ms: 0 },
];

export const TRUST_LABELS = { ask: 'Ask', always: 'Always trust', never: 'Never trust' };

export const SETTING_DEFS = [
	{ key: 'autoCompact', label: 'Auto-compact', description: 'Automatically compact context when it gets too large', kind: 'bool', path: ['compaction', 'enabled'], def: true },
	{ key: 'autoResizeImages', label: 'Auto-resize images', description: 'Resize large images to 2000x2000 max for better model compatibility', kind: 'bool', path: ['autoResizeImages'], def: true },
	{ key: 'blockImages', label: 'Block images', description: 'Prevent images from being sent to LLM providers', kind: 'bool', path: ['blockImages'], def: false },
	{ key: 'skillCommands', label: 'Skill commands', description: 'Register skills as /skill:name commands', kind: 'bool', path: ['enableSkillCommands'], def: true },
	{ key: 'showHardwareCursor', label: 'Show hardware cursor', description: 'Show the terminal cursor while still positioning it for IME support', kind: 'bool', path: ['showHardwareCursor'], def: false },
	{ key: 'editorPadding', label: 'Editor padding', description: 'Horizontal padding for input editor (0-3)', kind: 'enum', values: ['0', '1', '2', '3'], path: ['editorPaddingX'], def: 0 },
	{ key: 'outputPadding', label: 'Output padding', description: 'Horizontal padding for user messages, assistant messages, and thinking', kind: 'enum', values: ['0', '1'], path: ['outputPad'], def: 1 },
	{ key: 'autocompleteMaxVisible', label: 'Autocomplete max items', description: 'Max visible items in autocomplete dropdown (3-20)', kind: 'enum', values: ['3', '5', '7', '10', '15', '20'], path: ['autocompleteMaxVisible'], def: 5 },
	{ key: 'clearOnShrink', label: 'Clear on shrink', description: 'Clear empty rows when content shrinks (may cause flicker)', kind: 'bool', path: ['clearOnShrink'], def: false },
	{ key: 'terminalProgress', label: 'Terminal progress', description: 'Show OSC 9;4 progress indicators in the terminal tab bar', kind: 'bool', path: ['showTerminalProgress'], def: false },
	{ key: 'steeringMode', label: 'Steering mode', description: "Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.", kind: 'enum', values: ['one-at-a-time', 'all'], path: ['steeringMode'], def: 'all' },
	{ key: 'followUpMode', label: 'Follow-up mode', description: "Follow-up queues messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.", kind: 'enum', values: ['one-at-a-time', 'all'], path: ['followUpMode'], def: 'all' },
	{ key: 'transport', label: 'Transport', description: 'Preferred transport for providers that support multiple transports', kind: 'enum', values: ['sse', 'websocket', 'websocket-cached', 'auto'], path: ['transport'], def: 'auto' },
	{ key: 'httpIdleTimeout', label: 'HTTP idle timeout', description: 'Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.', kind: 'idle', values: HTTP_IDLE_CHOICES.map(item => item.label), path: ['httpIdleTimeoutMs'], def: 300_000 },
	{ key: 'hideThinkingBlock', label: 'Hide thinking', description: 'Hide thinking blocks in assistant responses', kind: 'bool', path: ['hideThinkingBlock'], def: false },
	{ key: 'mermaidRenderingMode', label: 'Mermaid diagrams', description: 'Render Mermaid code blocks as Unicode diagrams', kind: 'enum', values: ['off', 'final', 'streaming'], path: ['mermaidRenderingMode'], def: 'off' },
	{ key: 'showCacheMissNotices', label: 'Cache miss notices', description: 'Show transcript notices for cache costs and provider recovery diagnostics', kind: 'bool', path: ['showCacheMissNotices'], def: false },
	{ key: 'collapseChangelog', label: 'Collapse changelog', description: 'Show condensed changelog after updates', kind: 'bool', path: ['collapseChangelog'], def: false },
	{ key: 'quietStartup', label: 'Quiet startup', description: 'Disable verbose printing at startup', kind: 'bool', path: ['quietStartup'], def: false },
	{ key: 'enableInstallTelemetry', label: 'Install telemetry', description: 'Send an anonymous version/update ping after changelog-detected updates', kind: 'bool', path: ['enableInstallTelemetry'], def: false },
	{ key: 'defaultProjectTrust', label: 'Default project trust', description: 'Fallback behavior when no extension or saved trust decision decides project trust', kind: 'trust', values: Object.values(TRUST_LABELS), path: ['defaultProjectTrust'], def: 'ask' },
	{ key: 'doubleEscapeAction', label: 'Double-escape action', description: 'Action when pressing Escape twice with empty editor', kind: 'enum', values: ['tree', 'fork', 'none'], path: ['doubleEscapeAction'], def: 'tree' },
	{ key: 'treeFilterMode', label: 'Tree filter mode', description: 'Default filter when opening /tree', kind: 'enum', values: ['default', 'no-tools', 'user-only', 'labeled-only', 'all'], path: ['treeFilterMode'], def: 'default' },
	{ key: 'warnings', label: 'Warnings', description: 'Enable or disable individual warnings', kind: 'submenu', def: 'configure' },
	{ key: 'modelThinking', label: 'Default thinking level per model', description: 'Override the default thinking level for specific models. Ctrl+T cycles in-session.', kind: 'submenu', def: 'none' },
	{ key: 'tuiMode', label: 'TUI mode', description: 'Interface layout; fullscreen mode is experimental', kind: 'enum', values: ['regular', 'fullscreen'], path: ['tuiMode'], def: 'regular' },
	{ key: 'fullscreenExitOutput', label: 'Fullscreen exit output', description: 'Print the transcript or only a session resume hint when exiting fullscreen mode', kind: 'enum', values: ['transcript', 'resume-hint'], path: ['fullscreenExitOutput'], def: 'transcript' },
	{ key: 'fullscreenScrollbar', label: 'Fullscreen scrollbar', description: 'Scrollbar behavior in fullscreen mode; has no effect in regular mode', kind: 'enum', values: ['auto', 'always', 'hidden'], path: ['fullscreenScrollbar'], def: 'auto' },
	{ key: 'fullscreenCopyOnSelect', label: 'Fullscreen copy on select', description: 'Automatically copy selected text in fullscreen mode; disable to copy selections with Ctrl+X', kind: 'bool', path: ['fullscreenCopyOnSelect'], def: false },
	{ key: 'theme', label: 'Theme', description: 'Color theme for the interface', kind: 'theme', path: ['theme'], def: 'dark' },
];

function getPath(object, path, fallback) {
	let cur = object;
	for (const key of path) {
		if (cur == null || typeof cur !== 'object') return fallback;
		cur = cur[key];
	}
	return cur === undefined ? fallback : cur;
}

function setPath(object, path, value) {
	let cur = object;
	for (let i = 0; i < path.length - 1; i++) {
		const key = path[i];
		if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = {};
		cur = cur[key];
	}
	cur[path.at(-1)] = value;
}

export function displayValue(def, raw, extra = {}) {
	if (def.kind === 'bool') return raw ? 'true' : 'false';
	if (def.kind === 'idle') return HTTP_IDLE_CHOICES.find(item => item.ms === Number(raw))?.label ?? '5 min';
	if (def.kind === 'trust') return TRUST_LABELS[raw] ?? TRUST_LABELS.ask;
	if (def.key === 'warnings') return 'configure';
	if (def.key === 'modelThinking') {
		const count = Object.keys(extra.modelThinkingLevels ?? raw ?? {}).length;
		return count ? `${count} configured` : 'none';
	}
	if (def.kind === 'theme') return String(raw ?? def.def);
	return String(raw ?? def.def);
}

export function settingsView(file = {}) {
	const out = {};
	for (const def of SETTING_DEFS) {
		if (def.path) out[def.key] = getPath(file, def.path, def.def);
	}
	out.warnings = getPath(file, ['warnings'], { anthropicExtraUsage: true });
	out.modelThinkingLevels = getPath(file, ['modelThinkingLevels'], {});
	out.theme = getPath(file, ['theme'], 'dark');
	return out;
}

export function applySetting(file, key, value) {
	if (key === 'warningsAnthropicExtraUsage') {
		const next = structuredClone(file);
		next.warnings = { ...(next.warnings ?? {}), anthropicExtraUsage: value === true || value === 'true' };
		return next;
	}
	if (key === 'modelThinkingLevels') {
		const next = structuredClone(file);
		next.modelThinkingLevels = value && typeof value === 'object' ? value : {};
		return next;
	}
	const def = SETTING_DEFS.find(item => item.key === key);
	if (!def) throw new Error(`Unknown setting: ${key}`);
	if (def.kind === 'theme' || def.kind === 'submenu') throw new Error(`Use the ${def.key} submenu`);
	const next = structuredClone(file);
	let stored = value;
	if (def.kind === 'bool') stored = value === true || value === 'true';
	else if (def.kind === 'idle') {
		const choice = HTTP_IDLE_CHOICES.find(item => item.label === value || item.ms === Number(value));
		stored = choice?.ms ?? 300_000;
	} else if (def.kind === 'trust') {
		const byLabel = Object.fromEntries(Object.entries(TRUST_LABELS).map(([id, label]) => [label, id]));
		stored = byLabel[value] ?? (TRUST_LABELS[value] ? value : 'ask');
	} else if (def.kind === 'enum' && def.values.every(v => /^\d+$/.test(v))) stored = Number(value);
	setPath(next, def.path, stored);
	return next;
}

export function cycleValue(def, current) {
	if (def.kind === 'bool') return !(current === true || current === 'true');
	if (def.kind === 'idle') {
		const labels = HTTP_IDLE_CHOICES.map(item => item.label);
		const now = displayValue(def, current);
		return labels[(Math.max(0, labels.indexOf(now)) + 1) % labels.length];
	}
	if (def.kind === 'trust') {
		const labels = Object.values(TRUST_LABELS);
		const now = displayValue(def, current);
		const next = labels[(Math.max(0, labels.indexOf(now)) + 1) % labels.length];
		return Object.fromEntries(Object.entries(TRUST_LABELS).map(([id, label]) => [label, id]))[next];
	}
	const values = def.values ?? [];
	const now = String(current ?? def.def);
	const i = Math.max(0, values.indexOf(now));
	const next = values[(i + 1) % values.length];
	return values.length && values.every(v => /^\d+$/.test(v)) ? Number(next) : next;
}

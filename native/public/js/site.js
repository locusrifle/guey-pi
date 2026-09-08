// locusrifle — Guey's conversation UI in a Quake drop over an infinite grid.
// /desktop is a window on that grid. Typing is the OS keyboard.

import { grid, bindHarnessKeys } from "./pi-card.js";
import { mountGueyPi } from "./harness.js";

const el = (id) => document.getElementById(id);

let UNIT = 24;
let panX = 0;
let panY = 0;
let panFrame = 0;

function applyPan(now = false) {
	const paint = () => {
		panFrame = 0;
		const root = document.documentElement.style;
		root.setProperty("--locus-grid-origin-x", `${panX}px`);
		root.setProperty("--locus-grid-origin-y", `${panY}px`);
	};
	if (now) {
		if (panFrame) cancelAnimationFrame(panFrame);
		paint();
		return;
	}
	if (!panFrame) panFrame = requestAnimationFrame(paint);
}

function measureGrid() {
	const { unit } = grid();
	UNIT = unit;
	applyPan();
	return { unit };
}
measureGrid();

const entry = el("terminal-entry");
const input = el("entry-input");
const reach = el("harness-reach");

const isHarnessOpen = () => entry.classList.contains("open");

function openHarness() {
	entry.classList.add("open");
	if (reach) reach.hidden = true;
	input.focus();
}
function closeHarness() {
	entry.classList.remove("open");
	input.blur();
	if (reach) reach.hidden = false;
}
function toggleHarness() { isHarnessOpen() ? closeHarness() : openHarness(); }

const SWIPE_MIN = 56;
const PAN_MIN = 3;

function blocksCanvasGesture(node) {
	return Boolean(node?.closest?.('#entry-output, #entry-input, #entry-dialog, #slash-menu, .desk-screen, .desk-controls, .desk-corner, textarea, input, label, button:not(#harness-reach)'));
}

function harnessEdge(node) {
	return Boolean(node?.closest?.('#harness-reach, .drop-handle'));
}

let gesture = null;

addEventListener("pointerdown", event => {
	if (event.button) return;
	const edge = harnessEdge(event.target);
	if (blocksCanvasGesture(event.target) && !edge) return;
	gesture = {
		id: event.pointerId,
		x: event.clientX,
		y: event.clientY,
		panX,
		panY,
		kind: null,
		edge,
	};
	try { event.target.setPointerCapture?.(event.pointerId); } catch { /* not a capturing target */ }
	if (!edge && event.cancelable) event.preventDefault();
}, { capture: true, passive: false });

addEventListener("pointermove", event => {
	if (!gesture || event.pointerId !== gesture.id) return;
	if (event.cancelable) event.preventDefault();
	const dx = event.clientX - gesture.x;
	const dy = event.clientY - gesture.y;
	const adx = Math.abs(dx);
	const ady = Math.abs(dy);
	if (!gesture.kind) {
		if (gesture.edge) {
			if (!isHarnessOpen() && dy > SWIPE_MIN && ady >= adx) {
				openHarness();
				gesture = null;
			}
			else if (isHarnessOpen() && dy < -SWIPE_MIN && ady >= adx) {
				closeHarness();
				gesture = null;
			}
			return;
		}
		if (adx >= PAN_MIN || ady >= PAN_MIN) {
			gesture.kind = "pan";
			document.body.classList.add("canvas-panning");
		} else {
			return;
		}
	}
	if (gesture.kind === "pan") {
		panX = gesture.panX + dx;
		panY = gesture.panY + dy;
		applyPan();
	}
}, { capture: true, passive: false });

function endGesture() {
	if (!gesture) return;
	if (gesture.kind === "pan") {
		document.body.classList.remove("canvas-panning");
		applyPan(true);
	}
	gesture = null;
}
addEventListener("pointerup", endGesture, { capture: true });
addEventListener("pointercancel", endGesture, { capture: true });

function grow() {
	const stack = input.closest(".entry-input-stack");
	input.style.height = "1.2em";
	const cap = Math.max(22, Math.floor(innerHeight * 0.3));
	const next = Math.min(Math.max(input.scrollHeight, 0), cap);
	input.style.height = `${next}px`;
	if (!stack) return;
	stack.style.height = "";
	const floor = parseFloat(getComputedStyle(stack).minHeight) || 0;
	if (next > floor) stack.style.height = `${next}px`;
}

mountGueyPi({
	elements: {
		output: el("entry-output"),
		input,
		dialog: el("entry-dialog"),
		widgets: el("entry-widgets"),
		slashMenu: el("slash-menu"),
		modelStatus: el("entry-model-status"),
		modelName: el("entry-pi-label"),
		spend: el("entry-spend"),
		thinking: el("entry-thinking"),
		sessionTitle: el("entry-session-name"),
		sessionSource: el("entry-source"),
		sessionCwd: el("entry-cwd"),
		context: el("entry-context"),
		screen: document.querySelector(".entry-screen"),
	},
	hooks: {
		onDraftChange: grow,
		canFocus: () => isHarnessOpen(),
		onEscapeIdle: closeHarness,
	},
});

reach?.addEventListener("click", openHarness);

document.addEventListener("click", (event) => {
	const source = event.target.closest("[data-ask]");
	if (!source?.dataset.ask) return;
	openHarness();
	input.value = source.dataset.ask;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	grow();
	input.focus();
});

addEventListener("resize", () => {
	measureGrid();
	dispatchEvent(new CustomEvent("locus:gridchange"));
});

bindHarnessKeys({ onHarness: toggleHarness });
if (reach) reach.hidden = isHarnessOpen();
input.addEventListener("input", grow);
grow();

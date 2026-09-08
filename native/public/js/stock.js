// Neutral full-window Pi shell. Shares harness.js; no garden, grid, quake, or uploads.
import { mountGueyPi } from './harness.js';

const el = (id) => document.getElementById(id);
const input = el('entry-input');

function grow() {
	input.style.height = '1.65em';
	const cap = Math.max(22, Math.floor(innerHeight * 0.3));
	input.style.height = `${Math.min(Math.max(input.scrollHeight, input.offsetHeight || 0), cap)}px`;
}

mountGueyPi({
	personal: false,
	elements: {
		output: el('entry-output'),
		input,
		dialog: el('entry-dialog'),
		widgets: el('entry-widgets'),
		slashMenu: el('slash-menu'),
		modelStatus: el('entry-model-status'),
		modelName: el('entry-pi-label'),
		spend: el('entry-spend'),
		thinking: el('entry-thinking'),
		sessionTitle: el('entry-session-name'),
		sessionSource: el('entry-source'),
		sessionCwd: el('entry-cwd'),
		context: el('entry-context'),
		screen: document.querySelector('.entry-screen'),
	},
	hooks: {
		onDraftChange: grow,
		canFocus: () => true,
	},
});

input.addEventListener('input', grow);
grow();
input.focus();

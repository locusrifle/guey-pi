// Laptop screen as a window on the locusrifle canvas. Controls sit outside
// the surface. Corners resize the surface; noVNC scales to match.

function el(tag, text, className) {
	const node = document.createElement(tag);
	if (text != null) node.textContent = text;
	if (className) node.className = className;
	return node;
}

function socketUrl() {
	const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${scheme}//${location.host}/desktop`;
}

const MIN_W = 160;
const MIN_H = 90;

export function mountDesk(options = {}) {
	const loadRfb = options.loadRfb ?? (() => import('/vendor/novnc/core/rfb.js'));
	let panel = null;
	let viewport = null;
	let screen = null;
	let rfb = null;
	let opening = null;
	let gen = 0;
	let inputMode = 'touch';
	let buttonMask = 0;
	let lastPos = { x: 0, y: 0 };
	let rot = 0;
	let x = 48;
	let y = 48;
	let width = 960;
	let height = 540;
	let shaped = false;

	function setStatus(text) {
		const node = panel?.querySelector('.desk-status');
		if (node) node.textContent = text;
	}

	function worldHost() {
		return document.getElementById('locus-world') ?? document.body;
	}

	function hugDesktop() {
		const fbW = Number(rfb?._fbWidth);
		const fbH = Number(rfb?._fbHeight);
		if (!fbW || !fbH || shaped) return;
		const viewW = typeof innerWidth === 'number' ? innerWidth : 1280;
		const viewH = typeof innerHeight === 'number' ? innerHeight : 720;
		const maxW = Math.max(MIN_W, viewW - 96);
		const maxH = Math.max(MIN_H, viewH - 48);
		const scale = Math.min(maxW / fbW, maxH / fbH);
		width = Math.max(MIN_W, fbW * scale);
		height = Math.max(MIN_H, fbH * scale);
	}

	function syncRfb() {
		if (!rfb) return;
		try { rfb.scaleViewport = false; } catch { /* display may not exist yet */ }
	}

	function layout() {
		if (!panel) return;
		panel.style.left = `${x}px`;
		panel.style.top = `${y}px`;
		panel.style.width = `${width}px`;
		panel.style.height = `${height}px`;
		if (screen) {
			const innerW = rot % 180 === 0 ? width : height;
			const innerH = rot % 180 === 0 ? height : width;
			screen.style.width = `${innerW}px`;
			screen.style.height = `${innerH}px`;
			screen.style.left = '50%';
			screen.style.top = '50%';
			screen.style.marginLeft = `${-innerW / 2}px`;
			screen.style.marginTop = `${-innerH / 2}px`;
			screen.style.transformOrigin = 'center center';
			screen.style.transform = rot ? `rotate(${rot}deg)` : '';
		}
		syncRfb();
	}

	function canvasPos(clientX, clientY) {
		const canvas = screen?.querySelector?.('canvas');
		if (!canvas) return lastPos;
		const rect = canvas.getBoundingClientRect();
		if (!rect.width || !rect.height) return lastPos;
		const bitmapW = canvas.width || rect.width;
		const bitmapH = canvas.height || rect.height;
		return {
			x: ((clientX - rect.left) / rect.width) * bitmapW,
			y: ((clientY - rect.top) / rect.height) * bitmapH,
		};
	}

	function sendMouse(pos, mask) {
		lastPos = pos;
		if (!rfb || typeof rfb._sendMouse !== 'function') return;
		rfb._mouseButtonMask = mask;
		rfb._sendMouse(pos.x, pos.y, mask);
	}

	function setMode(mode) {
		inputMode = mode === 'cursor' ? 'cursor' : 'touch';
		if (rfb) rfb.viewOnly = inputMode === 'cursor';
		panel?.classList.toggle('cursor-mode', inputMode === 'cursor');
		const label = panel?.querySelector('.desk-mode');
		if (label) {
			label.textContent = inputMode === 'cursor' ? 'CURSOR' : 'TOUCH';
			label.setAttribute('aria-pressed', String(inputMode === 'cursor'));
		}
		const left = panel?.querySelector('.desk-left');
		const right = panel?.querySelector('.desk-right');
		if (left) left.disabled = inputMode !== 'cursor';
		if (right) right.disabled = inputMode !== 'cursor';
		if (inputMode !== 'cursor') {
			buttonMask = 0;
			left && (left.dataset.held = '');
			sendMouse(lastPos, 0);
		}
	}

	function setLeftHeld(held) {
		const next = held ? (buttonMask | 1) : (buttonMask & ~1);
		buttonMask = next;
		const btn = panel?.querySelector('.desk-left');
		if (btn) {
			btn.dataset.held = held ? 'true' : '';
			btn.setAttribute('aria-pressed', String(held));
		}
		sendMouse(lastPos, buttonMask);
	}

	function close() {
		gen += 1;
		const dying = rfb;
		rfb = null;
		opening = null;
		panel?.remove();
		panel = null;
		viewport = null;
		screen = null;
		document.body.classList.remove('desk-live');
		try { dying?.disconnect(); } catch { /* already gone */ }
	}

	function isOpen() { return Boolean(panel); }

	function bindMove(handle) {
		let drag = null;
		handle.addEventListener('pointerdown', event => {
			if (event.button || event.target.closest('button')) return;
			drag = { id: event.pointerId, cx: event.clientX, cy: event.clientY, x, y };
			handle.setPointerCapture?.(event.pointerId);
			event.preventDefault();
		});
		handle.addEventListener('pointermove', event => {
			if (!drag || event.pointerId !== drag.id) return;
			x = drag.x + (event.clientX - drag.cx);
			y = drag.y + (event.clientY - drag.cy);
			layout();
		});
		const end = () => { drag = null; };
		handle.addEventListener('pointerup', end);
		handle.addEventListener('pointercancel', end);
	}

	function bindCorner(node, corner) {
		let drag = null;
		node.addEventListener('pointerdown', event => {
			if (event.button) return;
			drag = { id: event.pointerId, cx: event.clientX, cy: event.clientY, x, y, width, height, corner };
			node.setPointerCapture?.(event.pointerId);
			event.preventDefault();
			event.stopPropagation();
		});
		node.addEventListener('pointermove', event => {
			if (!drag || event.pointerId !== drag.id) return;
			const dx = event.clientX - drag.cx;
			const dy = event.clientY - drag.cy;
			let nextX = drag.x;
			let nextY = drag.y;
			let nextW = drag.width;
			let nextH = drag.height;
			if (corner.includes('e')) nextW = drag.width + dx;
			if (corner.includes('s')) nextH = drag.height + dy;
			if (corner.includes('w')) { nextX = drag.x + dx; nextW = drag.width - dx; }
			if (corner.includes('n')) { nextY = drag.y + dy; nextH = drag.height - dy; }
			if (nextW < MIN_W) { if (corner.includes('w')) nextX -= (MIN_W - nextW); nextW = MIN_W; }
			if (nextH < MIN_H) { if (corner.includes('n')) nextY -= (MIN_H - nextH); nextH = MIN_H; }
			x = nextX; y = nextY; width = nextW; height = nextH;
			shaped = true;
			layout();
		});
		const end = () => { drag = null; };
		node.addEventListener('pointerup', end);
		node.addEventListener('pointercancel', end);
	}

	function bindCursorLayer() {
		screen.addEventListener('contextmenu', event => event.preventDefault());
		screen.addEventListener('pointerdown', event => {
			if (inputMode !== 'cursor' || event.target.closest('button, .desk-corner')) return;
			event.preventDefault();
			screen.setPointerCapture?.(event.pointerId);
			const pos = canvasPos(event.clientX, event.clientY);
			sendMouse(pos, buttonMask || (event.buttons & 1 ? 1 : 0) | (event.buttons & 2 ? 4 : 0));
		});
		screen.addEventListener('pointermove', event => {
			if (inputMode !== 'cursor') return;
			const pos = canvasPos(event.clientX, event.clientY);
			sendMouse(pos, buttonMask);
		});
		screen.addEventListener('pointerup', event => {
			if (inputMode !== 'cursor') return;
			const pos = canvasPos(event.clientX, event.clientY);
			if (buttonMask === 0) {
				sendMouse(pos, 1);
				sendMouse(pos, 0);
			} else {
				sendMouse(pos, buttonMask);
			}
		});
	}

	async function open() {
		if (panel) return;
		if (opening) return opening;
		const mine = ++gen;
		opening = (async () => {
			let RFB;
			try {
				({ default: RFB } = await loadRfb());
			} catch (error) {
				if (mine !== gen) return;
				throw error;
			}
			if (mine !== gen) return;
			const viewW = typeof innerWidth === 'number' ? innerWidth : 1280;
			const viewH = typeof innerHeight === 'number' ? innerHeight : 720;
			width = Math.max(MIN_W, Math.min(viewW - 96, 960));
			height = Math.max(MIN_H, width * 9 / 16);
			if (height > viewH - 48) {
				height = Math.max(MIN_H, viewH - 48);
				width = height * 16 / 9;
			}
			x = 24;
			y = Math.max(24, (viewH - height) / 2);
			rot = 0;
			shaped = false;
			inputMode = 'touch';
			buttonMask = 0;

			const next = el('div', null, 'desk-panel');
			next.id = 'desk-panel';
			next.setAttribute('role', 'dialog');
			next.setAttribute('aria-label', 'laptop desktop');
			viewport = el('div', null, 'desk-viewport');
			screen = el('div', null, 'desk-screen');
			viewport.append(screen);
			const controls = el('div', null, 'desk-controls');
			controls.append(el('span', 'connecting', 'desk-status'));
			const mode = el('button', 'TOUCH', 'desk-mode');
			mode.type = 'button';
			mode.setAttribute('aria-label', 'Toggle cursor and touch input');
			mode.setAttribute('aria-pressed', 'false');
			mode.onclick = () => setMode(inputMode === 'touch' ? 'cursor' : 'touch');
			const left = el('button', 'L', 'desk-left');
			left.type = 'button';
			left.setAttribute('aria-label', 'Hold left mouse button');
			left.disabled = true;
			left.onclick = () => setLeftHeld(left.dataset.held !== 'true');
			const right = el('button', 'R', 'desk-right');
			right.type = 'button';
			right.setAttribute('aria-label', 'Hold right mouse button');
			right.disabled = true;
			let rightHeld = false;
			right.addEventListener('pointerdown', event => {
				if (right.disabled) return;
				event.preventDefault();
				rightHeld = true;
				right.dataset.held = 'true';
				buttonMask |= 4;
				sendMouse(lastPos, buttonMask);
			});
			const releaseRight = () => {
				if (!rightHeld) return;
				rightHeld = false;
				right.dataset.held = '';
				buttonMask &= ~4;
				sendMouse(lastPos, buttonMask);
			};
			right.addEventListener('pointerup', releaseRight);
			right.addEventListener('pointercancel', releaseRight);
			const rotate = el('button', 'ROTATE', 'desk-rotate');
			rotate.type = 'button';
			rotate.setAttribute('aria-label', 'Rotate window 90 degrees clockwise');
			rotate.onclick = () => {
				const nextRot = (rot + 90) % 360;
				const cx = x + width / 2;
				const cy = y + height / 2;
				const swapped = nextRot % 180 !== rot % 180;
				if (swapped) { const w = width; width = height; height = w; }
				x = cx - width / 2;
				y = cy - height / 2;
				rot = nextRot;
				layout();
			};
			const stop = el('button', 'close', 'desk-close');
			stop.type = 'button';
			stop.setAttribute('aria-label', 'close desktop');
			stop.onclick = () => { close(); options.onClose?.(); };
			controls.append(mode, left, right, rotate, stop);
			for (const corner of ['nw', 'ne', 'sw', 'se']) {
				const handle = el('i', null, `desk-corner desk-corner-${corner}`);
				handle.dataset.corner = corner;
				bindCorner(handle, corner);
				next.append(handle);
			}
			next.append(viewport, controls);
			bindMove(controls);
			bindCursorLayer();
			worldHost().append(next);
			document.body.classList.add('desk-live');
			panel = next;
			layout();

			let instance;
			try {
				instance = new RFB(screen, socketUrl(), { shared: true });
			} catch (error) {
				if (mine !== gen) return;
				next.remove();
				if (panel === next) panel = null;
				document.body.classList.remove('desk-live');
				throw error;
			}
			if (mine !== gen) {
				try { instance.disconnect(); } catch { /* superseded */ }
				next.remove();
				if (panel === next) panel = null;
				document.body.classList.remove('desk-live');
				return;
			}
			instance.scaleViewport = false;
			instance.clipViewport = false;
			instance.resizeSession = false;
			instance.viewOnly = false;
			instance.showDotCursor = true;
			instance.qualityLevel = 6;
			instance.compressionLevel = 1;
			instance.focusOnClick = true;
			instance.addEventListener('connect', () => {
				if (mine !== gen || rfb !== instance) return;
				setStatus('live');
				hugDesktop();
				layout();
			});
			instance.addEventListener('disconnect', event => {
				if (mine !== gen || rfb !== instance) return;
				rfb = null;
				setStatus(event.detail?.clean ? 'closed' : 'unavailable');
			});
			instance.addEventListener('securityfailure', event => {
				if (mine !== gen || rfb !== instance) return;
				setStatus(event.detail?.reason || 'authentication failed');
			});
			instance.addEventListener('credentialsrequired', () => {
				if (mine !== gen || rfb !== instance) return;
				setStatus('credentials were requested');
			});
			rfb = instance;
			setMode(inputMode);
			layout();
		})();
		try {
			await opening;
		} catch (error) {
			if (mine === gen) throw error;
		} finally {
			if (mine === gen) opening = null;
		}
	}

	return { open, close, isOpen };
}

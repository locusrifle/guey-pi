import { grid, ALT_LABEL } from "./pi-card.js";

const BINDS = { h: "KeyH" };

const LETTERS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const OTHER = ["1234567890", "-/=.,'\";:\\", "@#$%&*()↑↓"];

// The original personal keyboard recording had no redistribution provenance.
// The release has no key-click audio.
function keyClicks() { return { unlock() {}, play() {} }; }

export function isPhone() {
  return matchMedia("(pointer: coarse)").matches || innerWidth < 700;
}

export function setupGridKeys(first, { onEnter, onChange, isOpen, dictation } = {}) {
  const root = document.querySelector("#grid-keys");
  if (!root || !first) return { layout() {}, stow() {}, reveal() {}, retarget() {} };
  // The keyboard types into whichever field currently owns the screen. It is built once around the
  // harness prompt and lent to the door when a visitor is signing the canvas, because a phone that
  // raises its own keyboard over a centred form has covered the thing it was asked to fill in.
  let input = first;
  // While the keyboard is lent to another field, that field decides what a keystroke means: the
  // harness may well be closed, and its open-state gate would otherwise swallow every key.
  let lent = null;

  const cursorDisplay = document.createElement("span");
  cursorDisplay.className = "mobile-input-display";
  cursorDisplay.hidden = true;
  const cursorText = document.createTextNode("");
  const cursor = document.createElement("i");
  cursor.className = "mobile-block-cursor";
  cursor.setAttribute("aria-hidden", "true");
  cursorDisplay.append(cursorText, cursor);
  const syncCursor = () => { cursorText.data = input.value; };
  const swallowFocus = event => {
    if (!isPhone()) return;
    event.preventDefault();
    input.blur();
  };
  function bind(next, submit = null) {
    lent = next === first ? null : { submit };
    input.removeEventListener("input", syncCursor);
    input.removeEventListener("focus", swallowFocus);
    input.readOnly = false;
    input.removeAttribute("inputmode");
    input.classList.remove("mobile-key-input");
    input = next;
    input.insertAdjacentElement("afterend", cursorDisplay);
    input.addEventListener("input", syncCursor);
    input.addEventListener("focus", swallowFocus);
    syncCursor();
    layout();
  }
  input.insertAdjacentElement("afterend", cursorDisplay);
  input.addEventListener("input", syncCursor);
  function matchPromptCursor() {
    const prompt = document.querySelector(".entry-prompt");
    if (!prompt || cursorDisplay.hidden) return;
    const range = document.createRange();
    range.selectNodeContents(prompt);
    const glyph = range.getBoundingClientRect();
    if (!glyph.width || !glyph.height) return;
    cursor.style.width = `${glyph.width}px`;
    cursor.style.height = `${glyph.height}px`;
  }

  root.replaceChildren();
  const rail = document.createElement("i");
  rail.className = "keys-rail";
  rail.setAttribute("aria-hidden", "true");
  const sheet = document.createElement("div");
  sheet.className = "keys-sheet";
  const lettersFace = face("letters", LETTERS);
  const otherFace = face("other", OTHER);
  otherFace.hidden = true;
  sheet.append(lettersFace, otherFace);
  root.append(rail, sheet);

  let page = "letters";
  let stowed = true;
  let revealed = false;
  let alt = false;
  let openLeft = 0;
  let shift = 0;
  let drag = null;
  let swiped = false;
  let holdTimer = 0;
  let holdRepeat = 0;
  let backRepeated = false;
  let spaceTalk = false;
  const clicks = keyClicks();
  function stopHold() {
    clearTimeout(holdTimer);
    clearInterval(holdRepeat);
    holdTimer = holdRepeat = 0;
  }
  function tap(value, button) {
    type(value, button);
    clicks.play();
  }
  function markArmed(button) {
    for (const node of root.querySelectorAll("button.armed")) node.classList.remove("armed");
    if (button) button.classList.add("armed");
  }
  function clearArmed() {
    for (const node of root.querySelectorAll("button.armed")) node.classList.remove("armed");
  }

  function setAlt(next) {
    alt = next;
    root.classList.toggle("alt", alt);
    for (const node of root.querySelectorAll("[data-key='alt']")) node.classList.toggle("held", alt);
  }

  function flip() {
    page = page === "letters" ? "other" : "letters";
    lettersFace.hidden = page !== "letters";
    otherFace.hidden = page !== "other";
    root.dataset.page = page;
    root.classList.toggle("page-other", page === "other");
  }

  function type(value, button) {
    if (value === "page") {
      flip();
      return;
    }
    if (value === "alt") {
      setAlt(!alt);
      return;
    }
    const key = value === "↑" ? "ArrowUp" : value === "↓" ? "ArrowDown" : value === "enter" ? "Enter" : value;
    const code = value === "↑" ? "ArrowUp" : value === "↓" ? "ArrowDown" : value === "enter" ? "Enter" : /^\d$/.test(value) ? `Digit${value}` : "";
    if (/^[1-9]$/.test(value) || value === "↑" || value === "↓" || value === "enter") {
      const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
      const handled = !dispatchEvent(event);
      if (handled || value === "↑" || value === "↓") return;
    }
    const withAlt = alt;
    if (withAlt) setAlt(false);
    if (withAlt && BINDS[value]) {
      dispatchEvent(new KeyboardEvent("keydown", { key: value, code: BINDS[value], altKey: true, bubbles: true, cancelable: true }));
      return;
    }
    if (!lent && !isOpen?.()) return;
    if (value === "back") input.value = input.value.slice(0, -1);
    else if (value === "enter") { (lent ? lent.submit : onEnter)?.(); syncCursor(); return; }
    else if (value === "space") input.value += " ";
    else input.value += value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    onChange?.();
  }

  function bindKey(button, value) {
    button.addEventListener("pointerdown", event => {
      if (event.button) return;
      clicks.unlock();
      if (value !== "page" && value !== "alt") markArmed(button);
      if (value === "space" && dictation) {
        spaceTalk = false;
        holdTimer = setTimeout(() => {
          if (swiped) return;
          spaceTalk = true;
          void dictation.start();
        }, 280);
        return;
      }
      if (value !== "back") return;
      backRepeated = false;
      holdTimer = setTimeout(() => {
        if (swiped) return;
        backRepeated = true;
        tap("back", button);
        holdRepeat = setInterval(() => tap("back", button), 60);
      }, 400);
    });
    button.addEventListener("pointerup", event => {
      const repeated = backRepeated;
      stopHold();
      backRepeated = false;
      clearArmed();
      if (swiped || event.button) return;
      if (value === "space" && dictation) {
        const talked = spaceTalk;
        spaceTalk = false;
        if (talked) dictation.stop();
        else tap(value, button);
        return;
      }
      if (value === "back") { if (!repeated) tap(value, button); return; }
      tap(value, button);
    });
    button.addEventListener("pointercancel", () => {
      stopHold();
      backRepeated = false;
      clearArmed();
    });
  }

  function face(name, rows) {
    const wrap = document.createElement("div");
    wrap.className = "keys-face";
    wrap.dataset.face = name;
    for (const line of rows) {
      const row = document.createElement("div");
      row.className = "keys-row";
      for (const glyph of line) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.key = glyph;
        button.textContent = glyph;
        bindKey(button, glyph);
        row.append(button);
      }
      wrap.append(row);
    }
    const tools = document.createElement("div");
    tools.className = "keys-row tools";
    tools.append(flipButton(), action("space", ""), action("back", "⌫"));
    const edits = document.createElement("div");
    edits.className = "keys-row edits";
    edits.append(action("alt", ALT_LABEL.toLowerCase()), action("enter", "↵"));
    wrap.append(tools, edits);
    return wrap;
  }

  function action(value, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.key = value;
    button.className = `keys-${value}`;
    button.textContent = label;
    if (value === "space") button.setAttribute("aria-label", "Space");
    bindKey(button, value);
    return button;
  }

  function flipButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "keys-flip";
    button.dataset.key = "page";
    button.setAttribute("aria-label", "Switch keyboard page");
    button.append(document.createElement("i"), document.createElement("i"));
    bindKey(button, "page");
    return button;
  }

  function railHeight() {
    const unit = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--locus-grid-major")) || 24;
    return rail.getBoundingClientRect().height || unit * 0.5;
  }

  function maxShift() {
    return Math.max(0, root.offsetHeight - railHeight());
  }

  function applyShift(next, animate) {
    const max = maxShift();
    shift = Math.min(max, Math.max(0, next));
    root.classList.toggle("dragging", !animate);
    root.style.transform = `translateY(${shift}px)`;
    stowed = shift >= max - 1;
    root.classList.toggle("stowed", stowed);
    standing(Math.max(railHeight(), root.offsetHeight - shift));
    dispatchEvent(new Event("locus:keys"));
  }

  function setStowed(next) {
    root.getAnimations().forEach(animation => animation.cancel());
    applyShift(next ? maxShift() : 0, true);
  }

  function beginDrag(event, capture) {
    if (!isPhone() || event.button || drag) return false;
    swiped = false;
    drag = { id: event.pointerId, y: event.clientY, start: shift, t: event.timeStamp, fromStowed: stowed };
    if (capture) {
      event.preventDefault();
      try { (event.currentTarget || rail).setPointerCapture(event.pointerId); } catch {}
    }
    return true;
  }
  root.addEventListener("pointerdown", event => {
    beginDrag(event, event.target === rail || event.target.classList?.contains("keys-rail"));
  });
  addEventListener("pointerdown", event => {
    if (!stowed || !isPhone() || event.button || drag) return;
    const unit = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--locus-grid-major")) || 24;
    if (event.clientY < innerHeight - unit * 2) return;
    beginDrag(event, true);
  });
  function onMove(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const dy = event.clientY - drag.y;
    if (!swiped && Math.abs(dy) < 8) return;
    if (!swiped) {
      swiped = true;
      stopHold();
      backRepeated = false;
      clearArmed();
      try { root.setPointerCapture(event.pointerId); } catch {}
    }
    applyShift(drag.start + dy, false);
  }
  function endDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const fromStowed = drag.fromStowed;
    const dy = event.clientY - drag.y;
    const dt = Math.max(1, event.timeStamp - drag.t);
    const velocity = dy / dt;
    const max = maxShift();
    drag = null;
    stopHold();
    backRepeated = false;
    clearArmed();
    if (!swiped) return;
    const nextStowed = fromStowed
      ? !((max - shift) / Math.max(1, max) >= 0.1 || velocity < -0.15)
      : shift / Math.max(1, max) >= 0.1 || velocity > 0.15;
    setStowed(nextStowed);
  }
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", endDrag);
  addEventListener("pointercancel", endDrag);

  // How much of the screen the keyboard is standing on. Anything that has to stay reachable while
  // someone types -- the door, for one -- centres itself in what is left rather than in the
  // viewport, which is how a centred form ends up behind the keys that are filling it in.
  function standing(pixels) {
    document.documentElement.style.setProperty("--locus-keys-height", `${Math.round(pixels)}px`);
  }
  function layout() {
    const phone = isPhone();
    cursorDisplay.hidden = !phone;
    input.classList.toggle("mobile-key-input", phone);
    matchPromptCursor();
    if (!phone) {
      root.hidden = true;
      input.readOnly = false;
      input.removeAttribute("inputmode");
      standing(0);
      return;
    }
    input.readOnly = true;
    input.setAttribute("inputmode", "none");
    const { unit, rows } = grid();
    const heightUnits = Math.min(10, Math.max(8, rows - 8));
    const used = Math.max(6, heightUnits);
    openLeft = 0;
    root.style.left = "0";
    root.style.width = "100vw";
    root.style.top = "auto";
    root.style.bottom = "env(safe-area-inset-bottom, 0px)";
    root.style.height = `${used * unit}px`;
    root.style.paddingBottom = "0";
    root.style.setProperty("--key-rail", `${unit * 0.5}px`);
    if (!revealed) {
      root.hidden = true;
      applyShift(maxShift(), false);
      standing(0);
      dispatchEvent(new Event("locus:keys"));
      return;
    }
    root.hidden = false;
    applyShift(stowed ? maxShift() : 0, false);
  }
  // The keyboard arrives with the door, not with the page. On the entry screen there is nothing to
  // type into -- a mode is chosen by touching a card -- so a keyboard standing over the lower half
  // is covering the choice it was raised for. Once a mode is entered it opens and stays open;
  // swiping it away is still the visitor's to do.
  function reveal() {
    if (revealed) return;
    revealed = true;
    if (!isPhone()) return;
    // Slide out rather than appear. It is laid out at the far edge with no transition, then given
    // one frame before travelling in, so the keys arrive as a movement the eye can follow instead
    // of a wall of buttons that was not there a moment ago.
    stowed = true;
    layout();
    requestAnimationFrame(() => requestAnimationFrame(() => setStowed(false)));
  }

  input.addEventListener("focus", swallowFocus);

  root.dataset.page = page;
  layout();
  document.fonts?.ready.then(layout);
  addEventListener("resize", layout);
  addEventListener("locus:gridchange", layout);
  return { layout, stow: setStowed, reveal, retarget: bind, target: () => input };
}

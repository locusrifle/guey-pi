import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountDesk } from '../public/js/desk.js';

class Elem {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.id = '';
    this.attrs = {};
    this.textContent = '';
    this.onclick = null;
    this.value = '';
    this.style = {};
    this.dataset = {};
    this.disabled = false;
    this.listeners = {};
    this.classList = {
      add: (...names) => { for (const name of names) this.className = `${this.className} ${name}`.trim(); },
      remove: (...names) => {
        const drop = new Set(names);
        this.className = this.className.split(/\s+/).filter(name => name && !drop.has(name)).join(' ');
      },
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, on) => {
        const has = this.className.split(/\s+/).includes(name);
        const next = on ?? !has;
        if (next && !has) this.classList.add(name);
        if (!next && has) this.classList.remove(name);
      },
    };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === 'id') this.id = v;
    if (k === 'class') this.className = v;
  }
  append(...kids) {
    for (const kid of kids) { kid.parentElement = this; this.children.push(kid); }
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(c => c !== this);
    this.parentElement = null;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel) {
    const wantClass = sel.startsWith('.') ? sel.slice(1) : null;
    const wantId = sel.startsWith('#') ? sel.slice(1) : null;
    const found = [];
    const walk = node => {
      const classes = String(node.className).split(/\s+/);
      if (wantClass && classes.includes(wantClass)) found.push(node);
      if (wantId && node.id === wantId) found.push(node);
      for (const child of node.children) walk(child);
    };
    walk(this);
    return found;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
}

function installDom() {
  const body = new Elem('body');
  globalThis.document = {
    body,
    createElement: tag => new Elem(tag),
    getElementById: id => body.querySelector(`#${id}`),
  };
  globalThis.location = { protocol: 'http:', host: '127.0.0.1:9' };
  return body;
}

function stubRfb({ delay = 0, failImport = false, failConstruct = false, autoDisconnect = 0 } = {}) {
  const instances = [];
  async function loadRfb() {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (failImport) throw new Error('import failed');
    return {
      default: class RFB {
        constructor(target, url) {
          if (failConstruct) throw new Error('construct failed');
          this.target = target;
          this.url = url;
          this.listeners = {};
          this.disconnected = false;
          this.keys = [];
          instances.push(this);
          if (autoDisconnect) setTimeout(() => this._emit('disconnect', { detail: { clean: false } }), autoDisconnect);
        }
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
        _emit(type, event) { for (const fn of this.listeners[type] ?? []) fn(event); }
        disconnect() { this.disconnected = true; this._emit('disconnect', { detail: { clean: true } }); }
        sendKey(keysym, code) { this.keys.push([keysym, code]); }
      },
    };
  }
  return { loadRfb, instances };
}

test('close during a delayed import does not create a panel', async () => {
  const body = installDom();
  const { loadRfb, instances } = stubRfb({ delay: 60 });
  const desk = mountDesk({ loadRfb });
  const opened = desk.open();
  desk.close();
  await opened;
  assert.equal(desk.isOpen(), false);
  assert.equal(body.children.length, 0);
  assert.equal(instances.length, 0);
});

test('rapid close then reopen uses a new RFB and ignores the old disconnect', async () => {
  const body = installDom();
  const { loadRfb, instances } = stubRfb({});
  const desk = mountDesk({ loadRfb });
  await desk.open();
  const old = instances[0];
  desk.close();
  await desk.open();
  assert.equal(desk.isOpen(), true);
  assert.equal(body.children.length, 1);
  assert.equal(instances.length, 2);
  assert.notEqual(instances[1], old);
  old._emit('disconnect', { detail: { clean: false } });
  assert.equal(body.querySelector('.desk-status').textContent, 'connecting');
  assert.equal(desk.isOpen(), true);
  assert.equal(instances[1].disconnected, false);
});

test('import failure leaves no panel so a later open can retry', async () => {
  installDom();
  let fail = true;
  const { loadRfb, instances } = stubRfb({});
  const desk = mountDesk({
    loadRfb: async () => {
      if (fail) throw new Error('import failed');
      return loadRfb();
    },
  });
  await assert.rejects(desk.open(), /import failed/);
  assert.equal(desk.isOpen(), false);
  fail = false;
  await desk.open();
  assert.equal(desk.isOpen(), true);
  assert.equal(instances.length, 1);
});

test('constructor failure removes the partial panel', async () => {
  const body = installDom();
  const { loadRfb } = stubRfb({ failConstruct: true });
  const desk = mountDesk({ loadRfb });
  await assert.rejects(desk.open(), /construct failed/);
  assert.equal(desk.isOpen(), false);
  assert.equal(body.children.length, 0);
});

test('desktop window has portal controls and rotate swaps the box', async () => {
  const body = installDom();
  const { loadRfb } = stubRfb({});
  const desk = mountDesk({ loadRfb });
  await desk.open();
  const panel = body.querySelector('#desk-panel');
  assert.equal(body.querySelector('.desk-keys'), null);
  assert.ok(body.querySelector('.desk-mode'));
  assert.ok(body.querySelector('.desk-left'));
  assert.ok(body.querySelector('.desk-right'));
  assert.ok(body.querySelector('.desk-rotate'));
  assert.equal(body.querySelector('.desk-bar'), null);
  assert.ok(body.querySelector('.desk-controls'));
  assert.equal(body.querySelectorAll('.desk-corner').length, 4);
  const before = { w: panel.style.width, h: panel.style.height };
  const se = body.querySelector('.desk-corner-se');
  const event = (type, extra) => {
    const payload = { button: 0, pointerId: 1, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {}, ...extra };
    for (const fn of se.listeners[type] ?? []) fn(payload);
  };
  event('pointerdown');
  event('pointermove', { clientX: 80, clientY: 40 });
  const screen = body.querySelector('.desk-screen');
  assert.equal(screen.style.width, panel.style.width);
  assert.equal(screen.style.height, panel.style.height);
  assert.ok(parseFloat(panel.style.width) > parseFloat(before.w));
  const grown = { w: panel.style.width, h: panel.style.height };
  body.querySelector('.desk-rotate').onclick();
  assert.equal(panel.style.width, grown.h);
  assert.equal(panel.style.height, grown.w);
});

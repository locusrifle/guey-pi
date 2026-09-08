import { randomUUID } from 'node:crypto';

// Graphical adapter, not a terminal renderer. Pi calls these methods directly.
export function createExtensionUI(changed) {
  const dialogs = new Map();
  const state = { dialogs: [], statuses: {}, widgets: {}, notifications: [], editor: null };
  const update = () => { state.dialogs = [...dialogs.values()].map(d => d.request); changed(); };
  const notify = (message, type = 'info') => {
    state.notifications.push({ message, type });
    state.notifications = state.notifications.slice(-20); update();
  };
  function ask(method, title, fields = {}, opts = {}) {
    if (opts.signal?.aborted) return Promise.resolve(method === 'confirm' ? false : undefined);
    const id = randomUUID();
    return new Promise(resolve => {
      let timer;
      const finish = value => {
        clearTimeout(timer); opts.signal?.removeEventListener('abort', cancel);
        dialogs.delete(id); update(); resolve(value);
      };
      const cancel = () => finish(method === 'confirm' ? false : undefined);
      dialogs.set(id, { request: { id, method, title, ...fields }, finish, cancel });
      opts.signal?.addEventListener('abort', cancel, { once: true });
      if (opts.timeout > 0) timer = setTimeout(cancel, opts.timeout);
      update();
    });
  }
  const unsupported = name => () => notify(`${name} is terminal-only; no graphical adapter yet.`, 'warning');
  const ui = {
    select: (title, options, opts) => ask('select', title, { options }, opts),
    confirm: (title, message, opts) => ask('confirm', title, { message }, opts),
    input: (title, placeholder, opts) => ask('input', title, { placeholder }, opts),
    editor: (title, prefill) => ask('editor', title, { prefill }),
    notify,
    setStatus(key, text) { if (text == null) delete state.statuses[key]; else state.statuses[key] = text; update(); },
    setWidget(key, lines) { if (lines == null) delete state.widgets[key]; else if (Array.isArray(lines)) state.widgets[key] = lines; else unsupported('Component widget')(); update(); },
    setTitle(title) { state.title = title; update(); },
    setEditorText(text) { state.editor = { id: randomUUID(), text, paste: false }; update(); },
    pasteToEditor(text) { state.editor = { id: randomUUID(), text, paste: true }; update(); },
    getEditorText: () => '',
    custom: async () => { unsupported('custom()')(); return undefined; },
    onTerminalInput: () => () => {},
    getToolsExpanded: () => false,
    getEditorComponent: () => undefined,
    getAllThemes: () => [], getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Style the graphical interface with native/public/style.css' }),
    // Extensions may format status text; no ANSI is needed in a browser.
    theme: new Proxy({}, { get: (_, key) => key === 'fg' || key === 'bg' ? (_color, text) => text : text => text }),
  };
  for (const name of ['setFooter','setHeader','setEditorComponent','addAutocompleteProvider','setToolsExpanded','setWorkingIndicator','setHiddenThinkingLabel','setWorkingMessage','setWorkingVisible']) ui[name] = unsupported(name);
  return {
    ui, state, notify,
    respond({ id, value, confirmed, cancelled }) {
      const d = dialogs.get(id);
      if (!d) throw new Error('Dialog expired or already answered');
      if (cancelled) return d.cancel();
      if (d.request.method === 'select' && !d.request.options.includes(value)) throw new Error('Invalid dialog option');
      if (d.request.method !== 'confirm' && typeof value !== 'string') throw new Error('Text response required');
      d.finish(d.request.method === 'confirm' ? confirmed === true : value);
    },
    reset() { for (const d of [...dialogs.values()]) d.cancel(); state.statuses = {}; state.widgets = {}; state.editor = null; update(); },
  };
}

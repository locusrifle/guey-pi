// Native HTML adapter for Pi's AuthInteraction. No OAuth logic or secret storage.
const node = (tag, text, className) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (className) e.className = className; return e; };
const button = (text, action) => { const e = node('button', text); e.type = 'button'; e.onclick = action; return e; };
function link(url, label) {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return node('span', 'Unsupported authorization link');
    const a = node('a', label ?? 'Open sign-in page'); a.href = parsed.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
  } catch { return node('span', 'Invalid authorization link'); }
}

export function mountAuth({ command, chooseModel }) {
  const panel = node('dialog', null, 'guey-auth'); panel.id = 'guey-auth';
  panel.setAttribute('aria-labelledby', 'guey-auth-title');
  const title = node('h1', 'Welcome to Guey'); title.id = 'guey-auth-title';
  const subtitle = node('p', 'Your Pi agent. Your account. Credentials are saved through Pi in the configured profile.', 'auth-subtitle');
  const body = node('div', null, 'auth-body');
  const feedback = node('p', '', 'auth-feedback'); feedback.setAttribute('role', 'status');
  const actions = node('div', null, 'auth-actions');
  panel.append(node('span', 'GUEY / PI SDK', 'auth-eyebrow'), title, subtitle, body, feedback, actions);
  document.body.append(panel);
  const dismissed = new Set();
  let state = null, view = '', first = true, promptId = null;
  let progress, promptArea, message, cancelling = false;
  const fail = error => { feedback.textContent = error.message ?? 'Request failed'; };
  const send = (type, fields) => command(type, fields).catch(fail);
  const open = () => { if (!panel.open) panel.showModal(); };
  const close = () => { if (state?.id) dismissed.add(state.id); panel.close(); body.replaceChildren(); view = ''; promptId = null; };
  async function cancel() {
    if (state?.busy) { cancelling = true; await send('auth_cancel'); cancelling = false; }
    else { close(); await send('auth_dismiss'); }
  }
  panel.addEventListener('cancel', event => { event.preventDefault(); void cancel(); });
  function picker(rows, heading, footer = 'Choose a provider to continue.') {
    title.textContent = heading; feedback.textContent = footer;
    body.replaceChildren();
    const search = node('input'); search.type = 'search'; search.placeholder = 'Find a provider'; search.setAttribute('aria-label', 'Find a provider');
    const list = node('div', null, 'auth-provider-list');
    const paint = () => {
      list.replaceChildren(...rows.filter(r => r.label.toLowerCase().includes(search.value.toLowerCase())).map(r => {
        const item = button(r.label, r.action); item.className = 'auth-provider';
        if (r.note) item.append(node('small', r.note)); return item;
      }));
      if (!list.childElementCount) list.append(node('p', 'No matching providers.'));
    };
    search.oninput = paint; body.append(search, list); paint();
  }
  async function login(providerId) {
    if (!state) throw new Error('GUI login is not enabled for this service');
    first = false; feedback.textContent = ''; open();
    if (state.busy) { renderFlow(); return; }
    if (state.id) dismissed.add(state.id);
    view = 'picker'; title.textContent = 'Sign in to Pi';
    body.replaceChildren(node('p', 'Loading providers…')); actions.replaceChildren(button('Not now', close));
    await send('auth_dismiss');
    const providers = await command('auth_providers');
    if (state.busy || view !== 'picker') return;
    const begin = (p, method) => {
      if (method.ambient) { feedback.textContent = `${method.name} is configured outside Guey (environment or cloud credentials).`; return; }
      // This click is the consent boundary. Merely opening the picker never
      // starts a provider flow, callback listener, authorization or network request.
      send('auth_login', { provider: p.id, method: method.type });
    };
    function showMethods(p) {
      picker(p.methods.map(m => ({ label: m.label, note: m.name, action: () => begin(p, m) })), p.name,
        p.id === 'anthropic' ? 'Claude Pro/Max in third-party harnesses uses paid extra usage, not plan limits.' : 'Pi handles sign-in; Guey does not receive your account password.');
      actions.replaceChildren(button('Back', () => showType()), button('Not now', close));
    }
    function showProviders(type) {
      picker(providers.filter(p => p.methods.some(m => m.type === type)).map(p => ({
        label: p.name, note: p.methods.find(m => m.type === type).name + (p.configured ? ' · configured' : ''),
        action: () => {
          const method = p.methods.find(m => m.type === type);
          // Always show method confirmation / billing context before starting.
          picker([{ label: method.label, note: method.name, action: () => begin(p, method) }], p.name,
            p.id === 'anthropic' && type === 'oauth' ? 'Claude Pro/Max in third-party harnesses uses paid extra usage, not plan limits.' : 'Continue to the provider’s own Pi sign-in flow.');
          actions.replaceChildren(button('Back', () => showProviders(type)), button('Not now', close));
        },
      })), type === 'oauth' ? 'Use a subscription / sign in' : 'Use an API key');
      actions.replaceChildren(button('Back', showType), button('Not now', close));
    }
    function showType() {
      title.textContent = 'Welcome to Guey'; feedback.textContent = 'Choose how you want to connect, just like /login in terminal Pi.';
      body.replaceChildren(button('Use a subscription / sign in', () => showProviders('oauth')), button('Use an API key', () => showProviders('api_key')));
      actions.replaceChildren(button('Not now', close));
    }
    if (providerId) { const p = providers.find(p => p.id === providerId); if (!p) throw new Error('Unknown provider'); showMethods(p); }
    else showType();
  }
  async function logout() {
    if (!state) throw new Error('GUI login is not enabled for this service');
    if (state.busy) { open(); renderFlow(); return; }
    first = false; if (state.id) dismissed.add(state.id);
    view = 'picker'; open(); await send('auth_dismiss');
    const providers = await command('auth_accounts');
    picker(providers.map(p => ({ label: p.name, action: () => {
      picker([{ label: `Remove ${p.name} credentials`, action: () => send('auth_logout', { provider: p.id }) }], 'Sign out?', 'Removes credentials from the configured Pi profile, which may be shared with terminal Pi. Environment/cloud credentials remain.');
    } })), 'Sign out of a provider', 'Only credentials stored in the configured Pi profile can be removed.');
    actions.replaceChildren(button('Close', close));
  }
  function renderFlow() {
    open();
    if (view !== 'flow') {
      view = 'flow'; promptId = null; feedback.textContent = '';
      progress = node('div', null, 'auth-progress');
      promptArea = node('div', null, 'auth-prompt');
      message = node('p'); message.setAttribute('role', 'status');
      body.replaceChildren(message, progress, promptArea);
    }
    title.textContent = state.providerName ?? 'Pi sign-in'; message.textContent = state.message ?? '';
    progress.replaceChildren(...(state.events ?? []).map(e => {
      const row = node('div', null, 'auth-event');
      if (e.type === 'auth_url') { row.append(link(e.url)); if (e.instructions) row.append(node('p', e.instructions)); }
      else if (e.type === 'device_code') { row.append(node('p', 'Enter this code on the provider’s page:'), node('code', e.userCode, 'auth-device-code'), link(e.verificationUri, 'Open device verification')); }
      else { row.append(node('p', e.message)); for (const l of e.links ?? []) row.append(link(l.url, l.label)); }
      return row;
    }));
    const p = state.prompt;
    if (p?.id !== promptId) {
      promptId = p?.id; promptArea.replaceChildren();
      if (p) {
        const form = node('form'); form.autocomplete = 'off';
        const label = node('label', p.message); label.htmlFor = 'auth-answer';
        const field = node(p.type === 'select' ? 'select' : 'input'); field.id = 'auth-answer';
        if (p.type === 'select') for (const o of p.options) { const option = node('option', o.label); option.value = o.id; field.append(option); }
        else { field.type = ['secret', 'manual_code'].includes(p.type) ? 'password' : 'text'; field.placeholder = p.placeholder ?? ''; field.autocomplete = 'off'; field.spellcheck = false; }
        const ok = node('button', 'Continue'); ok.type = 'submit';
        form.onsubmit = async event => {
          event.preventDefault(); ok.disabled = true;
          const value = field.value; field.value = ''; // not the composer or draft/localStorage
          try { await command('auth_answer', { promptId: p.id, value }); feedback.textContent = ''; }
          catch (error) { fail(error); ok.disabled = false; }
        };
        form.append(label, field, ok); promptArea.append(form); field.focus();
      }
    }
    actions.replaceChildren();
    if (state.busy) actions.append(button(cancelling ? 'Cancelling…' : 'Cancel sign-in', cancel));
    else {
      if (state.status === 'success' && state.availableModels) actions.append(button('Choose a model', async () => { close(); await send('auth_dismiss'); chooseModel(); }));
      if (['error', 'cancelled'].includes(state.status)) actions.append(button('Try again', () => login(state.providerId).catch(fail)));
      actions.append(button('Close', async () => { close(); await send('auth_dismiss'); }));
    }
  }
  return {
    login, logout,
    render(next) {
      if (!next) return;
      state = next;
      if ((next.busy || next.status !== 'idle') && !dismissed.has(next.id)) renderFlow();
      else if (first) { first = false; if (!next.configured) void login().catch(fail); }
    },
  };
}

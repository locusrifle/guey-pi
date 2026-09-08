import { randomUUID } from 'node:crypto';
import { CredentialSynchronizationError } from './pi-sdk.mjs';

// Only UI/lifecycle adaptation. Pi owns provider flows, callbacks, token exchange,
// credential persistence, refresh and availability. No credentials enter snapshots.
export function createAuth({ models, changed, assertIdle, timeoutMs = 10 * 60 * 1000 }) {
  let flow = null;
  let state = { status: 'idle', prompt: null, events: [] };
  const update = () => changed();
  function providers() {
    const runtime = models();
    return runtime.getProviders().map(p => ({
      id: p.id, name: p.name,
      configured: runtime.getProviderAuthStatus(p.id).configured,
      methods: [
        ...(p.auth.oauth ? [{ type: 'oauth', name: p.auth.oauth.name, label: p.auth.oauth.loginLabel ?? 'Use a subscription / sign in', subscription: Boolean(p.auth.oauth.isSubscription) }] : []),
        ...(p.auth.apiKey ? [{ type: 'api_key', name: p.auth.apiKey.name, label: 'Use an API key', ambient: !p.auth.apiKey.login }] : []),
      ],
    })).filter(p => p.methods.length);
  }
  function notify(event, current) {
    if (flow !== current || current.controller.signal.aborted) return;
    // Deliberate event allowlist: never expose provider objects or credentials.
    let item;
    if (event.type === 'auth_url') item = { type: event.type, url: event.url, instructions: event.instructions };
    else if (event.type === 'device_code') item = { type: event.type, userCode: event.userCode, verificationUri: event.verificationUri };
    else if (event.type === 'info') item = { type: event.type, message: event.message, links: event.links?.map(l => ({ url: l.url, label: l.label })) };
    else if (event.type === 'progress') item = { type: event.type, message: event.message };
    if (item) { state.events = [...state.events, item].slice(-20); update(); }
  }
  function prompt(request, current) {
    if (flow !== current || current.controller.signal.aborted || request.signal?.aborted) return Promise.reject(new Error('Login cancelled'));
    if (current.pending) return Promise.reject(new Error('Overlapping login prompts'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        request.signal?.removeEventListener('abort', abort);
        current.controller.signal.removeEventListener('abort', abort);
        if (current.pending?.id === id) { current.pending = null; state.prompt = null; update(); }
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(new Error('Login cancelled'));
      current.pending = { id, finish };
      state.prompt = { id, type: request.type, message: request.message, placeholder: request.placeholder,
        ...(request.type === 'select' ? { options: request.options.map(o => ({ id: o.id, label: o.label, description: o.description })) } : {}) };
      request.signal?.addEventListener('abort', abort, { once: true });
      current.controller.signal.addEventListener('abort', abort, { once: true });
      update();
    });
  }
  function begin(providerId, method, logout = false) {
    assertIdle();
    const provider = providers().find(p => p.id === providerId) ?? (logout ? { id: providerId, name: providerId } : null);
    if (!provider) throw new Error('Unknown login provider');
    if (!logout && !provider.methods.some(m => m.type === method && !m.ambient)) throw new Error('Unsupported login method; ambient credentials are configured outside Guey');
    const current = { controller: new AbortController(), pending: null, done: null };
    flow = current;
    state = { id: randomUUID(), status: 'working', providerId, providerName: provider.name, method, prompt: null, events: [], message: logout ? 'Removing stored credentials…' : 'Starting Pi sign-in…' };
    update();
    const timer = setTimeout(() => current.controller.abort(), logout ? 15000 : timeoutMs);
    current.done = (async () => {
      const runtime = models();
      try {
        if (logout) await runtime.logout(providerId, { signal: current.controller.signal });
        else await runtime.login(providerId, method, { signal: current.controller.signal, prompt: p => prompt(p, current), notify: e => notify(e, current) });
        state.status = 'success';
        state.message = logout ? 'Stored credentials removed. Environment and cloud credentials are unchanged.' : 'Signed in. Credentials saved in Guey’s profile. Choose a model to begin.';
        // The same supported catalog refresh used after terminal Pi login. This
        // fetches metadata only, not a model turn; failure cannot undo login.
        if (!logout) {
          state.message = 'Signed in. Updating the provider’s model list…'; update();
          const refreshSignal = AbortSignal.any([current.controller.signal, AbortSignal.timeout(15000)]);
          try {
            const result = await runtime.refresh({ providers: [providerId], allowNetwork: true, signal: refreshSignal });
            state.message = result.aborted || result.errors.size
              ? 'Signed in, but the model list could not be refreshed. Choose a cached model or retry later.'
              : 'Signed in. Choose a model to begin.';
          } catch { state.message = 'Signed in, but the model list could not be refreshed. Choose a cached model or retry later.'; }
        }
      } catch (error) {
        // A cancellation racing the commit can leave saved credentials. Pi tells
        // us explicitly; don't misreport that as an unsaved/cancelled login.
        if (error instanceof CredentialSynchronizationError) {
          state.status = 'warning';
          state.message = logout ? 'Credentials removed, but local model state could not be updated. Restart Guey.' : 'Credentials saved, but local model state could not be updated. Restart Guey; do not repeat sign-in blindly.';
        } else {
          state.status = current.controller.signal.aborted ? 'cancelled' : 'error';
          // Provider exceptions may contain submitted keys/codes. Never log or
          // return them to a transcript/browser; the user can retry explicitly.
          state.message = current.controller.signal.aborted ? 'Sign-in cancelled or timed out.' : 'Pi could not complete sign-in. Check the provider/account and try again.';
        }
      } finally {
        clearTimeout(timer);
        current.pending?.finish(new Error('Login ended'));
        state.prompt = null; state.events = []; flow = null; update();
      }
    })();
    return { started: true };
  }
  return {
    get busy() { return Boolean(flow); },
    snapshot() { const available = models().getAvailableSnapshot(); return { ...state, busy: Boolean(flow), configured: providers().some(p => p.configured), availableModels: available.length }; },
    providers,
    async accounts() {
      const runtime = models();
      return (await runtime.listCredentials({ signal: AbortSignal.timeout(15000) })).map(c => ({ id: c.providerId, name: runtime.getProvider(c.providerId)?.name ?? c.providerId, type: c.type }));
    },
    login: (providerId, method) => begin(providerId, method),
    async logout(providerId) {
      assertIdle();
      const stored = await models().listCredentials({ signal: AbortSignal.timeout(15000) });
      if (!stored.some(c => c.providerId === providerId)) throw new Error('No stored credential to remove; environment credentials are unchanged');
      return begin(providerId, undefined, true); // rechecks idle after enumeration
    },
    answer(id, value) {
      if (!flow?.pending || flow.pending.id !== id) throw new Error('Login prompt expired or already answered');
      if (typeof value !== 'string' || value.length > 20000 || !value.trim()) throw new Error('A nonempty answer is required (maximum 20000 characters)');
      if (state.prompt.type === 'select' && !state.prompt.options.some(o => o.id === value)) throw new Error('Invalid login choice');
      flow.pending.finish(null, value); // never return/persist an answer ourselves
    },
    async cancel() { if (flow) { const current = flow; current.controller.abort(); await current.done; } },
    dismiss() { if (flow) throw new Error('Cancel sign-in before dismissing it'); state = { status: 'idle', prompt: null, events: [] }; update(); },
  };
}

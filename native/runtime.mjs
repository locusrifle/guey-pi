import { EventEmitter } from 'node:events';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, realpathSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { readdir } from 'node:fs/promises';
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  SessionManager, getAgentDir,
} from './pi-sdk.mjs';
import { createExtensionUI } from './extension-ui.mjs';
import { listLiveSessions, liveOwnsSession, publicLiveSession } from './live-sessions.mjs';
import { connectLive } from './live-client.mjs';
import { createAuth } from './auth.mjs';
import { absorbUploads } from './uploads.mjs';

// Pi owns context, persistence, discovery, tools, compaction, retries and replacement.
// GUEY owns one runtime, independent of the number/lifetime of browser connections.
//
// Sessions live where Pi puts them, so the laptop TUI and this GUI are two
// front doors onto one archive: `pi --resume` sees what the phone wrote and the
// phone sees what the terminal wrote. Pi does not lock session files, so the
// single-writer rule is ours to keep — see `owner()` below. Leaving `sessionDir`
// unset makes service handoff work; desktop and tests use an isolated archive.
function viewMessages(session) {
  const entries = session?.sessionManager?.getEntries?.();
  if (!Array.isArray(entries) || !entries.length) return session?.messages ?? [];
  const messages = [];
  for (const entry of entries) {
    if (entry?.type === 'message' && entry.message) messages.push(entry.message);
    else if (entry?.type === 'custom_message') {
      messages.push({
        role: 'custom', customType: entry.customType, content: entry.content,
        display: entry.display, details: entry.details, timestamp: entry.timestamp,
      });
    } else if (entry?.type === 'compaction') {
      messages.push({
        role: 'compactionSummary', summary: entry.summary,
        tokensBefore: entry.tokensBefore, timestamp: entry.timestamp,
      });
    } else if (entry?.type === 'branch_summary') {
      messages.push({
        role: 'branchSummary', summary: entry.summary, fromId: entry.fromId, timestamp: entry.timestamp,
      });
    }
  }
  return messages.length ? messages : (session?.messages ?? []);
}

export async function createRuntime({ cwd = process.cwd(), agentDir = getAgentDir(), stateDir, sessionDir, runtimeDir, liveSessions = true, authentication = false, ownArchive = false, serviceOptions = {} }) {
  const events = new EventEmitter();
  if (sessionDir) mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const roots = ownArchive && sessionDir
    ? [resolve(sessionDir)]
    : [join(agentDir, 'sessions'), ...(sessionDir ? [resolve(sessionDir)] : [])];
  const pointer = join(stateDir, 'active-session');
  let runtime, unsubscribe, partial = null, runningTools = {}, operation = null, failed = null, preflights = 0;
  let attached = null; // set when watching a terminal's live session; see attach()
  const changed = () => events.emit('change');
  const adapter = createExtensionUI(changed);
  const inside = path => roots.some(root => { try { return realpathSync(path).startsWith(realpathSync(root) + sep); } catch { return false; } });
  // A running TUI advertises the session file it owns. Writing to a file another
  // Pi process holds interleaves two transcripts, so we fork instead.
  const live = () => { if (!liveSessions) return []; try { return listLiveSessions(runtimeDir ? { runtimeDir } : {}); } catch { return []; } };
  const owner = (path, sessions = live()) => sessions.find(item => liveOwnsSession(path, [item])) ?? null;
  // Resume the newest session for this cwd if nothing else holds it. If the
  // newest is a live TUI, start fresh — do not fall back to an older fork.
  // ownArchive (stock Guey): only this process's sessionDir. Never auto-open
  // ~/.pi/agent/sessions, including an unadvertised locusrifle writer.
  let sm = SessionManager.create(cwd, sessionDir);
  try {
    const root = join(agentDir, 'sessions');
    const dirs = [];
    if (ownArchive && sessionDir) dirs.push(resolve(sessionDir));
    else {
      dirs.push(root, ...(sessionDir ? [resolve(sessionDir)] : []));
      const listing = await readdir(root, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
      for (const d of listing) if (d.isDirectory()) dirs.push(join(root, d.name));
    }
    const rows = (await Promise.all(dirs.map(dir => SessionManager.listAll(dir).catch(() => [])))).flat();
    const newest = rows
      .filter(s => s.cwd === cwd && s.path && inside(s.path) && existsSync(s.path))
      .sort((a, b) => new Date(b.modified) - new Date(a.modified))[0];
    if (newest && !owner(newest.path)) sm = SessionManager.open(newest.path, sessionDir);
  } catch {}
  try { unlinkSync(pointer); } catch {}
  const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ ...serviceOptions, cwd, agentDir });
    return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent }), services, diagnostics: services.diagnostics };
  };
  runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: sm });
  const savePointer = () => {
    const file = runtime.session.sessionFile;
    if (!file || !existsSync(file)) return;
    writeFileSync(pointer + '.tmp', file, { mode: 0o600 }); renameSync(pointer + '.tmp', pointer);
  };
  const assertIdle = () => {
    if (failed) throw new Error(`Runtime replacement failed; restart GUEY: ${failed}`);
    if (auth?.busy || operation || preflights || adapter.state.dialogs.length || !runtime.session.isIdle) throw new Error('Agent is busy; abort or wait before changing session/model');
  };
  const auth = authentication ? createAuth({ models: () => runtime.services.modelRuntime, changed, assertIdle }) : null;
  const replace = async fn => {
    assertIdle(); operation = 'switching'; changed();
    try { return await fn(); }
    catch (error) { failed = error.message; throw error; }
    finally { operation = null; savePointer(); changed(); }
  };
  const listSessions = async () => {
    const own = sessionDir ? await SessionManager.listAll(sessionDir) : [];
    const sessions = live();
    const root = join(agentDir, 'sessions');
    const dirs = await readdir(root, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    const shared = (await Promise.all([root, ...dirs.filter(d => d.isDirectory()).map(d => join(root, d.name))].map(dir => SessionManager.listAll(dir).catch(() => [])))).flat();
    const files = [...own, ...shared.filter(s => !own.some(o => o.path === s.path))];
    const rows = files.map(s => {
      const held = owner(s.path, sessions);
      const outsideOwn = Boolean(ownArchive && sessionDir && !inside(s.path));
      return {
        id: s.id, path: s.path, cwd: s.cwd, name: s.name, firstMessage: s.firstMessage,
        modified: s.modified, messageCount: s.messageCount,
        copyOnResume: Boolean(held) || outsideOwn,
        liveOwner: held && { pid: held.pid, name: held.name, startedAt: held.startedAt },
      };
    });
    for (const item of sessions) {
      if (rows.some(s => s.path === item.sessionFile || s.liveOwner?.pid === item.pid)) continue;
      rows.push({
        id: item.sessionId ?? `tui-${item.pid}`, path: item.sessionFile, cwd: item.cwd, name: item.name,
        firstMessage: item.firstMessage, modified: item.startedAt, messageCount: item.messageCount,
        copyOnResume: true, liveOwner: { pid: item.pid, name: item.name, startedAt: item.startedAt },
      });
    }
    return rows;
  };
  async function resume(path) {
    assertIdle();
    const item = (await listSessions()).find(s => s.path === path);
    if (!item) throw new Error('Unknown session; choose a listed session');
    // A session no live TUI holds is resumed in place: that is the handoff.
    // One a TUI still holds, or a shared Pi file under ownArchive, is forked.
    const target = item.copyOnResume ? SessionManager.forkFrom(item.path, item.cwd, sessionDir).getSessionFile() : item.path;
    const result = await replace(() => runtime.switchSession(target));
    if (result?.cancelled) throw new Error('Resume was cancelled');
    return result;
  }
  async function bind(session = runtime.session) {
    unsubscribe?.(); adapter.reset(); partial = null; runningTools = {};
    unsubscribe = session.subscribe(event => {
      if (event.type === 'message_update') partial = event.message ?? event.assistantMessageEvent?.partial ?? partial;
      if (event.type === 'message_start' && event.message.role === 'assistant') partial = event.message;
      if (event.type === 'message_end' && event.message.role === 'assistant') partial = null;
      if (event.type === 'tool_execution_start') runningTools[event.toolCallId] = { ...event, status: 'running' };
      if (event.type === 'tool_execution_update' && runningTools[event.toolCallId]) runningTools[event.toolCallId].result = event.partialResult;
      if (event.type === 'tool_execution_end') delete runningTools[event.toolCallId];
      if (event.type === 'agent_settled') { partial = null; runningTools = {}; savePointer(); }
      if (event.type === 'auto_retry_start') adapter.notify(event.errorMessage, 'warning');
      if (event.type === 'compaction_end' && event.errorMessage) adapter.notify(event.errorMessage, 'error');
      events.emit('event', event); changed();
    });
    await session.bindExtensions({
      mode: 'rpc', // Pi's supported headless-with-dialogs capability contract
      uiContext: adapter.ui,
      onError: e => adapter.notify(`${e.extensionPath}: ${e.error}`, 'error'),
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        newSession: options => runtime.newSession(options),
        switchSession: path => resume(path),
        fork: (id, options) => runtime.fork(id, options),
        navigateTree: (id, options) => runtime.session.navigateTree(id, options),
        reload: () => runtime.session.reload(),
      },
      shutdownHandler: () => adapter.notify('Extension requested shutdown. Stop the GUEY process when idle.', 'warning'),
    });
    changed();
  }
  runtime.setRebindSession(bind);
  await bind();
  function decorateStats(session, stats = {}) {
    let cacheHitRate = stats.cacheHitRate;
    for (const entry of session?.sessionManager?.getEntries?.() ?? []) {
      if (entry?.type !== 'message' || entry.message?.role !== 'assistant') continue;
      const usage = entry.message.usage ?? {};
      const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      if (prompt > 0) cacheHitRate = ((usage.cacheRead ?? 0) / prompt) * 100;
    }
    const provider = session?.model?.provider;
    const usingSubscription = provider === 'kimi-coding' || Boolean(runtime.services.modelRuntime?.isUsingSubscription?.(provider));
    return { ...stats, cacheHitRate, usingSubscription };
  }
  function snapshot() {
    if (attached) return attached.snapshot();
    const s = runtime.session;
    const loader = runtime.services.resourceLoader;
    const held = owner(s.sessionFile);
    return {
      sessionId: s.sessionId, sessionFile: s.sessionFile, cwd: runtime.cwd,
      name: s.sessionManager.getSessionName(), model: s.model ? { id: s.model.id, provider: s.model.provider, name: s.model.name, contextWindow: s.model.contextWindow } : null, thinkingLevel: s.thinkingLevel,
      busy: !s.isIdle || Boolean(operation) || preflights > 0 || adapter.state.dialogs.length > 0 || Boolean(auth?.busy), operation, failed,
      ...(auth ? { auth: auth.snapshot() } : {}),
      takenOver: held && { pid: held.pid, name: held.name },
      commands: [...(s.extensionRunner?.getRegisteredCommands() ?? []).map(c => ({ name: c.invocationName, description: c.description })), ...s.promptTemplates.map(p => ({ name: p.name, description: p.description })), ...loader.getSkills().skills.map(s => ({ name: `skill:${s.name}`, description: s.description }))],
      messages: viewMessages(s), partial, runningTools: Object.values(runningTools),
      queue: { steering: s.getSteeringMessages(), followUp: s.getFollowUpMessages() },
      stats: decorateStats(s, s.getSessionStats()), ui: adapter.state,
      resources: { skills: loader.getSkills().skills.map(s => s.name), extensions: loader.getExtensions().extensions.map(e => e.path), tools: s.getAllTools().map(t => t.name) },
      diagnostics: [...runtime.diagnostics, ...(runtime.modelFallbackMessage ? [{ type: 'warning', message: runtime.modelFallbackMessage }] : [])],
    };
  }
  // Watching a terminal session: the GUI's own runtime keeps running untouched
  // underneath, so detaching returns to exactly the session it was in.
  async function attach(pid) {
    const target = live().find(item => item.pid === pid);
    if (!target) throw new Error('That terminal session is no longer advertising itself');
    detach();
    const client = connectLive({ socketPath: target.socketPath, pid: target.pid, onChange: changed });
    try { await client.opened; } catch (error) { client.close(); throw new Error(`Could not attach to pid ${pid}: ${error.message}`); }
    attached = client; changed();
    return publicLiveSession(target);
  }
  function detach() {
    if (!attached) return;
    attached.close(); attached = null; changed();
  }

  async function command(c) {
    // Watching is a window, not a jail. Session switching is GUI chrome:
    // it must not be forwarded to the terminal (which does not implement attach/new/resume).
    const shell = new Set(['detach', 'sessions', 'live', 'attach', 'new', 'resume']);
    if (attached && !shell.has(c.type)) {
      if (attached.state.closed && c.type !== 'snapshot') { detach(); throw new Error('The terminal session ended; you are back on your own session.'); }
      return attached.command(c);
    }
    if (c.type === 'resume') {
      await resume(c.path);
      detach();
      return;
    }
    if (attached && c.type === 'new') detach();
    const s = runtime.session;
    switch (c.type) {
      case 'snapshot': return snapshot();
      case 'sessions': return listSessions();
      case 'live': return live().map(publicLiveSession);
      case 'attach': return attach(c.pid);
      case 'detach': detach(); return;
      case 'auth_providers': if (!auth) throw new Error('GUI login is not enabled for this service'); return auth.providers();
      case 'auth_accounts': if (!auth) throw new Error('GUI login is not enabled for this service'); return auth.accounts();
      case 'auth_login': if (!auth) throw new Error('GUI login is not enabled for this service'); return auth.login(c.provider, c.method);
      case 'auth_logout': if (!auth) throw new Error('GUI login is not enabled for this service'); return auth.logout(c.provider);
      case 'auth_answer': if (!auth) throw new Error('GUI login is not enabled for this service'); auth.answer(c.promptId, c.value); return;
      case 'auth_cancel': await auth?.cancel(); return;
      case 'auth_dismiss': auth?.dismiss(); return;
      case 'models': return (await runtime.services.modelRuntime.getAvailable()).map(m => ({ provider: m.provider, id: m.id, name: m.name }));
      case 'dialog': adapter.respond({ ...c, id: c.dialogId }); return;
      case 'abort': { await auth?.cancel(); const queue = s.clearQueue(); adapter.reset(); await s.abort(); changed(); return queue; }
      case 'dequeue': { const queue = s.clearQueue(); changed(); return queue; }
      case 'prompt': {
        if (auth?.busy) throw new Error('Finish or cancel sign-in before sending a prompt');
        if (failed || operation) throw new Error('Runtime unavailable');
        if (preflights) throw new Error('Another prompt is awaiting acceptance; wait or abort');
        // Checked per prompt, not once at startup: a terminal can claim this
        // session at any moment, and the second writer is the one that corrupts.
        const held = owner(s.sessionFile);
        if (held) throw new Error(`A terminal Pi (pid ${held.pid}) is writing this session. Resume it here to work on a copy, or start a new session.`);
        const images = Array.isArray(c.images) ? c.images.filter(img => img && img.type === 'image' && typeof img.data === 'string' && typeof img.mimeType === 'string').slice(0, 8) : [];
        const text = absorbUploads(typeof c.text === 'string' ? c.text : '', c.files, runtime.cwd);
        if ((!text.trim() && !images.length) || text.length > 200000) throw new Error('Prompt must be 1–200000 characters, or include an image');
        if (c.behavior && !['steer','followUp'].includes(c.behavior)) throw new Error('Unknown queue behavior');
        // SDK prompt resolves on completion; acknowledge only its preflight boundary.
        return new Promise((resolve, reject) => {
          let accepted = false, pending = true;
          preflights++; changed();
          const finishPreflight = () => { if (pending) { pending = false; preflights--; changed(); } };
          s.prompt(text.trim() || 'See attached.', { source: 'rpc', streamingBehavior: c.behavior, ...(images.length ? { images } : {}), preflightResult: ok => { finishPreflight(); if (ok) { accepted = true; resolve({ accepted: true }); } } })
            .then(() => { finishPreflight(); if (!accepted) reject(new Error('Prompt was not accepted')); savePointer(); changed(); })
            .catch(error => { finishPreflight(); if (!accepted) reject(error); else adapter.notify(error.message, 'error'); changed(); });
        });
      }
      case 'new': return replace(() => runtime.newSession());
      case 'model': {
        assertIdle();
        const model = (await runtime.services.modelRuntime.getAvailable()).find(m => m.provider === c.provider && m.id === c.modelId);
        if (!model) throw new Error('Unknown or unauthenticated model');
        assertIdle(); await s.setModel(model, auth ? { persist: true } : undefined); changed(); return;
      }
      case 'name': assertIdle(); if (typeof c.name !== 'string') throw new Error('Name must be text'); s.setSessionName(c.name.slice(0,200)); changed(); return;
      case 'reload': assertIdle(); await s.reload(); changed(); return;
      case 'compact': assertIdle(); return s.compact(typeof c.text === 'string' ? c.text : undefined);
      case 'thinking': {
        if (c.level) { assertIdle(); s.setThinkingLevel(c.level); changed(); return s.thinkingLevel; }
        return { current: s.thinkingLevel, available: s.getAvailableThinkingLevels() };
      }
      case 'session': return {
        sessionId: s.sessionId, sessionFile: s.sessionFile, cwd: runtime.cwd,
        name: s.sessionManager.getSessionName(), thinkingLevel: s.thinkingLevel,
        model: s.model ? { id: s.model.id, provider: s.model.provider } : null,
        stats: s.getSessionStats(),
      };
      case 'copy': return s.getLastAssistantText() ?? '';
      case 'forks': return s.getUserMessagesForForking();
      case 'fork': return replace(() => runtime.fork(c.entryId, { position: c.position }));
      case 'tree': assertIdle(); return s.navigateTree(c.entryId);
      case 'settings': {
        const sm = s.settingsManager;
        if (!sm) throw new Error('Settings are unavailable');
        const read = () => ({
          defaultProvider: sm.getDefaultProvider(), defaultModel: sm.getDefaultModel(),
          defaultThinkingLevel: sm.getDefaultThinkingLevel(), hideThinkingBlock: sm.getHideThinkingBlock(),
          compaction: sm.getCompactionEnabled(), retry: sm.getRetryEnabled(),
          steeringMode: sm.getSteeringMode(), followUpMode: sm.getFollowUpMode(),
          defaultProjectTrust: sm.getDefaultProjectTrust(),
        });
        if (!c.key) return read();
        assertIdle();
        if (c.key === 'hideThinkingBlock') sm.setHideThinkingBlock(Boolean(c.value));
        else if (c.key === 'compaction') sm.setCompactionEnabled(Boolean(c.value));
        else if (c.key === 'retry') sm.setRetryEnabled(Boolean(c.value));
        else if (c.key === 'steeringMode') sm.setSteeringMode(c.value);
        else if (c.key === 'followUpMode') sm.setFollowUpMode(c.value);
        else if (c.key === 'defaultThinkingLevel') sm.setDefaultThinkingLevel(c.value);
        else if (c.key === 'defaultProjectTrust') sm.setDefaultProjectTrust(c.value);
        else throw new Error(`Unknown setting: ${c.key}`);
        await sm.flush(); changed(); return read();
      }
      default: throw new Error(`Unsupported command: ${c.type}`);
    }
  }
  return { events, snapshot, command, attach, detach, session: () => runtime.session, async close() { await auth?.cancel(); detach(); adapter.reset(); await runtime.session.abort(); savePointer(); unsubscribe?.(); await runtime.dispose(); } };
}

// Live TUI session discovery for GUEY-Pi.
//
// The browser runtime owns one official `pi --mode rpc` child. TUI sessions are
// not children of this process: an extension (owned elsewhere) advertises them
// here, and we relay JSONL to a private unix socket. We never spawn a second
// pi against a TUI-owned session file, and we never resume saved history as a
// writable RPC session (two writers).
//
// Extension CONTRACT (runtime, not the package tree):
//   dir  = GUEY_PI_RUNTIME_DIR ?? join(XDG_RUNTIME_DIR ?? '/run/user/'+uid, 'guey-pi')
//          0700
//   advert  <pid>.json  0600  regular file, not a symlink
//     {
//       id: 'tui-'+pid, kind: 'tui', pid, cwd, sessionId, sessionFile,
//       name, socketPath, startedAt
//     }
//   socket  <pid>.sock  0600  unix socket, not a symlink, contained in dir
//   transport: strict LF JSONL. On each accepted connection the TUI sends
//     locus.ready {pi:true, cwd, capabilities:[supported types], source:'tui',
//                  sessionId, sessionFile}
//     then events; command responses are unicast on that socket.
//
// Untrusted extra JSON fields are dropped. Stale / foreign / world-readable
// adverts are omitted, not described.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const ADVERT_MAX_BYTES = 16 * 1024;
const STRING_MAX = 4096;

export function defaultRuntimeDir(env = process.env, uid = process.getuid?.() ?? 0) {
	if (env.GUEY_PI_RUNTIME_DIR) return env.GUEY_PI_RUNTIME_DIR;
	const xdg = env.XDG_RUNTIME_DIR;
	const base = xdg && String(xdg).length ? xdg : `/run/user/${uid}`;
	return join(base, "guey-pi");
}

export function ensureRuntimeDir(dir) {
	if (!dir) return dir;
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	try {
		chmodSync(dir, 0o700);
	} catch {
		// best-effort; discovery still validates the listing
	}
	return dir;
}

export function expectedSocketPath(runtimeDir, pid) {
	return join(runtimeDir, `${pid}.sock`);
}

function noOtherBits(mode) {
	return (mode & 0o077) === 0;
}

function ownedBy(stat, uid) {
	return stat.uid === uid;
}

function boundedString(value, max = STRING_MAX) {
	if (typeof value !== "string") return null;
	if (value.includes("\0")) return null;
	if (value.length > max) return null;
	return value;
}

function safeName(value) {
	if (typeof value !== "string") return undefined;
	const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
	if (!trimmed) return undefined;
	return trimmed.slice(0, 200);
}

export function pidAliveOwned(pid, uid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		const match = status.match(/^Uid:\s+(\d+)/m);
		if (!match) return false;
		return Number(match[1]) === uid;
	} catch {
		return false;
	}
}

export function sameSessionFile(a, b) {
	if (!a || !b || typeof a !== "string" || typeof b !== "string") return false;
	if (a === b) return true;
	try {
		if (realpathSync(a) === realpathSync(b)) return true;
	} catch {
		// one path may not exist
	}
	try {
		return resolve(a) === resolve(b);
	} catch {
		return false;
	}
}

export function containedRealpath(root, candidate) {
	if (!root || !candidate) return null;
	let rootReal;
	let candidateReal;
	try {
		rootReal = realpathSync(root);
		candidateReal = realpathSync(candidate);
	} catch {
		return null;
	}
	const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
	if (candidateReal !== rootReal && !candidateReal.startsWith(prefix)) return null;
	return candidateReal;
}

function readAdvert(filePath, uid) {
	let st;
	try {
		st = lstatSync(filePath);
	} catch {
		return null;
	}
	if (!st.isFile()) return null;
	if (!ownedBy(st, uid) || !noOtherBits(st.mode)) return null;
	if (st.size <= 0 || st.size > ADVERT_MAX_BYTES) return null;
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	return parsed;
}

function validateAdvert(raw, { runtimeDir, uid, filePid }) {
	if (raw.kind !== "tui") return null;
	if (!Number.isInteger(raw.pid) || raw.pid !== filePid) return null;
	if (raw.id !== `tui-${filePid}`) return null;
	if (!pidAliveOwned(filePid, uid)) return null;

	const socketExpected = expectedSocketPath(runtimeDir, filePid);
	const socketGiven = boundedString(raw.socketPath);
	if (!socketGiven) return null;

	let sockStat;
	try {
		sockStat = lstatSync(socketExpected);
	} catch {
		return null;
	}
	if (!sockStat.isSocket()) return null;
	if (!ownedBy(sockStat, uid) || !noOtherBits(sockStat.mode)) return null;

	const socketReal = containedRealpath(runtimeDir, socketExpected);
	const givenReal = containedRealpath(runtimeDir, socketGiven);
	if (!socketReal || !givenReal || socketReal !== givenReal) return null;

	const cwd = boundedString(raw.cwd) ?? undefined;
	const sessionFile = boundedString(raw.sessionFile) ?? undefined;
	const sessionId = boundedString(raw.sessionId, 200) ?? undefined;
	let startedAt;
	if (typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt)) startedAt = raw.startedAt;
	else if (typeof raw.startedAt === "string" && raw.startedAt.length < 80) startedAt = raw.startedAt;

	return {
		id: `tui-${filePid}`,
		kind: "tui",
		pid: filePid,
		cwd,
		sessionId,
		sessionFile,
		name: safeName(raw.name),
		socketPath: socketReal,
		startedAt,
		source: "tui",
	};
}

export function listLiveSessions({
	runtimeDir,
	uid = process.getuid?.() ?? 0,
} = {}) {
	const dir = runtimeDir ?? defaultRuntimeDir();
	const found = [];
	if (!dir || !existsSync(dir)) return found;
	let dirStat;
	try {
		dirStat = lstatSync(dir);
	} catch {
		return found;
	}
	if (!dirStat.isDirectory()) return found;
	if (!ownedBy(dirStat, uid) || !noOtherBits(dirStat.mode)) return found;

	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return found;
	}

	for (const name of names) {
		const match = /^([1-9][0-9]*)\.json$/.exec(name);
		if (!match) continue;
		const filePid = Number(match[1]);
		const filePath = join(dir, name);
		const raw = readAdvert(filePath, uid);
		if (!raw) continue;
		const item = validateAdvert(raw, { runtimeDir: dir, uid, filePid });
		if (item) found.push(item);
	}

	found.sort((a, b) => a.pid - b.pid);
	return found;
}

export function findLiveTarget(id, options) {
	if (typeof id !== "string" || !id.startsWith("tui-")) return null;
	return listLiveSessions(options).find((item) => item.id === id) ?? null;
}

export function publicLiveSession(item) {
	if (!item) return null;
	return {
		id: item.id,
		kind: item.kind,
		pid: item.pid,
		cwd: item.cwd,
		sessionId: item.sessionId,
		sessionFile: item.sessionFile,
		name: item.name,
		startedAt: item.startedAt,
		source: item.source ?? item.kind,
	};
}

export function liveOwnsSession(candidate, live) {
	if (!candidate || typeof candidate !== "string") return false;
	for (const item of live) {
		if (item.kind !== "tui") continue;
		if (item.sessionId && (candidate === item.sessionId || candidate.endsWith(item.sessionId))) {
			return true;
		}
		if (item.sessionFile && sameSessionFile(candidate, item.sessionFile)) return true;
	}
	return false;
}

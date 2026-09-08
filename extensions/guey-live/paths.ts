import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type TuiAdvertisement = {
	id: string;
	kind: "tui";
	pid: number;
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	name?: string;
	socketPath: string;
	startedAt: string;
};

export function currentUid(): number {
	if (typeof process.getuid !== "function") {
		throw new Error("guey-live requires process.getuid()");
	}
	return process.getuid();
}

export function resolveRuntimeDir(): string {
	const uid = currentUid();
	return process.env.GUEY_PI_RUNTIME_DIR ?? join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`, "guey-pi");
}

export function advertisementPath(runtimeDir: string, pid = process.pid): string {
	return join(runtimeDir, `${pid}.json`);
}

export function socketPath(runtimeDir: string, pid = process.pid): string {
	return join(runtimeDir, `${pid}.sock`);
}

function mode777(st: { mode: number }): number {
	return st.mode & 0o777;
}

export function ensureRuntimeDir(dir = resolveRuntimeDir()): string {
	const parent = dirname(dir);
	if (!existsSync(parent)) {
		mkdirSync(parent, { recursive: true, mode: 0o700 });
	}
	try {
		mkdirSync(dir, { mode: 0o700 });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EEXIST") throw error;
	}

	const st = lstatSync(dir);
	if (st.isSymbolicLink()) {
		throw new Error("guey-pi runtime dir is a symlink");
	}
	if (!st.isDirectory()) {
		throw new Error("guey-pi runtime path is not a directory");
	}
	if (st.uid !== currentUid()) {
		throw new Error("guey-pi runtime dir is not owned by the current user");
	}
	chmodSync(dir, 0o700);
	const after = lstatSync(dir);
	if (after.isSymbolicLink()) {
		throw new Error("guey-pi runtime dir is a symlink");
	}
	if (mode777(after) !== 0o700) {
		throw new Error("guey-pi runtime dir must be mode 0700");
	}
	return dir;
}

export function unlinkOwn(path: string): boolean {
	try {
		const parent = lstatSync(dirname(path));
		if (parent.isSymbolicLink()) return false;
	} catch {
		return false;
	}
	let st;
	try {
		st = lstatSync(path);
	} catch {
		return false;
	}
	if (st.isSymbolicLink()) return false;
	if (st.uid !== currentUid()) return false;
	if (!st.isFile() && !st.isSocket()) return false;
	unlinkSync(path);
	return true;
}

export function refuseSymlink(path: string, label: string): void {
	let st;
	try {
		st = lstatSync(path);
	} catch {
		return;
	}
	if (st.isSymbolicLink()) {
		throw new Error(`${label} is a symlink`);
	}
	if (st.uid !== currentUid()) {
		throw new Error(`${label} is not owned by the current user`);
	}
}

export function atomicWriteFile0600(dest: string, contents: string): void {
	refuseSymlink(dest, dest);
	const tmp = join(dirname(dest), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		writeSync(fd, contents);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tmp, dest);
		chmodSync(dest, 0o600);
		const st = lstatSync(dest);
		if (st.isSymbolicLink()) {
			unlinkOwn(dest);
			throw new Error("refusing to leave advertisement as a symlink");
		}
		if (st.uid !== currentUid()) {
			throw new Error("advertisement is not owned by the current user");
		}
	} catch (error) {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* ignore */ }
		}
		try { unlinkSync(tmp); } catch { /* ignore */ }
		throw error;
	}
}

export function writeAdvertisement(path: string, ad: TuiAdvertisement): void {
	atomicWriteFile0600(path, `${JSON.stringify(ad)}\n`);
}

export function ownPaths(runtimeDir: string, pid = process.pid): { json: string; sock: string } {
	return { json: advertisementPath(runtimeDir, pid), sock: socketPath(runtimeDir, pid) };
}

export function cleanupOwnRuntimeFiles(runtimeDir: string, pid = process.pid): void {
	const { json, sock } = ownPaths(runtimeDir, pid);
	unlinkOwn(json);
	unlinkOwn(sock);
}

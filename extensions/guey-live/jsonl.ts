import { StringDecoder } from "node:string_decoder";
import type { Socket } from "node:net";

export function createLfFramer(onLine: (line: string) => void): { push: (chunk: string | Buffer) => void; end: () => void } {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	const take = (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		while (true) {
			const index = buffer.indexOf("\n");
			if (index === -1) break;
			let line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.length > 0) onLine(line);
		}
	};

	const end = () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
			buffer = "";
		}
	};

	return { push: take, end };
}

export function writeJsonl(socket: Socket, value: unknown): boolean {
	if (!socket || socket.destroyed || !socket.writable) return false;
	const line = typeof value === "string" ? value : JSON.stringify(value);
	socket.write(line.endsWith("\n") ? line : `${line}\n`);
	return true;
}

export function attachJsonl(socket: Socket, onLine: (line: string) => void): void {
	const framer = createLfFramer(onLine);
	socket.on("data", (chunk) => framer.push(chunk));
	socket.on("end", () => framer.end());
}

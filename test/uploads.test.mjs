import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absorbUploads } from "../native/uploads.mjs";

describe("phone uploads", () => {
	it("writes attachments into cwd/uploads and names them in the prompt", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "guey-uploads-"));
		try {
			const text = absorbUploads("here", [
				{ name: "notes.txt", data: Buffer.from("hello").toString("base64") },
			], cwd);
			const dest = join(cwd, "uploads", "notes.txt");
			assert.equal(text, `here\n\n[uploaded file: ${dest}]`);
			assert.equal(await readFile(dest, "utf8"), "hello");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps a traversing name inside the uploads directory", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "guey-uploads-"));
		try {
			absorbUploads("", [{ name: "../../etc/passwd", data: "" }], cwd);
			assert.deepEqual(await readdir(join(cwd, "uploads")), ["passwd"]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("leaves the text alone when nothing is attached", () => {
		assert.equal(absorbUploads("plain", undefined, "/nonexistent"), "plain");
		assert.equal(absorbUploads("plain", [], "/nonexistent"), "plain");
	});

	it("supplies text for a prompt that is only an attachment", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "guey-uploads-"));
		try {
			const text = absorbUploads("", [{ name: "a.bin", data: "AAAA" }], cwd);
			assert.ok(text.trim().startsWith("[uploaded file:"));
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

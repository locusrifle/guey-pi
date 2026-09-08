import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A phone has no filesystem the agent can reach. An attachment that is not an
// image therefore lands on disk first and enters the turn as a path, because a
// path is a thing every tool already knows how to open. `uploads/` sits in the
// session's own cwd for the same reason.
//
// Shared by both front doors: the native runtime owns its session and the live
// client watches a terminal's, but a file from the phone arrives the same way
// on either, and a second copy of this would drift.
export function absorbUploads(text, files, cwd) {
  if (!Array.isArray(files) || !files.length) return text;
  const dir = join(cwd, 'uploads');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let out = text;
  for (const file of files.slice(0, 8)) {
    if (!file?.name || typeof file.data !== 'string') continue;
    const name = String(file.name).replace(/^.*[/\\]/, '').replace(/[^\w.+-]+/g, '_') || 'file';
    const dest = join(dir, name);
    writeFileSync(dest, Buffer.from(file.data, 'base64'));
    out = `${out.trim()}\n\n[uploaded file: ${dest}]`.trim();
  }
  return out;
}

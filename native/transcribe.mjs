import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY = join(homedir(), '.config/guey/openai_api_key');

export async function transcribeAudio(buffer, mime = 'audio/webm') {
  const key = (await readFile(KEY, 'utf8')).trim();
  if (!key) throw new Error('OpenAI key file is empty');
  const ext = mime.includes('wav') ? 'wav' : mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), `clip.${ext}`);
  form.append('model', 'gpt-4o-mini-transcribe');
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`transcribe ${response.status}`);
  try { return JSON.parse(body).text?.trim() ?? ''; }
  catch { return body.trim(); }
}

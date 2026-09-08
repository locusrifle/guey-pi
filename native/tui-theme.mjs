import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PI_THEME_DIR } from './pi-sdk.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const builtin = PI_THEME_DIR;
const packaged = join(here, '../themes');

function ansi256(n) {
  if (n < 16) {
    return ['#000000', '#aa0000', '#00aa00', '#aa5500', '#0000aa', '#aa00aa', '#00aaaa', '#aaaaaa',
      '#555555', '#ff5555', '#55ff55', '#ffff55', '#5555ff', '#ff55ff', '#55ffff', '#ffffff'][n];
  }
  if (n >= 232) {
    const v = (8 + (n - 232) * 10).toString(16).padStart(2, '0');
    return `#${v}${v}${v}`;
  }
  const x = n - 16;
  const conv = c => (c ? (55 + c * 40).toString(16).padStart(2, '0') : '00');
  return `#${conv(Math.floor(x / 36))}${conv(Math.floor((x % 36) / 6))}${conv(x % 6)}`;
}

function paint(value, vars, seen = new Set()) {
  if (value === '' || value == null) return paint(vars.text, vars, seen) || '#d4d4d4';
  if (typeof value === 'number') return ansi256(value);
  if (typeof value === 'string' && vars[value] && !seen.has(value)) {
    seen.add(value);
    return paint(vars[value], vars, seen);
  }
  return String(value);
}

async function loadTheme(name, agentDir) {
  const paths = [
    join(agentDir, 'themes', `${name}.json`),
    join(packaged, `${name}.json`),
    join(builtin, `${name}.json`),
    join(builtin, 'dark.json'),
  ];
  for (const path of paths) {
    try {
      const theme = JSON.parse(await readFile(path, 'utf8'));
      if (theme?.colors) return theme;
    } catch {}
  }
  throw new Error('no TUI theme');
}

function darkPage(hex) {
  const n = Number.parseInt(String(hex).replace('#', ''), 16);
  if (!Number.isFinite(n)) return true;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 < 140;
}

function rootBlock(theme) {
  const vars = theme.vars ?? {};
  const extra = theme.export ?? {};
  const pageBg = extra.pageBg ?? '#18181e';
  const lines = [':root {'];
  lines.push(`  color-scheme: ${darkPage(pageBg) ? 'dark' : 'light'};`);
  for (const [key, value] of Object.entries(theme.colors)) {
    lines.push(`  --tui-${key}: ${paint(value, vars)};`);
  }
  lines.push(`  --tui-pageBg: ${pageBg};`);
  lines.push(`  --tui-cardBg: ${extra.cardBg ?? extra.pageBg ?? '#1e1e24'};`);
  lines.push('}');
  return lines.join('\n');
}

export async function tuiThemeCss(themeName = 'dark', agentDir = join(homedir(), '.pi/agent')) {
  const raw = String(themeName);
  const pair = raw.includes('/') ? raw.split('/') : null;
  if (pair?.length === 2 && pair[0] && pair[1]) {
    const light = rootBlock(await loadTheme(pair[0], agentDir));
    const dark = rootBlock(await loadTheme(pair[1], agentDir));
    return `@media (prefers-color-scheme: light) {\n${light}\n}\n@media (prefers-color-scheme: dark) {\n${dark}\n}`;
  }
  return rootBlock(await loadTheme(raw || 'dark', agentDir));
}

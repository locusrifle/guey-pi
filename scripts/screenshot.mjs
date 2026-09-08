// Reproducible README image: real server + browser, synthetic conversation.
// No Pi profile, credentials, session files, provider calls or live services.
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createGueyServer } from '../server.mjs';

const temp = await mkdtemp(join(tmpdir(), 'guey-screenshot-'));
const data = {
  sessionId: 'demo', cwd: '/workspace/hello-pi', name: 'A browser, a real agent',
  model: { provider: 'demo', id: 'example-model', contextWindow: 200000 },
  thinkingLevel: 'medium', busy: false, operation: null, failed: null,
  commands: [], partial: null, runningTools: [], queue: { steering: [], followUp: [] },
  stats: { tokens: { input: 1200, output: 320, cacheRead: 0, cacheWrite: 0 }, cost: 0, contextUsage: { tokens: 1520, contextWindow: 200000, percent: 0.76 } },
  ui: { dialogs: [], statuses: {}, widgets: {}, notifications: [], editor: null },
  resources: { skills: [], extensions: [], tools: ['read', 'bash', 'edit', 'write'] }, diagnostics: [],
  messages: [
    { role: 'user', content: 'What makes Guey different from a terminal in a browser?' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Guey is a **native graphical interface** to Pi. The browser renders conversations and tool output directly; it does not emulate a terminal.\n\nPi still owns the agent loop, tools, models and sessions. Guey supplies the interface.\n\n- **Keep working:** closing the browser does not stop the agent.\n- **Use your Pi setup:** credentials and settings can be shared with the terminal.\n- **Stay in control:** model selection, session navigation and supported extension dialogs are graphical.\n\nStart in a project with:' },
      { type: 'text', text: '`npm start -- /path/to/your/project`\n\nKeep the console private: the agent runs with your account’s permissions.' },
    ] },
  ],
};
let app, browser;
try {
  app = await createGueyServer({ product: 'stock', host: '127.0.0.1', port: 0, stateDir: temp, agentDir: join(temp, 'agent'), runtime: { events: new EventEmitter(), snapshot: () => data, command: async () => ({}), close: async () => {} } });
  const address = await app.listen();
  const executablePath = existsSync(chromium.executablePath()) ? undefined : ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1120, height: 640 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.locator('.entry-line.assistant').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await mkdir(resolve(import.meta.dirname, '../docs/images'), { recursive: true });
  await page.screenshot({ path: resolve(import.meta.dirname, '../docs/images/guey.png') });
} finally {
  await browser?.close();
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}

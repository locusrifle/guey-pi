# Contributing

Guey is an early preview. Small, reproducible improvements are welcome; discuss larger changes in an issue first.

## Local development

Use Linux and Node.js 22.19 or newer. Run `npm ci`, then `npx playwright install chromium`. Start with `npm start -- /absolute/workspace` and stop with `./desktop/guey stop`.

Run `npm run test:all` before submitting. Packaging changes also need `npm run build:desktop && npm run test:desktop`. Include test failures and browser skips in your report rather than omitting them.

## What belongs where

- `native/runtime.mjs` and the Pi SDK own runtime integration. Do not reimplement Pi's agent loop or session-file format.
- `native/public/stock.html`, `js/stock.js` and `css/guey.css` compose the stock GUI.
- `native/public/js/harness.js` is shared UI behavior.
- The personal shell (`index.html`, `site.js`, `locusrifle.css`, `desk.js`) consumes the shared implementation. Personal features should not become stock defaults by accident.
- `extensions/guey-live/` is the optional terminal ownership/watch bridge.
- `desktop/` owns Linux launch and archive delivery.

For a fix, describe the observable failure, add a regression test, and exercise a failure path as well as the successful path. Use synthetic credentials and isolated test directories. Never attach real sessions, tokens, screenshots containing private work, or generated state.

Avoid unrelated formatting and dependency upgrades. Match the pinned Pi SDK version when inspecting upstream APIs. Document compatibility gaps rather than promising support for arbitrary terminal UI components.

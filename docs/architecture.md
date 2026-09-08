# Architecture

```text
Browser ── HTTP / WebSocket ── Guey server ── Pi SDK runtime
                                  │                 │
                         stock / personal      tools, providers,
                           composition         sessions, extensions

Terminal Pi + guey-live ── private Unix socket ── watch bridge
```

Guey is a native browser renderer around the stock Pi SDK. There is no terminal emulator. Pi owns model communication, the agent loop, tools, compaction, persistence and extension behavior. Guey adapts snapshots, commands and supported extension interactions into browser UI.

| Component | Responsibility |
| --- | --- |
| `server.mjs` | HTTP assets, private binds, Host/Origin checks, WebSockets, store ownership |
| `native/runtime.mjs` | SDK lifecycle, session ownership, snapshots and commands |
| `native/auth.mjs` | Pi provider interaction adapter; not server access control |
| `native/extension-ui.mjs` | Graphical dialogs and supported extension UI |
| `native/public/js/harness.js` | Shared conversation renderer and browser connection |
| `native/product.mjs` | Explicit stock/personal composition |
| `native/live-*.mjs` | Terminal discovery and watch client |
| `extensions/guey-live/` | Terminal-side advertisement and command bridge |
| `desktop/` | Linux process launcher, installer and archive builder |

## Two compositions, one runtime implementation

**Guey** is the default launcher experience. Its shell is `stock.html`, `js/stock.js` and `css/guey.css`. It aims to follow Pi's TUI information and behavior, including semantic theme colors, rather than imitating the Pi website.

**locusrifle** is an experimental personal consumer: `index.html`, `js/site.js`, `css/locusrifle.css` and the desk modules. Its canvas, drop-down chrome, desktop control, uploads and phone integrations are not prerequisites for stock Guey. Some server modules are still coupled; this repository does not claim a completed library/application extraction.

`npm start` explicitly uses the stock launcher. The low-level `server.mjs` entry retains personal-composition compatibility and is not the recommended first-run command.

## Lifecycle and ownership

A browser connection is not the agent process. Disconnecting removes a client; it does not abort the turn. Reconnecting retrieves current state. Stopping the launcher or restarting the server ends the running turn.

One process owns a Guey state store. The terminal bridge addresses a different problem: one writer per Pi session file. An advertised live terminal is watched or its session is copied, not resumed by a second writer. A terminal without `guey-live` cannot be detected by this guard. The launcher therefore keeps its normal session archive separate from the terminal archive.

## Compatibility limits

The shared SDK does not imply full TUI rendering parity. Terminal-only custom widgets may not work graphically. Watching does not transfer ownership of terminal prompts or synchronize editor drafts, viewport state and arbitrary extension UI. Provider access depends on upstream Pi, provider policies and the user's account. Test providers establish the interaction contract, not real-world entitlement or billing behavior.

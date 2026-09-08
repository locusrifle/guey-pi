# Changelog

## 0.2.0 — preview candidate

First GitHub release candidate of Guey, a native browser interface to Pi 0.85.0.

- Stock graphical shell with shared Pi SDK runtime, conversations, streaming tools, models and sessions.
- Provider sign-in and API-key setup through Pi's own interaction APIs.
- Browser reconnect without tying the agent's lifetime to a tab.
- Optional `guey-live` terminal discovery/watch bridge.
- Linux launcher, portable archive builder and per-user installer.
- Explicit stock and experimental personal compositions sharing one implementation.

### Release preparation

- Stock launcher as the documented default, with loopback-first networking.
- Complete runtime module packaging, dependency lockfile and archive checksums.
- Corrected profile documentation and credential-sharing notices.
- Restored visibility of the stock model picker and personal reconnect status.
- Updated regression tests to match Pi theme and terminal bridge behavior.
- Added CI, contribution/security guidance and third-party license notices.
- Excluded development history, local records, personal maintenance skill and an unlicensed-provenance keyboard sound.

The Linux archive and `npm ci` tree no longer include `@earendil-works/pi-server` or the html2canvas npm packages (the browser still uses the vendored ESM files). Other-OS esbuild binaries and Pi docs/examples are pruned after install. The Pi Node SDK remains the runtime — a compiled `pi` CLI is not importable.

This is a preview, not a claim of full Pi TUI parity, official endorsement, a security sandbox, or universal Linux compatibility.

# 0.2.0 preview release review

This candidate is prepared separately from the developer's live application. It starts a new Git history rather than publishing private development history or local recordings. The running personal service was not restarted or changed by release preparation.

## Verified locally — 2026-09-08

Environment: x86-64 Linux, Node.js 26.7.0, 24.19.0 and 22.19.0, Pi SDK 0.85.0, real Chromium.

- Fresh dependency installation from `package-lock.json` in the exported tree.
- `npm audit --omit=dev`: zero reported vulnerabilities at review time (not a security guarantee).
- `npm run test:all`: **72 passed, 0 failed, 0 skipped**, independently on Node 26.7.0, 24.19.0 and the minimum supported Node 22.19.0.
- Browser coverage includes both product compositions, model/setup interaction with fake providers, queued messages, streaming tools, session watching, reconnect and supported dialogs.
- Runtime/server tests exercise private-bind rejection, request boundaries, store ownership and advertised terminal/session handling.
- Ordinary launcher (without `GUEY_ISOLATE`) booted with an empty HOME and scrubbed environment, served stock Guey on an allocated loopback port, rejected a foreign Origin with 403, and stopped with its endpoint closed. No Tailscale, real credentials or live deployment was used.
- The stock model-picker regression failed before its CSS correction and passed afterward. The reconnect test likewise detected hidden connection state before the correction. Stale theme and bridge expectations were updated separately.
- README image generated against the real server with an explicitly synthetic runtime; no model call or private transcript.
- Source-pattern scan found no matching live credential formats or developer home/tailnet addresses in the release payload. This is a review, not a guarantee that automated scanning finds every possible secret.
- Omitted old Git history, recordings/state, personal operations skill and personal theme registration. Removed the keyboard sound with unknown redistribution provenance. Added upstream font and browser-library license notices.

- `npm run build:desktop` then `npm run test:desktop`: **2 passed, 0 skipped**, including Chromium against the extracted archive. Other-OS esbuild binaries and Pi docs/examples are pruned; unused html2canvas npm packages are not installed. Archive ~52 MB (was ~156 MB).

Remote CI is recorded after the first public push. Source tests alone were not treated as artifact verification.

## Publication gates

- [x] Author requested maximum openness: original Guey code is MIT licensed, matching Pi's permissive licensing.
- [ ] Remote CI on Node 22.19.0 and Node 24 after the first public push.
- [x] Experimental personal modules remain in the source tree; `npm start` and the Linux launcher run stock Guey.
- [x] Author asked for maximum openness: MIT license and a public GitHub repository.
- [ ] Preview GitHub tag/release with the rebuilt archive after push. No npm publication or Pi gallery listing is implied.

## Not verified

Real provider authorization, paid model calls, subscription entitlements, multiple Linux distributions/architectures, and full stock Pi TUI parity. Neither tests nor checksums establish a security sandbox. Archive checksums detect corruption; no signing identity is configured.

## Releasing from this repository

1. Stop any candidate launcher before replacing its files. Do not restart a separate personal deployment as part of a release.
2. Run a fresh `npm ci`, install Chromium, and run `npm run test:all`.
3. Build with `npm run build:desktop`; run `npm run test:desktop` against the resulting archive.
4. Check the archive contents, notices and checksums. Attach only the newly verified archive and its `.sha256` file, not local records or an old build.
5. Tag the reviewed commit, create a GitHub **pre-release**, and describe remaining limits. Keep `private: true` in package.json unless npm publication is a separate deliberate decision.

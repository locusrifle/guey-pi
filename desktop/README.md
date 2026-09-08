# Guey for Linux (preview)

A graphical front door to stock Pi. No Pi CLI, terminal emulator, or `guey-live`
extension is required to start. The launcher listens on loopback, allocates a
port, prints the URL, and tries to open a browser. Closing the page leaves Pi
running.

This launcher is a delivery vehicle for stock Guey, not a third product. The
repository also contains an experimental personal composition; `guey start`
runs the stock one.

## Requirements

Linux, Node.js **22.19 or newer**, bash, util-linux (`flock`), and a modern
browser. `xdg-open` is used when present. The archive includes production npm
dependencies, not Node or a browser. Native addons need compatible
libc/system libraries. This is not an AppImage, Flatpak, sandbox, or universal
Linux binary.

## Download, run and install

No release is published yet. A maintainer builds the local archive with
`npm run build:desktop` (npm registry access, GNU tar and gzip). The lockfile
pins dependencies; lifecycle scripts are disabled; the build uses an empty
temporary HOME/npm config, not the checkout's `node_modules`.

```sh
sha256sum -c guey-0.2.0-linux-x64.tar.gz.sha256
tar -xzf guey-0.2.0-linux-x64.tar.gz
cd guey-0.2.0-linux-x64
sha256sum -c SHA256SUMS
./desktop/guey start                 # portable run
# Or install for this user:
./desktop/install.sh
```

The installer copies to `$XDG_DATA_HOME/guey-desktop` (default
`~/.local/share/guey-desktop`), adds `applications/guey.desktop`, and creates
`~/.local/bin/guey`. It refuses to overwrite an unrelated launcher. Node must be
on your desktop session PATH. No system service, autostart, Pi installation, or
install-time networking.

```sh
~/.local/bin/guey start
~/.local/bin/guey status
~/.local/bin/guey stop
~/.local/share/guey-desktop/desktop/install.sh uninstall
```

Stop before uninstall or update. Uninstall keeps application state. To update:
stop, uninstall, install the new archive; keep the previous archive for
rollback. The desktop entry also has **Stop Guey**. Stop aborts an active turn
and cancels sign-in. Starting again reopens the existing process. There is no
tray or in-page Quit.

`GUEY_NO_BROWSER=1 guey start` prints the URL without opening a browser.

## Bind

Default: `127.0.0.1` and an allocated port. No Tailscale (or other) CLI is
required for basic use.

Optional private bind — loopback or CGNAT tailnet IPv4 (`100.64.0.0/10`) only:

| Variable | Role |
|---|---|
| `GUEY_DESKTOP_HOST` | Bind address (default `127.0.0.1`) |
| `GUEY_DESKTOP_PORT` | Port; `0` or unset allocates |
| `GUEY_DESKTOP_URL` | Printed URL and extra allowed Origin |
| `GUEY_DESKTOP_ORIGINS` | Extra allowed Origins, comma-separated |

If you set a hostname URL, set a fixed port as well so the URL matches the
listen address. Inherited `LOCUS_SITE_*` / `GUEY_ORIGINS` are ignored; only the
variables above configure this process.

Host/Origin checks reject foreign pages. Guey is still an **unauthenticated,
shell-capable agent**: other local processes can reach a loopback bind, and
tools run with your account. Never proxy it publicly.

## Credentials, sessions, resources

By default Guey uses your Pi profile `~/.pi/agent` for settings, extensions,
skills, themes, and provider credentials. `/login` and `/logout` go through
Pi's `ModelRuntime` against that profile, so they affect terminal Pi too.

Sessions are a **separate archive** under the desktop state directory
(`sessions/`). The launcher does not auto-resume `~/.pi/agent/sessions`. A
terminal that advertises with `guey-live` is forked or watched, not overwritten.

`GUEY_ISOLATE=1` is a packaged-test sandbox: agent dir under desktop state, no
extension/skill/theme/context discovery, no live-session watch, default cwd
`workspace/` under state. It is **not** security isolation and does **not**
isolate provider auth — `ModelRuntime` still reads `~/.pi/agent/auth.json` and
`models.json`. Ambient provider environment variables still apply.

## State

Resolved in this order:

1. `GUEY_DESKTOP_STATE_DIR` (must be absolute)
2. `$XDG_STATE_HOME/guey-desktop`
3. `~/.local/state/guey-desktop`

Typical files: `sessions/`, `desktop.log`, endpoint metadata, store lock.
`agent/` is the isolate sandbox, not the default credential store.

Default workspace is your home directory. `guey start /absolute/path/to/project`
while stopped chooses another. `/new` starts a fresh session in Guey's archive;
`/resume` lists that archive; `/model` chooses an authenticated model.

## First run

A profile without usable credentials opens account setup. Choose **Use a
subscription / sign in** or **Use an API key**, then a provider. Nothing begins
authorization until you pick a method. `/login` reopens setup.

Guey calls Pi's `ModelRuntime.login()`, not a separate OAuth stack. Open the
link Pi provides, authorize with the provider, and paste a code when asked.
The provider list comes from installed Pi, not a hardcoded Guey menu.
Anthropic Claude Pro/Max through a third-party harness uses paid extra usage,
not plan limits. API keys are entered in a masked field, never the composer.

Successful sign-in writes through Pi into `~/.pi/agent/auth.json` (mode `0600`)
by default. No model request is made until you send a prompt. `/logout` removes
stored provider credentials in that same profile.

## Limits

Not a sandbox. Checksums detect corruption, not a malicious publisher. Public
distribution still needs licensing, signing, and release review. Tests exercise
the isolated-resource sandbox and fake providers; they do not perform real
account authorization or paid model calls.

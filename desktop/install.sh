#!/bin/sh
# Per-user copy only. No sudo, Pi installation, service, autostart or network.
set -eu
umask 077
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DATA=${XDG_DATA_HOME:-$HOME/.local/share}
TARGET=$DATA/guey-desktop
ENTRY=$DATA/applications/guey.desktop
BIN=$HOME/.local/bin/guey
case "$DATA" in /*) ;; *) echo 'XDG_DATA_HOME must be absolute' >&2; exit 1;; esac
# Desktop Entry Exec has its own quoting/field-code grammar, not shell grammar.
case "$DATA" in *'%'*|*'"'*|*'\'*|*'$'*|*'`'*|*'
'*) echo 'Unsupported characters in install path' >&2; exit 1;; esac
case "${1:-install}" in
  install)
    [ "$#" -le 1 ] || { echo 'Usage: install.sh [install|uninstall]' >&2; exit 1; }
    [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ] || { echo "Already installed: $TARGET (stop and uninstall before replacing)" >&2; exit 1; }
    [ ! -e "$ENTRY" ] && [ ! -L "$ENTRY" ] || { echo "Desktop entry already exists: $ENTRY" >&2; exit 1; }
    [ ! -e "$BIN" ] && [ ! -L "$BIN" ] || { echo "Launcher already exists: $BIN" >&2; exit 1; }
    [ -f "$SOURCE/DESKTOP-BUNDLE" ] || { echo 'Install from a built desktop archive, not the source checkout' >&2; exit 1; }
    command -v node >/dev/null || { echo 'Install Node.js >=22.19 first' >&2; exit 1; }
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a<22||(a===22&&b<19)?1:0)' || { echo 'Node.js >=22.19 required' >&2; exit 1; }
    command -v flock >/dev/null || { echo 'Install util-linux first' >&2; exit 1; }
    mkdir -p -- "$DATA" "$DATA/applications" "$HOME/.local/bin"
    mkdir -- "$TARGET"
    trap 'rm -rf -- "$TARGET"; rm -f -- "$ENTRY" "$BIN"' EXIT HUP INT TERM
    cp -a -- "$SOURCE/." "$TARGET/"
    printf '[Desktop Entry]\nType=Application\nName=Guey\nComment=Local Pi coding agent\nExec="%s/desktop/guey" start\nIcon=%s/native/public/favicon.svg\nTerminal=false\nCategories=Development;\nActions=Stop;\n\n[Desktop Action Stop]\nName=Stop Guey (aborts active turn)\nExec="%s/desktop/guey" stop\n' "$TARGET" "$TARGET" "$TARGET" > "$ENTRY"
    ln -s -- "$TARGET/desktop/guey" "$BIN"
    trap - EXIT HUP INT TERM
    echo "Installed: $TARGET"
    echo "Open Guey from your application menu, or run: $BIN"
    ;;
  uninstall)
    [ "$#" -eq 1 ] || exit 1
    [ -f "$TARGET/DESKTOP-BUNDLE" ] && [ ! -L "$TARGET" ] || { echo "Not a Guey install: $TARGET" >&2; exit 1; }
    if STATUS=$("$TARGET/desktop/guey" status); then echo 'Stop Guey before uninstalling' >&2; exit 1; fi
    [ "$STATUS" = 'Guey is stopped' ] || { echo 'Could not verify stopped state; refusing uninstall' >&2; exit 1; }
    # Only remove our entry, not a replacement owned by another app.
    if [ -f "$ENTRY" ]; then grep -F "Exec=\"$TARGET/desktop/guey\" start" "$ENTRY" >/dev/null || { echo 'Desktop entry changed; refusing uninstall' >&2; exit 1; }; fi
    if [ -L "$BIN" ] && [ "$(readlink -- "$BIN")" = "$TARGET/desktop/guey" ]; then rm -- "$BIN"; fi
    rm -f -- "$ENTRY"
    rm -rf -- "$TARGET"
    echo 'Uninstalled. State under $XDG_STATE_HOME/guey-desktop (default ~/.local/state/guey-desktop) is kept. Provider credentials stay in your Pi profile (~/.pi/agent).'
    ;;
  *) echo 'Usage: install.sh [install|uninstall]' >&2; exit 1;;
esac

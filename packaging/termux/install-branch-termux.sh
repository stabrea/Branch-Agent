#!/data/data/com.termux/files/usr/bin/sh
# Branch Agent on Android, through Termux. Written by src/install/container-files.ts.
#   sh install-branch-termux.sh <branch-agent-<version>.tgz>     (the file from the release, with its .sha256 beside it)
#   sh install-branch-termux.sh --uninstall
# Conversations and files stay in the folders you started Branch in; nothing else is removed.
set -eu
say() { printf '%s\n' "$*"; }
fail() { printf 'Branch Agent: %s\n' "$*" >&2; exit 1; }
case "${PREFIX:-}" in */com.termux/*) ;; *) fail "This script is for Termux on Android." ;; esac
if [ "${1:-}" = --uninstall ]; then npm uninstall -g branch-agent; say "Branch Agent is removed."; exit 0; fi
PACKAGE="${1:-}"
[ -n "$PACKAGE" ] || fail "Name the branch-agent-<version>.tgz file from the release."
case "$PACKAGE" in *.tgz) ;; *) fail "That is not a branch-agent .tgz file." ;; esac
[ -f "$PACKAGE" ] || fail "$PACKAGE is not here."
[ -f "$PACKAGE.sha256" ] || fail "$PACKAGE.sha256 is missing, so the file cannot be checked. Download it from the same release."
EXPECTED="$(cut -d " " -f 1 < "$PACKAGE.sha256")"
ACTUAL="$(sha256sum "$PACKAGE" | cut -d " " -f 1)"
[ "$EXPECTED" = "$ACTUAL" ] || fail "$PACKAGE does not match its .sha256, so nothing was installed."
if ! command -v node >/dev/null 2>&1; then say "Installing Node.js from Termux..."; pkg install -y nodejs; fi
VERSION="$(node -p 'process.versions.node')"
NEW_ENOUGH="$(node -p '(() => { const [a, b] = process.versions.node.split(".").map(Number); if (a > 25) return "yes"; if (a === 25) return b >= 4 ? "yes" : "no"; return a === 24 && b >= 14 ? "yes" : "no"; })()')"
[ "$NEW_ENOUGH" = "yes" ] || fail "Branch needs Node.js 24.14.0 or newer (on the Node 25 line, 25.4.0 or newer); this phone has $VERSION. Without it a proxy cannot be used at all. Run: pkg upgrade nodejs"
ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  npm install -g --omit=dev --ignore-scripts --no-audit --no-fund "$PACKAGE"
say "Branch Agent is installed. Start it with:  cd ~ && branch start"
say "Then open http://127.0.0.1:3210 in a browser on this phone. To keep it running with the screen off: termux-wake-lock"
say "The browser tools and the desktop app are not available on Android; chat apps, the window and schedules are."

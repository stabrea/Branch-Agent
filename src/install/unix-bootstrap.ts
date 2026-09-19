import { releaseAssets } from "../desktop/release-assets.js";
import { launcherMarker } from "./unix-install.js";

/**
 * `install-branch-agent.sh`, published beside the macOS and Linux downloads: the counterpart of
 * `Install Branch Agent.cmd`. It picks the download for this computer by its full name, checks it
 * against its `.sha256`, unpacks it into a private temporary folder and hands over to the installer
 * inside the app, run by the app's own runtime. It never asks anything and never downloads anything.
 *
 *   sh install-branch-agent.sh [--quiet] [--no-menu-entry] [--repair] [--assistant <file>]
 *                              [--applications | --no-applications]
 *   sh install-branch-agent.sh --uninstall [--delete-data]
 *
 * On a Mac it asks one question, about the Applications folder, unless it was answered on the command
 * line or there is no person at a terminal to ask (mac7/app-icon; see unix-install-cli.ts).
 */
export const unixBootstrapperName = "install-branch-agent.sh";

const asset = (platform: string, arch: string): string => {
  const found = releaseAssets.find((entry) => entry.platform === platform && entry.arch === arch);
  if (!found) throw new Error(`No download is published for ${platform} ${arch}.`);
  return found.name;
};

/** The shell lines that choose the download; an Intel copy of the shell on Apple silicon still gets arm64. */
function chooseDownload(): string[] {
  return [
    'MACHINE="$(uname -s)-$(uname -m)"',
    'if [ "$MACHINE" = Darwin-x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then MACHINE=Darwin-arm64; fi',
    'case "$MACHINE" in',
    `  Darwin-arm64) ASSET=${asset("darwin", "arm64")} ;;`,
    `  Darwin-x86_64) ASSET=${asset("darwin", "x64")} ;;`,
    `  Linux-x86_64) ASSET=${asset("linux", "x64")} ;;`,
    '  *) fail "There is no Branch Agent download for this computer ($MACHINE)." ;;',
    "esac",
  ];
}

/** Only a `branch` command the installer wrote is handed `uninstall`; another program's `branch` is never run. */
function uninstallPart(): string[] {
  return [
    'if [ "${1:-}" = --uninstall ]; then',
    "  shift",
    '  BRANCH="$HOME/.local/bin/branch"',
    '  if [ ! -x "$BRANCH" ]; then say "Branch Agent is not installed for $(id -un), so there is nothing to remove."; exit 0; fi',
    `  if [ -L "$BRANCH" ] || ! grep -qxF "${launcherMarker}" "$BRANCH"; then fail "$BRANCH is not Branch Agent's command, so nothing was removed."; fi`,
    '  exec "$BRANCH" uninstall "$@"',
    "fi",
  ];
}

/**
 * The download is copied into a folder only this person can open before it is checked, and that copy
 * is the one unpacked, so it cannot be swapped between the check and the unpacking.
 */
function checksumPart(): string[] {
  return [
    'SOURCE="$HERE/$ASSET"',
    '[ -f "$SOURCE" ] || fail "Put this file in the same folder as $ASSET and run it again."',
    '[ -f "$SOURCE.sha256" ] || fail "$ASSET.sha256 is missing, so the download cannot be checked. Download it from the same release."',
    'STAGE="$(mktemp -d "${TMPDIR:-/tmp}/branch-agent-setup.XXXXXX")"',
    "trap 'rm -rf \"$STAGE\"' EXIT",
    'ARCHIVE="$STAGE/$ASSET"',
    'cp "$SOURCE" "$ARCHIVE"',
    "EXPECTED=\"$(awk '{ print tolower($1); exit }' \"$SOURCE.sha256\")\"",
    "if command -v shasum >/dev/null 2>&1; then ACTUAL=\"$(shasum -a 256 \"$ARCHIVE\" | awk '{ print $1 }')\"",
    "else ACTUAL=\"$(sha256sum \"$ARCHIVE\" | awk '{ print $1 }')\"; fi",
    'case "$EXPECTED" in *[!0-9a-f]*|"") fail "$ASSET.sha256 is not a checksum, so the download was not installed." ;; esac',
    '[ "${#EXPECTED}" -eq 64 ] && [ "$EXPECTED" = "$ACTUAL" ] || fail "The download does not match its checksum, so it was not installed."',
  ];
}

/** Every name inside the download stays inside the folder it is unpacked into. */
const unsafeNames = "grep -qE '^/|(^|/)\\.\\.(/|$)'";

function unpackPart(): string[] {
  return [
    'say "Unpacking Branch Agent..."',
    'UNPACKED="$STAGE/app"',
    'mkdir "$UNPACKED"',
    'case "$ASSET" in',
    `  *.zip) if /usr/bin/zipinfo -1 "$ARCHIVE" | ${unsafeNames}; then fail "The download names files outside its own folder, so it was not installed."; fi`,
    '    /usr/bin/ditto -x -k "$ARCHIVE" "$UNPACKED"; APP="$UNPACKED/Branch Agent.app"',
    '    EXE="$APP/Contents/MacOS/Branch Agent"; SETUP="$APP/Contents/Resources/app/dist/install/install-cli.js" ;;',
    `  *) if tar -tzf "$ARCHIVE" | ${unsafeNames}; then fail "The download names files outside its own folder, so it was not installed."; fi`,
    '    tar -xzf "$ARCHIVE" -C "$UNPACKED"; APP="$UNPACKED/${ASSET%.tar.gz}"',
    '    EXE="$APP/branch-agent"; SETUP="$APP/resources/app/dist/install/install-cli.js" ;;',
    "esac",
    ...linkCheck(),
    '[ -x "$EXE" ] && [ -f "$SETUP" ] || fail "The download did not contain the app."',
  ];
}

/**
 * A Mac app carries links of its own (`Versions/Current`), so links are allowed, but each must point
 * at something inside the unpacked folder; one that leads out (or nowhere) stops the install.
 */
function linkCheck(): string[] {
  return [
    'ROOT="$(cd -P "$UNPACKED" && pwd)"',
    "find \"$UNPACKED\" -type l -exec /bin/sh -c 'ROOT=\"$1\"; shift; for LINK do",
    '  TARGET="$(readlink "$LINK")"',
    '  case "$TARGET" in /*) exit 1 ;; esac',
    '  PARENT="$(cd -P "$(dirname "$LINK")" && cd -P "$(dirname "$TARGET")" 2>/dev/null && pwd)" || exit 1',
    '  case "$PARENT/" in "$ROOT"/*) ;; *) exit 1 ;; esac',
    "done' sh \"$ROOT\" {} + || fail \"The download holds a link that leads outside its own folder, so it was not installed.\"",
  ];
}

export function unixBootstrapperScript(): string {
  return [
    "#!/bin/sh",
    "# Installs Branch Agent for this person on macOS or Linux, with no questions and no administrator.",
    "#   sh install-branch-agent.sh [--quiet] [--no-menu-entry] [--repair] [--assistant <file from branch export-agent>]",
    "#     macOS also: [--applications | --no-applications] — where Branch Agent is put.",
    "#   sh install-branch-agent.sh --uninstall [--delete-data]",
    "set -eu",
    // The system's own tools, whatever PATH the caller had; and a person to install for.
    "PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH",
    'case "${HOME:-}" in /?*) ;; *) printf \'%s\\n\' "HOME is not set to a folder, so there is nowhere to install Branch Agent." >&2; exit 1 ;; esac',
    'QUIET=""',
    'for ARG in "$@"; do if [ "$ARG" = --quiet ]; then QUIET=1; fi; done',
    'say() { [ -n "$QUIET" ] || printf \'%s\\n\' "$1"; }',
    "fail() { printf '%s\\n' \"$1\" >&2; exit 1; }",
    'HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    ...uninstallPart(),
    ...chooseDownload(),
    ...checksumPart(),
    ...unpackPart(),
    'say "Installing..."',
    'ELECTRON_RUN_AS_NODE=1 "$EXE" "$SETUP" install --source "$APP" "$@"',
    "",
  ].join("\n");
}

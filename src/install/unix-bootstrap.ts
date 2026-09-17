import { releaseAssets } from "../desktop/release-assets.js";

/**
 * `install-branch-agent.sh`, published beside the macOS and Linux downloads: the counterpart of
 * `Install Branch Agent.cmd`. It picks the download for this computer by its full name, checks it
 * against its `.sha256`, unpacks it into a private temporary folder and hands over to the installer
 * inside the app, run by the app's own runtime. It never asks anything and never downloads anything.
 *
 *   sh install-branch-agent.sh [--quiet] [--no-menu-entry] [--repair] [--assistant <file>]
 *   sh install-branch-agent.sh --uninstall [--delete-data]
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

function uninstallPart(): string[] {
  return [
    'if [ "${1:-}" = --uninstall ]; then',
    "  shift",
    '  BRANCH="$HOME/.local/bin/branch"',
    '  if [ ! -x "$BRANCH" ]; then say "Branch Agent is not installed for $(id -un), so there is nothing to remove."; exit 0; fi',
    '  exec "$BRANCH" uninstall "$@"',
    "fi",
  ];
}

function checksumPart(): string[] {
  return [
    'ARCHIVE="$HERE/$ASSET"',
    '[ -f "$ARCHIVE" ] || fail "Put this file in the same folder as $ASSET and run it again."',
    '[ -f "$ARCHIVE.sha256" ] || fail "$ASSET.sha256 is missing, so the download cannot be checked. Download it from the same release."',
    "EXPECTED=\"$(awk '{ print tolower($1); exit }' \"$ARCHIVE.sha256\")\"",
    "if command -v shasum >/dev/null 2>&1; then ACTUAL=\"$(shasum -a 256 \"$ARCHIVE\" | awk '{ print $1 }')\"",
    "else ACTUAL=\"$(sha256sum \"$ARCHIVE\" | awk '{ print $1 }')\"; fi",
    '[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || fail "The download does not match its checksum, so it was not installed."',
  ];
}

function unpackPart(): string[] {
  return [
    'STAGE="$(mktemp -d "${TMPDIR:-/tmp}/branch-agent-setup.XXXXXX")"',
    "trap 'rm -rf \"$STAGE\"' EXIT",
    'say "Unpacking Branch Agent..."',
    'case "$ASSET" in',
    '  *.zip) /usr/bin/ditto -x -k "$ARCHIVE" "$STAGE"; APP="$STAGE/Branch Agent.app"',
    '    EXE="$APP/Contents/MacOS/Branch Agent"; SETUP="$APP/Contents/Resources/app/dist/install/install-cli.js" ;;',
    '  *) tar -xzf "$ARCHIVE" -C "$STAGE"; APP="$STAGE/${ASSET%.tar.gz}"',
    '    EXE="$APP/branch-agent"; SETUP="$APP/resources/app/dist/install/install-cli.js" ;;',
    "esac",
    '[ -x "$EXE" ] && [ -f "$SETUP" ] || fail "The download did not contain the app."',
  ];
}

export function unixBootstrapperScript(): string {
  return [
    "#!/bin/sh",
    "# Installs Branch Agent for this person on macOS or Linux, with no questions and no administrator.",
    "#   sh install-branch-agent.sh [--quiet] [--no-menu-entry] [--repair] [--assistant <file from branch export-agent>]",
    "#   sh install-branch-agent.sh --uninstall [--delete-data]",
    "set -eu",
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

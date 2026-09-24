import { homedir, tmpdir } from "node:os";
import { posix } from "node:path";
import type { WallNetwork } from "./sandbox.js";

// The profile is only ever built for macOS, so its paths are POSIX paths on whatever computer builds it.
const { join } = posix;

/**
 * macOS's own sandbox for a program Branch starts. The profile starts from "refuse everything" and
 * opens only what a command-line program needs: reading the disk (except where keys and passwords
 * live), writing inside the workspace and the temporary folders, and — only when allowed — the
 * network. `.git`, `.branch` and `.agents` inside the workspace stay read-only, so a program cannot
 * plant a hook or change what the assistant is told.
 *
 * Paths never go into the profile text. The profile names parameters (`(param "WRITE_0")`) and the
 * paths arrive as `-DWRITE_0=/the/path` arguments, so a folder name with quotes or brackets in it is
 * only ever a value, never profile code.
 *
 * The profile is adapted from Codex's `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl`,
 * `seatbelt_network_policy.sbpl` and the `-D` parameter mechanism in `seatbelt.rs`
 * (https://github.com/openai/codex, Apache-2.0, see THIRD_PARTY_NOTICES.md), which in turn follows
 * Chromium's sandbox policy.
 */

/** Always the system's own copy, never one found on PATH that someone could have planted. */
export const sandboxExecPath = "/usr/bin/sandbox-exec";

export const seatbeltBaseProfile = `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow file-write-data (require-all (path "/dev/null") (vnode-type CHARACTER-DEVICE)))
(allow sysctl-read)
(allow sysctl-write (sysctl-name "kern.grade_cputype"))
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.logd")
  (global-name "com.apple.system.logger"))
(allow ipc-posix-sem)
(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))
(allow mach-lookup (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent") (local-name "com.apple.cfprefsd.agent"))
(allow user-preference-read)
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))
(allow file-read*)
(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (subpath "/dev/fd"))
`;

/** Added when the program may use the network at all (directly, or through Branch's own door). */
export const seatbeltNetworkProfile = `(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))
(allow mach-lookup
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.networkd")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd"))
(allow sysctl-read (sysctl-name-regex #"^net.routetable"))
`;

/** Where keys, passwords and sign-ins usually live in a home folder. None of it is readable. */
export const secretHomePlaces = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".npmrc", ".pypirc",
  ".git-credentials", ".config/gh", ".config/gcloud", ".password-store",
  "Library/Keychains", "Library/Cookies", "Library/Application Support/com.apple.TCC",
] as const;
/** Folders in the workspace a program may read but never change. */
export const protectedWorkspaceNames = [".git", ".branch", ".agents"] as const;

export interface SeatbeltInput {
  workspace: string;
  network: WallNetwork;
  /** The ports of Branch's own door on this computer, when the network goes through it. */
  proxyPorts?: readonly number[] | undefined;
  /** Places the owner let a program write to after the wall stopped it, one file each. */
  extraWrites?: readonly string[];
  unreadable?: readonly string[];
  home?: string;
  temp?: readonly string[];
  /** Places a program may read but never change (Branch's own program and updater). */
  readOnly?: readonly string[];
  /** Branch's own data folder: never readable, whatever else is allowed. */
  dataDir?: string | undefined;
  /** Q12: a command held to one folder by a self-development contract: no `.git` at any depth in it. */
  held?: boolean;
}

type Param = [key: string, value: string];

function writeRules(input: SeatbeltInput, params: Param[]): string[] {
  const temps = input.temp ?? [tmpdir(), "/private/tmp", "/private/var/tmp"];
  const roots = [input.workspace, ...temps];
  const rules: string[] = [];
  roots.forEach((root, index) => {
    params.push([`WRITE_${index}`, root]);
    rules.push(`(allow file-write* (subpath (param "WRITE_${index}")))`);
  });
  (input.extraWrites ?? []).forEach((path, index) => {
    params.push([`GRANTED_${index}`, path]);
    rules.push(`(allow file-write* (literal (param "GRANTED_${index}")))`);
  });
  const kept = [...protectedWorkspaceNames.map((name) => join(input.workspace, name)), ...(input.readOnly ?? [])];
  kept.forEach((path, index) => {
    params.push([`KEEP_${index}`, path]);
    rules.push(`(deny file-write* (literal (param "KEEP_${index}")) (subpath (param "KEEP_${index}")))`);
  });
  // Q12: for a held command, no `.git` anywhere under its folder either, however deep and in any case
  // (the disk ignores case, so `.GIT` is a repository too): one planted there could name a program in
  // its own config for Branch's Git to run outside the wall. Ordinary walled commands keep their repositories.
  if (input.held) rules.push(`(deny file-write* (require-all (subpath (param "WRITE_0")) (regex #"/\\.[Gg][Ii][Tt](/|$)")))`);
  return rules;
}

function readRules(input: SeatbeltInput, params: Param[]): string[] {
  const home = input.home ?? homedir();
  const places = [...secretHomePlaces.map((place) => join(home, place)), ...(input.unreadable ?? []),
    ...(input.dataDir ? [input.dataDir] : [])];
  return places.map((place, index) => {
    params.push([`HIDDEN_${index}`, place]);
    return `(deny file-read* file-write* (literal (param "HIDDEN_${index}")) (subpath (param "HIDDEN_${index}")))`;
  });
}

function networkRules(input: SeatbeltInput): string[] {
  if (input.network === "none") return [];
  const ports = input.proxyPorts ?? [];
  // "Anywhere" means internet addresses and the system's own name lookup, never a local socket
  // file: those lead to Docker, the ssh agent and other programs that act outside the wall.
  if (input.network === "open" && !ports.length)
    return ['(allow network-outbound (remote ip "*:*"))', '(allow network-inbound (local ip "*:*"))',
      '(allow network-bind (local ip "*:*"))', '(allow network-outbound (literal "/private/var/run/mDNSResponder"))', seatbeltNetworkProfile];
  // Only Branch's own door is reachable; each port is a whole number Branch chose, never user text.
  const valid = ports.filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
  if (!valid.length || valid.length !== ports.length) return [];
  return [...valid.map((port) => `(allow network-outbound (remote ip "localhost:${port}"))`), seatbeltNetworkProfile];
}

/**
 * The arguments for `/usr/bin/sandbox-exec`, ending with the program itself. The deny rules come
 * last so no allowance before them can reopen a protected folder or a secret.
 */
export function seatbeltArgs(input: SeatbeltInput, command: { executable: string; args: readonly string[] }): string[] {
  const params: Param[] = [];
  const writes = writeRules(input, params);
  const hidden = readRules(input, params);
  const profile = [seatbeltBaseProfile, ...networkRules(input), ...writes, ...hidden].join("\n");
  for (const [key, value] of params)
    if (!value.startsWith("/") || value.includes("\0")) throw new Error(`The wall needs full paths; ${key} was not one.`);
  return ["-p", profile, ...params.map(([key, value]) => `-D${key}=${value}`), "--", command.executable, ...command.args];
}

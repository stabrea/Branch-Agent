import type { CheckArea, FixPlan, PathFact, PathRole, SecurityCheck, SecuritySnapshot, Severity, Verdict } from "./types.js";

/** What each kept path is, said the way the owner would say it. */
export const roleWords: Record<PathRole, string> = {
  "data-folder": "Branch's private folder",
  database: "the database of your conversations",
  "locker-key": "the key that opens your saved passwords",
  "chatgpt-sign-in": "your ChatGPT sign-in",
  "session-token": "the key the app window signs in with",
  integrations: "the launch settings file",
  "plugins-folder": "the plugins folder",
  "plugin-file": "a plugin",
  "browser-profiles": "your saved website sign-ins",
  artifacts: "screenshots and saved pages",
  kept: "files your tasks produced",
  logs: "the background logs",
  "update-backups": "the copies made before each update",
  diagnostics: "diagnostic bundles",
  "shell-program": "a program the assistant may run",
  workspace: "your workspace",
};

/** Short list of things for a sentence: "a, b and 3 more". */
export function listed(items: readonly string[], max = 3): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  const head = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0] ?? "";
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : head;
}

export const factsFor = (snapshot: SecuritySnapshot, roles: readonly PathRole[]): PathFact[] =>
  snapshot.paths.filter((fact) => roles.includes(fact.role) && (fact.kind === "file" || fact.kind === "folder"));

export function planFor(fact: PathFact, platform: NodeJS.Platform): FixPlan {
  const target = fact.kind === "folder" ? "folder" : "file";
  const words = platform === "win32"
    ? "Leave it to you and Windows itself"
    : `Set it so only you can ${target === "folder" ? "open it" : "read or change it"}`;
  return { path: fact.path, target, sentence: `${words}: ${fact.path}` };
}

export const check = (
  id: string, area: CheckArea, severity: Severity, title: string, decide: (s: SecuritySnapshot) => Verdict | null,
): SecurityCheck => ({ id, area, severity, title, decide });

/** "Other people on this computer can read X", with the repair, for the given kinds of path. */
export function othersCanReach(
  id: string, roles: PathRole[], access: "read" | "write", severity: Severity, title: string,
  options: { fix?: boolean; why: string } = { why: "" },
): SecurityCheck {
  return check(id, "files", severity, title, (snapshot) => {
    const open = factsFor(snapshot, roles).filter((fact) => (access === "read" ? fact.othersRead : fact.othersWrite));
    if (!open.length) return null;
    const verb = access === "read" ? "read" : "change";
    const who = open.flatMap((fact) => fact.broadGroups ?? []);
    const names = [...new Set(open.map((fact) => roleWords[fact.role]))];
    return {
      detail: `Other people who use this computer can ${verb} ${listed(names)}${who.length ? ` (${listed([...new Set(who)])})` : ""}: ${listed(open.map((fact) => fact.path), 2)}. ${options.why}`.trim(),
      advice: options.fix === false
        ? "Change who may reach it in the file's own settings, or move it somewhere only you use."
        : "Press Fix what Branch can on Settings → Permissions, or run: branch security audit --fix",
      ...(options.fix === false ? {} : { fixes: open.map((fact) => planFor(fact, snapshot.platform)) }),
    };
  });
}

/** This computer, by name. */
export const isLoopback = (host: string): boolean =>
  ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host.toLowerCase()) || host.toLowerCase().endsWith(".localhost");

export function hostOf(address: string): string | null {
  try { return new URL(address).hostname; } catch { return null; }
}

/** An address on this computer or a private network, going by its name alone. */
export function privateHost(host: string): boolean {
  if (isLoopback(host) || /\.(local|internal|lan|home)$/i.test(host)) return true;
  return /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || /^\[?f[cd][0-9a-f]{2}:/i.test(host);
}

export const channelsOn = (snapshot: SecuritySnapshot): boolean => (snapshot.integrations?.channels.length ?? 0) > 0;
export const shellOn = (snapshot: SecuritySnapshot): boolean => (snapshot.integrations?.shell?.executables.length ?? 0) > 0;

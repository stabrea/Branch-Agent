import { statfs, access } from "node:fs/promises";
import { constants } from "node:fs";
import { lookup } from "node:dns/promises";
import { arch, cpus, freemem, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";
import { redactFields, redactForLog, type DiagnosticLog } from "./diagnostic-log.js";
import { zipWrite } from "./skill-package.js";

/**
 * mac7/diagnostics: "Report a problem". Everything a developer needs to pinpoint a problem is
 * gathered into a list of items, each one already cleaned (src/diagnostic-log.ts). The owner reads
 * every item, removes any they like, and then either saves the rest as a zip or opens a GitHub
 * issue form with a short title and description filled in. Nothing here sends anything: the issue
 * link only opens a page in the owner's browser, and the zip is attached by the owner, by hand.
 */
export interface ReportItem { id: string; title: string; why: string; text: string }

export interface ReportSources {
  version: string;
  dataDir: string;
  installType: string;
  log: DiagnosticLog | null;
  logMode: string;
  health: () => Promise<unknown>;
  settings: () => unknown;
  services: () => unknown;
  /** Recent task events and trace spans, already reduced to their shape. */
  events: () => unknown;
  crashDumpsDir?: string | null;
  /** Checks whether a name resolves. Left out under Lockdown, when nothing may reach outside. */
  resolve?: ((host: string) => Promise<unknown>) | null;
  startedAt?: number;
}

export const issueRepository = "stabrea/Branch-Agent";
const pretty = (value: unknown): string => JSON.stringify(redactFields(value), null, 2) ?? "null";
const safely = async (work: () => unknown): Promise<unknown> => {
  try { return await work(); } catch (error) { return { unavailable: redactForLog(String((error as Error)?.message ?? error)) }; }
};

function aboutItem(sources: ReportSources): ReportItem {
  const electron = (process.versions as Record<string, string | undefined>).electron;
  const about = {
    branch: sources.version, installType: sources.installType, os: `${platform()} ${release()}`, arch: arch(),
    node: process.version, ...(electron ? { electron } : {}), cpus: cpus().length,
    memory: { totalMb: Math.round(totalmem() / 1048576), freeMb: Math.round(freemem() / 1048576) },
    uptimeMinutes: Math.round(process.uptime() / 60), locale: Intl.DateTimeFormat().resolvedOptions().locale,
  };
  return { id: "about", title: "About this computer and Branch", why: "Which version, system and install this is.", text: pretty(about) };
}

async function diskItem(dataDir: string): Promise<ReportItem> {
  const disk = await safely(async () => {
    const stats = await statfs(dataDir);
    const writable = await access(dataDir, constants.W_OK).then(() => true, () => false);
    return { freeGb: Math.round((stats.bavail * stats.bsize) / 1073741824 * 10) / 10, dataFolderWritable: writable };
  });
  return { id: "disk", title: "Disk space and permissions", why: "A full disk or a folder Branch cannot write explains many failures.", text: pretty(disk) };
}

async function networkItem(sources: ReportSources): Promise<ReportItem> {
  const hosts = ["github.com", "api.openai.com", "api.anthropic.com"];
  const result = sources.resolve
    ? Object.fromEntries(await Promise.all(hosts.map(async (host) => [host, await safely(async () => {
      await withTimeout(sources.resolve!(host), 3000);
      return "found";
    })])))
    : { skipped: "Lockdown is on, so nothing was looked up outside this computer." };
  return { id: "network", title: "Can Branch reach the internet", why: "Whether the names of common services can be looked up.", text: pretty(result) };
}
const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms).unref())]);

function logItem(sources: ReportSources): ReportItem {
  const lines = sources.log?.read({ limit: 400 }) ?? [];
  const text = sources.logMode === "off" && !lines.length
    ? "The activity log is off, so there is nothing recent to include. Turn it on in Settings › Advanced › Activity log, do the thing that went wrong again, then make this report."
    : lines.reverse().map((line) => JSON.stringify(line)).join("\n");
  return { id: "log", title: `Recent activity log (${lines.length} lines)`, why: "What each part of Branch did just before the problem, in order.", text };
}

function crashItem(sources: ReportSources): ReportItem {
  const crashes = sources.log?.crashes(10) ?? [];
  const dumps = listDumps(sources.crashDumpsDir);
  return {
    id: "crashes", title: `Crashes (${crashes.length} noted, ${dumps.length} crash files)`,
    why: "What crashed, where, and the last things that happened before it. Crash files stay in their folder; attach them yourself only if asked.",
    text: pretty({ crashes, crashFiles: dumps }),
  };
}
function listDumps(dir: string | null | undefined): { name: string; bytes: number; at: string }[] {
  if (!dir) return [];
  const found: { name: string; bytes: number; at: string }[] = [];
  const walk = (folder: string, depth: number): void => {
    let names: string[] = [];
    try { names = readdirSync(folder); } catch { return; }
    for (const name of names) {
      const path = join(folder, name);
      try {
        const info = statSync(path);
        if (info.isDirectory() && depth < 2) walk(path, depth + 1);
        else if (name.endsWith(".dmp")) found.push({ name, bytes: info.size, at: info.mtime.toISOString() });
      } catch { /* moved while looking */ }
    }
  };
  walk(dir, 0);
  return found.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);
}

/** Updates, installs and rollbacks, from the never-break activation ledger (read only). */
export function updateHistory(dataDir: string): unknown {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(join(dataDir, "activation.sqlite"), { readOnly: true });
    return db.prepare("SELECT kind, from_version AS fromVersion, to_version AS toVersion, state, started_at AS startedAt, finished_at AS finishedAt FROM activations ORDER BY id DESC LIMIT 20").all();
  } catch {
    return { note: "No updates have been recorded on this computer yet." };
  } finally { db?.close(); }
}

/** Every item, gathered only when the owner asks. */
export async function gatherReport(sources: ReportSources): Promise<ReportItem[]> {
  const item = async (id: string, title: string, why: string, work: () => unknown): Promise<ReportItem> =>
    ({ id, title, why, text: pretty(await safely(work)) });
  return [
    aboutItem(sources),
    await item("health", "Health checks", "The same checks as Settings › Advanced › Health check.", sources.health),
    await item("services", "What is running", "Each part of Branch — the engine, chat apps, outside AI-tool servers, models on this computer — and how it is doing.", sources.services),
    await item("settings", "Settings (secrets removed)", "Which features are switched on. Keys and passwords are never included.", sources.settings),
    logItem(sources),
    crashItem(sources),
    await item("updates", "Updates and rollbacks", "Which versions were installed or rolled back, and how each went.", () => updateHistory(sources.dataDir)),
    await item("tasks", "Recent tasks (shape only)", "What recent tasks did and how each ended — never your messages, replies or files.", sources.events),
    await diskItem(sources.dataDir),
    await networkItem(sources),
  ];
}

/** The items the owner kept. */
export function keptItems(items: readonly ReportItem[], removed: readonly string[] = []): ReportItem[] {
  const gone = new Set(removed);
  return items.filter((item) => !gone.has(item.id));
}

const readme = (items: readonly ReportItem[]): string => `Branch Agent problem report

This zip was made on your computer because you asked for it. Nothing was sent anywhere.
Keys, tokens, passwords, email addresses and your home folder name were removed as it was written.
Your messages, the assistant's replies and your files are not in it.

What is inside:
${items.map((item) => `  ${item.id}.txt  ${item.title}: ${item.why}`).join("\n")}
`;

export function reportZip(items: readonly ReportItem[]): Buffer {
  return zipWrite([["README.txt", readme(items)], ...items.map((item): [string, string] => [`${item.id}.txt`, item.text])]);
}

const maxBody = 6000;
/**
 * A link to GitHub's "new issue" form with a title and a short description filled in: only the
 * "about" item and the names of the other items, so the link itself never carries a log. The owner
 * reads the form, edits it, attaches the zip, and presses Submit themselves.
 */
export function issueUrl(items: readonly ReportItem[], summary = ""): string {
  const about = items.find((item) => item.id === "about");
  const body = [
    "**What happened**", redactForLog(summary.trim()) || "(Describe what you were doing and what went wrong.)", "",
    "**What I expected**", "", "",
    ...(about ? ["**About**", "```json", about.text, "```", ""] : []),
    "**Report zip**", "Please attach the zip saved from Report a problem. It holds:",
    ...items.filter((item) => item.id !== "about").map((item) => `- ${item.title}`),
  ].join("\n").slice(0, maxBody);
  const version = about ? (JSON.parse(about.text) as { branch?: string; os?: string }) : {};
  const title = `Problem: ${redactForLog(summary.trim()).slice(0, 70) || "something went wrong"} (Branch ${version.branch ?? "?"})`;
  const query = new URLSearchParams({ title, body });
  return `https://github.com/${issueRepository}/issues/new?${query.toString()}`;
}

/** The default look-up for the network item: DNS only, never a request to the service itself. */
export const dnsResolve = (host: string): Promise<unknown> => lookup(host);

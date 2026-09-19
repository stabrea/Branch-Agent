import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { scrubText } from "./diagnostics.js";
import { redactLeaks } from "./leak-guard.js";
import type { Store } from "./store.js";

/**
 * mac7/diagnostics: the activity log — one file of plain JSON lines, on this computer only, that
 * every part of Branch can write to: the engine, the window, the chat apps, outside AI-tool
 * servers, the updater. Each line says when, how serious, which part, and which task or request it
 * belongs to, so a problem can be followed from start to end. Nothing here sends anything anywhere.
 *
 * Every value is cleaned as it is written, never later: keys, tokens, "Bearer" headers, email
 * addresses and the owner's home folder never reach the disk. The file is kept small (rotated at a
 * size cap) and short-lived (older files are removed after a number of days).
 *
 * The log is a feature, so it ships off. Crashes are the exception: they were already written down
 * (src/tracing.ts), and a crash note now also carries the last few things that happened before it.
 */
export const logModes = ["off", "when-needed", "on"] as const;
export type LogMode = (typeof logModes)[number];
export const logLevels = ["debug", "info", "warn", "error"] as const;
export type Level = (typeof logLevels)[number];

export const DiagnosticLogSettingsSchema = z.object({
  /** off: nothing written; when-needed: warnings and errors; on: everything from "info" up. */
  mode: z.enum(logModes).default("off"),
  /** Older log files than this are removed. */
  keepDays: z.number().int().min(1).max(90).default(14),
  /** The most the log may take on disk, across all its files. */
  maxMegabytes: z.number().int().min(1).max(200).default(20),
}).strict();
export type DiagnosticLogSettings = z.infer<typeof DiagnosticLogSettingsSchema>;

const settingsKey = "diagnostic-log";
export function diagnosticLogSettings(store: Pick<Store, "get">, owner: string): DiagnosticLogSettings {
  const saved = DiagnosticLogSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : DiagnosticLogSettingsSchema.parse({});
}
export function saveDiagnosticLogSettings(store: Store, owner: string, input: unknown): DiagnosticLogSettings {
  const next = DiagnosticLogSettingsSchema.parse({ ...diagnosticLogSettings(store, owner), ...DiagnosticLogSettingsSchema.partial().parse(input) });
  store.save("settings", owner, settingsKey, next);
  return next;
}

// ---- cleaning ----

const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const secretField = /(api[-_]?key|^key$|token|secret|password|passphrase|authorization|bearer|credential|cookie|pin$)/i;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A cleaner bound to one home folder (the real one unless a test names another). */
export function makeRedactor(home = homedir()): (text: string) => string {
  const homes = [home, home.replace(/\\/g, "/")].filter((each, index, all) => each.length > 3 && all.indexOf(each) === index);
  const homePattern = homes.length ? new RegExp(homes.map(escapeRegExp).join("|"), "gi") : null;
  return (text) => {
    let out = redactLeaks(text).text;
    out = scrubText(out);
    out = out.replace(/\b(authorization|cookie|x-api-key)\s*[:=]\s*\S+/gi, "$1: [removed]");
    out = out.replace(emailPattern, "[email removed]");
    if (homePattern) out = out.replace(homePattern, "~");
    return out;
  };
}
export const redactForLog = makeRedactor();

/** The same through fields: secret-named keys are removed whole; nested values are cleaned or dropped. */
export function redactFields(value: unknown, clean: (text: string) => string = redactForLog, depth = 0): unknown {
  if (typeof value === "string") return clean(value).slice(0, 2000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth > 4 || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return value.slice(0, 50).map((each) => redactFields(each, clean, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, each] of Object.entries(value as Record<string, unknown>).slice(0, 50))
    out[key] = secretField.test(key) ? "[removed]" : redactFields(each, clean, depth + 1);
  return out;
}

// ---- the log ----

export interface LogLine {
  at: string; level: Level; component: string; message: string;
  taskId?: string; requestId?: string; fields?: Record<string, unknown>; pid: number;
}
export interface LogWrite {
  level: Level; component: string; message: string;
  taskId?: string; requestId?: string; fields?: Record<string, unknown>;
}
export interface LogFilter { component?: string; level?: Level; task?: string; limit?: number }
const rank: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const fileCount = 5;
const breadcrumbCount = 30;

export class DiagnosticLog {
  readonly dir: string;
  private readonly settings: () => DiagnosticLogSettings;
  private readonly clean: (text: string) => string;
  private readonly now: () => Date;
  private readonly crumbs: LogLine[] = [];

  constructor(options: { dir: string; settings: () => DiagnosticLogSettings; clean?: (text: string) => string; now?: () => Date }) {
    this.dir = options.dir;
    this.settings = options.settings;
    this.clean = options.clean ?? redactForLog;
    this.now = options.now ?? (() => new Date());
  }

  get file(): string { return join(this.dir, "branch.jsonl"); }
  get crashFile(): string { return join(this.dir, "crashes.jsonl"); }

  /** Writes one line if the mode lets it through; it is always kept as a breadcrumb in memory. */
  write(entry: LogWrite): void {
    const line = this.shape(entry);
    this.crumbs.push(line);
    if (this.crumbs.length > breadcrumbCount) this.crumbs.shift();
    const { mode, maxMegabytes } = this.settings();
    if (mode === "off") return;
    if (rank[line.level] < (mode === "on" ? rank.info : rank.warn)) return;
    try { this.append(this.file, JSON.stringify(line), (maxMegabytes * 1024 * 1024) / fileCount); } catch { /* a log line must never break Branch */ }
  }

  /** Last things that happened, newest last, already cleaned. Kept in memory only. */
  breadcrumbs(): LogLine[] { return [...this.crumbs]; }

  /** A crash, written straight away (synchronously) with the breadcrumbs before it. */
  crash(component: string, error: unknown, origin = "uncaught"): void {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const stack = error instanceof Error ? error.stack ?? "" : "";
    const line = this.shape({ level: "error", component, message, fields: { origin, stack: stack.slice(0, 4000) } });
    const record = { ...line, kind: "crash", breadcrumbs: this.breadcrumbs() };
    try { this.append(this.crashFile, JSON.stringify(record), 512 * 1024); } catch { /* never a second crash */ }
    this.write({ level: "error", component, message: `Crashed: ${message}`, fields: { origin } });
  }

  /** Lines newest first, across the rotated files, with the owner's filters. */
  read(filter: LogFilter = {}): LogLine[] {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 2000);
    const found: LogLine[] = [];
    for (const file of this.files(this.file)) {
      const lines = readLines(file).reverse();
      for (const line of lines) {
        if (!matches(line, filter)) continue;
        found.push(line);
        if (found.length >= limit) return found;
      }
    }
    return found;
  }

  crashes(limit = 20): (LogLine & { breadcrumbs?: LogLine[] })[] {
    return this.files(this.crashFile).flatMap((file) => readLines(file).reverse()).slice(0, limit);
  }

  /** Removes rotated files older than the owner's number of days. Returns how many went. */
  prune(): number {
    const cutoff = this.now().getTime() - this.settings().keepDays * 86_400_000;
    let removed = 0;
    for (const file of [...this.files(this.file), ...this.files(this.crashFile)]) {
      try { if (statSync(file).mtimeMs < cutoff) { unlinkSync(file); removed += 1; } } catch { /* already gone */ }
    }
    return removed;
  }

  /** Removes every log file: the owner's "Clear the log". */
  clear(): void {
    for (const file of [...this.files(this.file), ...this.files(this.crashFile)]) try { unlinkSync(file); } catch { /* gone */ }
    this.crumbs.length = 0;
  }

  private shape(entry: LogWrite): LogLine {
    const fields = entry.fields ? redactFields(entry.fields, this.clean) as Record<string, unknown> : undefined;
    return {
      at: this.now().toISOString(), level: entry.level, component: this.clean(entry.component).slice(0, 40),
      message: this.clean(entry.message).slice(0, 1000),
      ...(entry.taskId ? { taskId: entry.taskId.slice(0, 80) } : {}),
      ...(entry.requestId ? { requestId: entry.requestId.slice(0, 80) } : {}),
      ...(fields && Object.keys(fields).length ? { fields } : {}), pid: process.pid,
    };
  }

  private append(file: string, text: string, perFile: number): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const size = existsSync(file) ? statSync(file).size : 0;
    if (size > 0 && size + text.length + 1 > perFile) rotate(file);
    appendFileSync(file, text + "\n", { mode: 0o600 });
  }

  /** The live file and its rotated copies, newest first. */
  private files(base: string): string[] {
    const all = [base, ...Array.from({ length: fileCount - 1 }, (_, index) => rotated(base, index + 1))];
    return all.filter((file) => existsSync(file));
  }
}

const rotated = (base: string, index: number): string => base.replace(/\.jsonl$/, `.${index}.jsonl`);
function rotate(base: string): void {
  const oldest = rotated(base, fileCount - 1);
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let index = fileCount - 2; index >= 1; index--)
    if (existsSync(rotated(base, index))) renameSync(rotated(base, index), rotated(base, index + 1));
  renameSync(base, rotated(base, 1));
}
function readLines(file: string): LogLine[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((text) => {
      try { return [JSON.parse(text) as LogLine]; } catch { return []; }
    });
  } catch { return []; }
}
function matches(line: LogLine, filter: LogFilter): boolean {
  if (filter.component && line.component !== filter.component) return false;
  if (filter.level && rank[line.level] < rank[filter.level]) return false;
  if (filter.task && line.taskId !== filter.task) return false;
  return true;
}

/** The files that exist in a log folder, for the report's list (names only). */
export function logFolderListing(dir: string): string[] {
  try { return readdirSync(dir).filter((name) => name.endsWith(".jsonl")); } catch { return []; }
}

// ---- one log for the whole process ----

let current: DiagnosticLog | null = null;
export function setDiagnosticLog(log: DiagnosticLog | null): void { current = log; }
export function activeDiagnosticLog(): DiagnosticLog | null { return current; }
/** What any part of Branch calls to write a line. Does nothing before the log is set up. */
export function diagnose(component: string, level: Level, message: string, extra: Omit<LogWrite, "component" | "level" | "message"> = {}): void {
  current?.write({ component, level, message, ...extra });
}

/**
 * Crashes in this process: `uncaughtExceptionMonitor` watches without taking the failure over, so
 * Node still ends exactly as it would have. (A promise nobody caught reaches it too, because
 * src/tracing.ts hands those on as uncaught failures.)
 */
export function watchProcessCrashes(log: DiagnosticLog, component = "engine"): () => void {
  const listener = (error: Error, origin: string) => log.crash(component, error, origin);
  process.on("uncaughtExceptionMonitor", listener);
  return () => { process.off("uncaughtExceptionMonitor", listener); };
}

/** Which part of Branch a stored event belongs to, from its kind ("channel.message" → "channels"). */
export function componentOf(kind: string): string {
  const head = kind.split(".")[0] ?? "engine";
  const names: Record<string, string> = {
    run: "tasks", tool: "tools", model: "models", channel: "channels", mcp: "mcp", schedule: "schedules",
    approval: "approvals", update: "updater", gateway: "gateway", local: "local-models", browser: "browser",
  };
  return names[head] ?? head;
}

/**
 * How the desktop app starts Electron's crash reporter: minidumps are written to this computer's
 * crash folder and never uploaded. Kept here, outside Electron, so a test can hold it to that.
 */
export function crashReporterOptions(): { uploadToServer: false; submitURL: string; compress: boolean; productName: string } {
  return { uploadToServer: false, submitURL: "", compress: true, productName: "Branch Agent" };
}

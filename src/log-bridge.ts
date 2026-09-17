/**
 * Handing Branch's own story to the logger of a program that embeds it (A1334).
 *
 * A program that runs Branch through `createBranch` usually already has a logger — `console`, pino,
 * winston, bunyan, or Node's own. All of them answer `debug`, `info`, `warn` and `error` with a
 * message and an object of fields, so that is the only shape asked for here: no logging library is
 * installed, and nothing is sent anywhere by this file. Each stored event becomes one log line.
 *
 * What goes to the logger is the same cut-down shape the diagnostics folder uses (`redactEvent`):
 * names, counts and outcomes, never a prompt, a tool result, a file's contents or a key.
 */
import { z } from "zod";
import { redactEvent } from "./diagnostics.js";

export const logLevels = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof logLevels)[number];

/** Any logger with the four usual methods. `console` is one. */
export interface LevelLogger {
  debug(message: string, fields: Record<string, unknown>): void;
  info(message: string, fields: Record<string, unknown>): void;
  warn(message: string, fields: Record<string, unknown>): void;
  error(message: string, fields: Record<string, unknown>): void;
}

export const LogBridgeOptionsSchema = z.object({
  /** Lines quieter than this are not handed over. */
  level: z.enum(logLevels).default("info"),
  /** Only events whose kind starts with one of these; empty means every kind. */
  kinds: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  /** Put before every message, so the lines can be told apart in a shared log. */
  prefix: z.string().max(40).default("branch"),
}).strict();
export type LogBridgeOptions = z.input<typeof LogBridgeOptionsSchema>;

const rank: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** How loud an event is: failures are errors, retries and stalls are warnings, deltas are debug. */
export function levelFor(kind: string): LogLevel {
  if (/(^|\.)(failed|error|crashed|refused)$/.test(kind) || kind === "run.failed") return "error";
  if (/(retry|stall|blocked|denied|budget|limit|timeout)/.test(kind)) return "warn";
  if (/(delta|token|progress|heartbeat)/.test(kind)) return "debug";
  return "info";
}

/** Anything that can report its stored events as they happen: the Store is one. */
export interface EventSource {
  onEvent(listener: (runId: string, kind: string, data: Record<string, unknown>) => void): () => void;
}

/**
 * Starts handing events to `logger`. Returns the function that stops it. A logger that throws is
 * ignored, because a log line must never break a task.
 */
export function bridgeLogs(source: EventSource, logger: LevelLogger, options: LogBridgeOptions = {}): () => void {
  const settings = LogBridgeOptionsSchema.parse(options);
  const threshold = rank[settings.level];
  let seen = 0;
  return source.onEvent((runId, kind, data) => {
    if (settings.kinds.length && !settings.kinds.some((prefix) => kind.startsWith(prefix))) return;
    const level = levelFor(kind);
    if (rank[level] < threshold) return;
    seen += 1;
    const shaped = redactEvent({ id: seen, runId, kind, data, createdAt: new Date().toISOString() });
    const fields = { runId, kind, at: shaped.at, ...(shaped.data as Record<string, unknown>) };
    try { logger[level](`${settings.prefix} ${kind}`, fields); } catch { /* a logger must never break a task */ }
  });
}

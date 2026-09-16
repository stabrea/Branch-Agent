import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { Event, Run } from "./contracts.js";
import type { Store } from "./store.js";

/**
 * A finished task written out as a trace, in the shape OpenTelemetry tools already read, so the
 * owner can open a task in a tracing viewer they already have. Branch writes files; it never sends
 * anything anywhere. Turning this on is the owner's choice and it is off until they make it.
 */
export interface SpanAttribute { key: string; value: { stringValue: string } | { intValue: string } | { boolValue: boolean } }
export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: SpanAttribute[];
  status: { code: number; message?: string };
}
export interface TraceDocument {
  resourceSpans: Array<{
    resource: { attributes: SpanAttribute[] };
    scopeSpans: Array<{ scope: { name: string; version: string }; spans: TraceSpan[] }>;
  }>;
}

export const TraceSettingsSchema = z
  .object({
    /** Off until the owner turns it on. */
    enabled: z.boolean().default(false),
    /** Absolute folder inside the owner's own profile or the workspace; nothing else is accepted. */
    folder: z.string().max(4096).nullable().default(null),
  })
  .strict();
export type TraceSettings = z.infer<typeof TraceSettingsSchema>;

const text = (key: string, value: string): SpanAttribute => ({ key, value: { stringValue: value } });
const count = (key: string, value: number): SpanAttribute => ({ key, value: { intValue: String(Math.trunc(value)) } });
const nanos = (iso: string): string => `${BigInt(new Date(iso).getTime()) * 1_000_000n}`;
/** Ids are derived from the task and event ids, so the same task always produces the same trace. */
const spanId = (runId: string, key: string): string => createHash("sha256").update(`${runId}:${key}`).digest("hex").slice(0, 16);
const traceIdOf = (runId: string): string => runId.replace(/-/g, "").padEnd(32, "0").slice(0, 32);

/**
 * Checks a folder the owner typed. It must be an absolute path inside their own user folder or
 * inside the workspace: anywhere else (another account, a system folder, a network share) is
 * refused, because a trace file carries the names of the tools a task ran.
 */
export function resolveTraceFolder(folder: string, roots: string[]): string {
  if (!folder.trim()) throw new Error("Choose a folder for the trace files");
  if (/^\\\\/.test(folder)) throw new Error("Trace files cannot be written to a network share");
  if (!isAbsolute(folder)) throw new Error("The trace folder must be a full path, for example C:\\Users\\you\\Traces");
  const candidate = resolve(folder);
  const inside = roots.some((root) => {
    const step = relative(resolve(root), candidate);
    return step === "" || (!step.startsWith("..") && !isAbsolute(step));
  });
  if (!inside)
    throw new Error("Choose a folder inside your own user folder or inside the workspace");
  return candidate;
}

/** The folders a trace may be written into: the owner's user folder and Branch's workspace. */
export const traceRoots = (workspace: string): string[] => [homedir(), workspace];

function runAttributes(run: Run, usage: Record<string, number>): SpanAttribute[] {
  return [
    text("branch.run.id", run.id),
    text("branch.session.id", run.sessionId),
    text("branch.run.status", run.status),
    count("branch.tokens.input", usage.reportedInput || usage.estimatedInput || 0),
    count("branch.tokens.output", usage.reportedOutput || usage.estimatedOutput || 0),
  ];
}

/** Pairs each started event with the matching finished one so a span has a real duration. */
function modelSpans(run: Run, events: Event[], parent: string): TraceSpan[] {
  const spans: TraceSpan[] = [];
  let started: Event | undefined;
  for (const event of events) {
    if (event.kind === "model.started") { started = event; continue; }
    if (event.kind !== "model.completed" && event.kind !== "model.failed") continue;
    const begin = started ?? event;
    spans.push({
      traceId: traceIdOf(run.id), spanId: spanId(run.id, `model:${event.id}`), parentSpanId: parent,
      name: `model ${String(event.data.model ?? "unknown")}`, kind: 3,
      startTimeUnixNano: nanos(begin.createdAt), endTimeUnixNano: nanos(event.createdAt),
      attributes: [
        text("gen_ai.system", String(event.data.provider ?? "unknown")),
        text("gen_ai.request.model", String(event.data.model ?? "unknown")),
        text("branch.preset", String(event.data.preset ?? "")),
      ],
      status: { code: event.kind === "model.completed" ? 1 : 2 },
    });
    started = undefined;
  }
  return spans;
}

function toolSpans(run: Run, events: Event[], parent: string): TraceSpan[] {
  const spans: TraceSpan[] = [];
  const starts = new Map<string, Event>();
  for (const event of events) {
    const id = String(event.data.id ?? "");
    if (event.kind === "tool.started") { starts.set(id, event); continue; }
    if (!event.kind.startsWith("tool.") || event.kind === "tool.started") continue;
    const begin = starts.get(id) ?? event;
    starts.delete(id);
    const failed = event.kind !== "tool.completed";
    spans.push({
      traceId: traceIdOf(run.id), spanId: spanId(run.id, `tool:${event.id}`), parentSpanId: parent,
      name: `tool ${String(event.data.name ?? "unknown")}`, kind: 1,
      startTimeUnixNano: nanos(begin.createdAt), endTimeUnixNano: nanos(event.createdAt),
      attributes: [text("branch.tool.name", String(event.data.name ?? "unknown")), text("branch.tool.call_id", id)],
      // Only the failure reason travels; tool arguments and results never leave the database.
      status: failed ? { code: 2, message: String(event.data.error ?? event.kind).slice(0, 300) } : { code: 1 },
    });
  }
  return spans;
}

/**
 * One finished task as an OpenTelemetry trace document: a span for the task, and a child span for
 * every model round and every tool call inside it.
 */
export function buildTraceDocument(store: Store, runId: string, version = "0"): TraceDocument {
  const run = store.run(runId);
  if (!run) throw new Error("Task not found");
  const events = store.events(runId);
  const root = spanId(run.id, "root");
  const rootSpan: TraceSpan = {
    traceId: traceIdOf(run.id), spanId: root, parentSpanId: "",
    name: "branch.run", kind: 1,
    startTimeUnixNano: nanos(run.createdAt), endTimeUnixNano: nanos(run.updatedAt),
    attributes: runAttributes(run, store.usage(run.id)),
    status: { code: run.status === "completed" ? 1 : 2, ...(run.status === "completed" ? {} : { message: run.status }) },
  };
  const spans = [rootSpan, ...modelSpans(run, events, root), ...toolSpans(run, events, root)];
  return {
    resourceSpans: [
      {
        resource: { attributes: [text("service.name", "branch-agent"), text("service.version", version)] },
        scopeSpans: [{ scope: { name: "branch.runtime", version }, spans }],
      },
    ],
  };
}

/** The owner's trace settings, or the safe default (off) when nothing is saved. */
export function traceSettings(store: Store, owner: string): TraceSettings {
  const saved = TraceSettingsSchema.safeParse(store.get("settings", owner, "trace")?.data ?? {});
  return saved.success ? saved.data : TraceSettingsSchema.parse({});
}

/** Saves the settings, refusing a folder outside the owner's user folder or the workspace. */
export function saveTraceSettings(store: Store, owner: string, workspace: string, input: unknown): TraceSettings {
  const value = TraceSettingsSchema.parse(input);
  if (value.folder) value.folder = resolveTraceFolder(value.folder, traceRoots(workspace));
  if (value.enabled && !value.folder) throw new Error("Choose a folder before turning trace files on");
  store.save("settings", owner, "trace", value);
  return value;
}

/**
 * Writes one finished task's trace, when the owner has turned this on. Returns the file path, or
 * null when tracing is off. Writing a trace never fails a task: callers swallow the error.
 */
export async function writeRunTrace(
  store: Store, owner: string, workspace: string, runId: string, version = "0",
): Promise<string | null> {
  const settings = traceSettings(store, owner);
  if (!settings.enabled || !settings.folder) return null;
  const folder = resolveTraceFolder(settings.folder, traceRoots(workspace));
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${runId}.json`);
  await writeFile(path, JSON.stringify(buildTraceDocument(store, runId, version), null, 2), { mode: 0o600 });
  return path;
}

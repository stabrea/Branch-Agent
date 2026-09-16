import type { Event, Run } from "./contracts.js";
import type { Store } from "./store.js";

/**
 * Plain-language activity for a task in progress: what the assistant is doing right now and how
 * each earlier step ended, built from the durable event log so any client can show it.
 */
export interface ActivityStep { id: string; label: string; status: "working" | "done" | "failed" | "stopped"; at: string }
export interface RunActivity { runId: string; sessionId: string; prompt: string; status: Run["status"]; startedAt: string; current: string | null; steps: ActivityStep[] }

const short = (value: unknown, max = 60): string => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
};
const host = (value: unknown): string => { try { return new URL(String(value)).host; } catch { return short(value); } };

/** What a tool call is doing, for people; arguments are summarised and never echoed in full. */
export function describeToolCall(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "files.read": return `Reading ${short(a.path)}`;
    case "files.write": return `Writing ${short(a.path)}`;
    case "files.list": return `Looking through ${short(a.path ?? "the workspace")}`;
    case "files.search": return `Searching files for “${short(a.query ?? a.pattern)}”`;
    case "web.search": return `Searching the web for “${short(a.query)}”`;
    case "web.fetch": return `Reading ${host(a.url)}`;
    case "shell.execute": return "Running a command";
    case "user.ask": return "Asking you a question";
    case "specialists.delegate": return `Asking the ${short(a.id)} specialist`;
    case "specialists.fanout": return "Running several specialists";
    case "sessions.search": case "history.search": return "Looking back through earlier conversations";
    default:
      if (name.startsWith("memory.")) return name.endsWith("put") || name.endsWith("write") ? "Saving a note to memory" : "Checking memory";
      if (name.startsWith("schedules.")) return "Updating a schedule";
      if (name.startsWith("skills.")) return "Reading a skill";
      if (name.startsWith("browser.")) return "Using the browser";
      return `Using ${name}`;
  }
}

/** Steps and the current activity of one run, from its events. */
export function runActivity(run: Run, events: Event[]): RunActivity {
  const steps = new Map<string, ActivityStep>();
  for (const event of events) {
    const id = String(event.data.id ?? event.id), name = String(event.data.name ?? "tool");
    if (event.kind === "tool.started")
      steps.set(id, { id, label: String(event.data.label ?? describeToolCall(name, undefined)), status: "working", at: event.createdAt });
    else if (event.kind === "tool.completed" || event.kind === "tool.failed" || event.kind === "tool.stalled") {
      const step = steps.get(id) ?? { id, label: describeToolCall(name, undefined), status: "working" as const, at: event.createdAt };
      steps.set(id, { ...step, status: event.kind === "tool.completed" ? "done" : event.kind === "tool.failed" ? "failed" : "stopped", at: event.createdAt });
    }
  }
  const list = [...steps.values()];
  const working = list.filter((s) => s.status === "working").at(-1);
  const thinking = events.at(-1)?.kind === "model.started";
  const current = run.status !== "running" ? null : working ? working.label : thinking || !list.length ? "Thinking" : "Thinking about the results";
  return { runId: run.id, sessionId: run.sessionId, prompt: run.prompt, status: run.status, startedAt: run.createdAt, current, steps: list.slice(-30) };
}

/** Activity for every task of the owner that is still running. */
export function liveActivity(store: Store, owner: string): RunActivity[] {
  return store.runs(owner).filter((run) => run.status === "running").map((run) => runActivity(run, store.events(run.id)));
}

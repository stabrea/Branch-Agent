import type { Event, Run } from "./contracts.js";
import type { Store } from "./store.js";

/**
 * Plain-language activity for a task in progress: what the assistant is doing right now and how
 * each earlier step ended, built from the durable event log so any client can show it.
 */
export interface ActivityStep { id: string; label: string; status: "working" | "done" | "failed" | "stopped"; at: string }
/** The plan a task is working through, where it has got to, and what a reviewer said. */
export interface ActivityPlan { steps: string[]; step: number; awaitingApproval: boolean; finished: boolean }
export interface RunActivity {
  runId: string; sessionId: string; prompt: string; status: Run["status"]; startedAt: string;
  current: string | null; steps: ActivityStep[]; working?: string;
  plan?: ActivityPlan; milestone?: string; verdict?: string;
  /** Q51: what the task is really doing, from its events. */
  task?: TaskState;
}

/**
 * Q51: what a task that has not finished is really doing, told from its own event log and nothing else. The
 * latest event that says so decides: it is working, waiting for the owner, waiting for a service (a rate pause, a
 * retry, a model loading, a fallback, a summary being written) or blocked (a refusal nothing has moved on from
 * yet). `why` is that event's kind, so the window can name it in the owner's language; `reason` is the event's
 * own words (the question asked, the message, the reason given), never made up; `until` is when a wait ends, when
 * the event says. There is no percentage: nothing records how much is left.
 */
export type TaskStateName = "working" | "waiting-owner" | "waiting-service" | "blocked" | "finished";
export interface TaskState {
  state: TaskStateName; why: string; reason: string;
  /** When the task last recorded anything. */
  lastUpdate: string;
  /** Working or waiting for a service, and nothing recorded for longer than a model or a tool may take. */
  stale: boolean;
  until?: string;
}

const OWNER = new Set(["policy.ask", "attention.needed", "plan.awaiting_approval", "folder.trust_needed", "web.challenge", "run.can_continue"]);
const SERVICE = new Set(["rate.paused", "model.retry_scheduled", "model.loading", "model.fallback", "model.stalled", "context.compacting"]);
const BLOCKED = new Set(["policy.denied", "hook.blocked", "provider.refused", "reconciliation.required", "rounds.exhausted"]);
const WORKING = new Set(["run.started", "run.resumed", "model.started", "model.completed", "tool.started", "tool.completed", "tool.failed",
  "tool.stalled", "plan.approved", "plan.step.started", "run.milestone", "verify.verdict", "rate.resumed"]);
const FINISHED = new Set<Run["status"]>(["completed", "failed", "cancelled", "budget_exceeded"]);

/** Which of the four an event says, or null for one that says nothing about it (a note, a count). */
function stateOf(event: Event): Exclude<TaskStateName, "finished"> | null {
  const { kind, data } = event;
  if (kind === "run.stuck") return data.action === "ask" ? "waiting-owner" : "waiting-service";
  if (kind === "model.stall_recovery") return data.action === "fail" ? null : "waiting-service";
  if (OWNER.has(kind)) return "waiting-owner";
  if (SERVICE.has(kind)) return "waiting-service";
  if (BLOCKED.has(kind)) return "blocked";
  return WORKING.has(kind) ? "working" : null;
}
/** The event's own words for why, if it has any. */
function reasonOf(event: Event): string {
  const d = event.data;
  const words = d.question ?? d.message ?? d.note ?? d.reason ?? d.label ?? d.error ?? d.site ?? d.folder ?? d.provider ?? d.name ?? "";
  return short(words, 160);
}
/** When the wait an event describes ends, when it says. */
function untilOf(event: Event): string | undefined {
  const d = event.data, at = Date.parse(event.createdAt);
  const wait = Number(d.waitMs ?? d.delayMs ?? (d.waitSeconds !== undefined ? Number(d.waitSeconds) * 1000 : NaN));
  if (Number.isFinite(wait) && wait > 0 && Number.isFinite(at)) return new Date(at + wait).toISOString();
  return typeof d.cooldownUntil === "string" ? d.cooldownUntil : undefined;
}

export function taskState(run: Run, events: Event[], options: { now?: number; staleMs?: number } = {}): TaskState {
  const lastUpdate = events.at(-1)?.createdAt ?? run.updatedAt ?? run.createdAt;
  if (FINISHED.has(run.status)) return { state: "finished", why: run.status, reason: "", lastUpdate, stale: false };
  let decided: { state: Exclude<TaskStateName, "finished">; event: Event } | null = null;
  for (let at = events.length - 1; at >= 0 && !decided; at--) {
    const state = stateOf(events[at]!);
    if (state) decided = { state, event: events[at]! };
  }
  /* A task that stopped to ask, or that Branch closed on, waits for the owner whatever came last. */
  const waitsForOwner = run.status === "needs_input" || run.status === "interrupted";
  if (waitsForOwner && decided?.state !== "waiting-owner") {
    const asked = [...events].reverse().find((event) => stateOf(event) === "waiting-owner");
    decided = asked ? { state: "waiting-owner", event: asked } : null;
    if (!decided) return { state: "waiting-owner", why: run.status, reason: "", lastUpdate, stale: false };
  }
  if (!decided) return { state: "working", why: "run.started", reason: "", lastUpdate, stale: false };
  const { state, event } = decided;
  const quiet = (options.now ?? Date.now()) - Date.parse(lastUpdate);
  const stale = (state === "working" || state === "waiting-service") && quiet > (options.staleMs ?? 90_000);
  const until = state === "waiting-service" ? untilOf(event) : undefined;
  return { state, why: event.kind, reason: state === "working" ? "" : reasonOf(event), lastUpdate, stale, ...(until ? { until } : {}) };
}

const short = (value: unknown, max = 60): string => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
};
const host = (value: unknown): string => { try { return new URL(String(value)).host; } catch { return short(value); } };

/** Tools whose first argument is a workspace file, so a call on one counts as touching that file. */
const fileTools = new Set([
  "files.read", "files.write", "files.edit", "files.validate", "files.verify",
  "code.check", "document.open", "documents.add",
]);
/**
 * The workspace file a call is about, or "" when it is about none. It is written beside the call in
 * the task's own record so that "which files do you keep coming back to?" can be answered later
 * from what actually happened. Only the path is kept, never what was in the file.
 */
export function filePathOf(name: string, args: unknown): string {
  if (!fileTools.has(name)) return "";
  const path = (args && typeof args === "object" ? (args as Record<string, unknown>).path : undefined);
  return typeof path === "string" && path && path !== "." ? path.slice(0, 200) : "";
}

/** What a tool call is doing, for people; arguments are summarised and never echoed in full. */
export function describeToolCall(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "files.read": return `Reading ${short(a.path)}`;
    case "files.write": return `Writing ${short(a.path)}`;
    case "files.list": return `Looking through ${short(a.path ?? "the workspace")}`;
    case "files.search": case "files.grep": return `Searching files for “${short(a.query ?? a.pattern)}”`;
    case "files.glob": return `Listing files like ${short((a.patterns as string[] | undefined)?.[0])}`;
    case "files.find": return `Looking for a file called “${short(a.query)}”`;
    case "files.patch": return "Applying a set of file changes";
    case "code.patch": return a.dryRun ? "Working out what a set of file changes would do" : "Applying a set of file changes";
    case "code.change_set": return `Changing ${(a.edits as unknown[] | undefined)?.length ?? 0} files`;
    case "code.check": return "Running this project's check";
    case "code.run": return `Running a small ${a.language === "python" ? "Python" : "JavaScript"} script`;
    case "process.start": return `Starting ${short(a.name ?? a.executable)} and leaving it running`;
    case "process.list": return "Listing what is still running";
    case "process.read": return "Reading what a running program has said";
    case "process.stop": return "Stopping a running program";
    case "files.edit": return `Changing some text in ${short(a.path)}`;
    case "files.validate": return `Checking ${short(a.path)} still reads correctly`;
    case "workspace.map": case "code.map": return "Mapping the workspace";
    case "web.search": return `Searching the web for “${short(a.query)}”`;
    case "web.fetch": return `Reading ${host(a.url)}`;
    case "shell.execute": return "Running a command";
    case "shell.session.open": return "Opening a command line to keep";
    case "shell.session.run": return "Running a command on the open command line";
    case "shell.session.list": return "Listing the command lines being kept open";
    case "shell.session.close": return "Closing a kept-open command line";
    case "remote.run": return `Running a program on ${String(a.computer ?? "another computer")}`;
    case "git.status": return "Checking what changed";
    case "git.diff": return "Looking at the changed lines";
    case "git.log": return "Looking back through saved versions";
    case "git.branch": return "Working with lines of work";
    case "git.commit": return "Saving a version";
    case "git.worktree_add": case "git.worktree_remove": case "plans.try": return "Setting up a parallel copy";
    case "git.push": return "Sending work to the server";
    case "git.pull": return "Bringing down work from the server";
    case "user.ask": return "Asking you a question";
    case "agents.ask": return `Asking ${short(a.agent)}, an assistant elsewhere`;
    case "agents.remote": return a.action === "list" ? "Listing assistants elsewhere" : "Changing the list of assistants elsewhere";
    case "specialists.delegate": return `Asking the ${short(a.id)} specialist`;
    case "specialists.fanout": return "Running several specialists";
    case "sessions.search": case "history.search": return "Looking back through earlier conversations";
    default:
      if (name.startsWith("memory.")) return name.endsWith("put") || name.endsWith("write") ? "Saving a note to memory" : "Checking memory";
      if (name.startsWith("schedules.")) return "Updating a schedule";
      if (name.startsWith("skills.")) return "Reading a skill";
      if (name.startsWith("browser.")) return "Using the browser";
      if (name.startsWith("github.")) return "Using GitHub";
      return `Using ${name}`;
  }
}

/** Steps and the current activity of one run, from its events. */
export function runActivity(run: Run, events: Event[], options: { now?: number; staleMs?: number } = {}): RunActivity {
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
  // mac7/coding-next: a model on this computer still loading into memory is still the model's turn.
  const thinking = events.at(-1)?.kind === "model.started" || events.at(-1)?.kind === "model.loading";
  const current = run.status !== "running" ? null : working ? working.label : thinking || !list.length ? "Thinking" : "Thinking about the results";
  return {
    runId: run.id, sessionId: run.sessionId, prompt: run.prompt, status: run.status,
    startedAt: run.createdAt, current, steps: list.slice(-30), ...orchestrationState(events),
    task: taskState(run, events, options),
  };
}

/** The plan, the latest "where we are" note and the reviewer's verdict, from the same event log. */
function orchestrationState(events: Event[]): Partial<RunActivity> {
  const last = (kind: string): Event | undefined => events.filter((e) => e.kind === kind).at(-1);
  const created = last("plan.created") ?? last("plan.awaiting_approval");
  const titles = (created?.data.steps as unknown[] | undefined)?.map((s) => String(s)) ?? [];
  const started = last("plan.step.started");
  const plan: ActivityPlan | undefined = titles.length
    ? {
        steps: titles,
        step: Number(started?.data.step ?? 0),
        awaitingApproval: !!last("plan.awaiting_approval") && !last("plan.approved") && !started,
        finished: !!last("plan.completed"),
      }
    : undefined;
  const milestone = last("run.milestone")?.data.text;
  const verdict = last("verify.verdict")?.data.verdict;
  return {
    ...(plan ? { plan } : {}),
    ...(milestone ? { milestone: String(milestone) } : {}),
    ...(verdict ? { verdict: String(verdict) } : {}),
  };
}

/**
 * Activity for every task of the owner that is still running, with what the conversation is doing. With
 * `waiting`, also each conversation's latest task when it stopped to ask the owner (Q51): the one the owner can
 * still answer, never an older one a later task has moved past. The default stays running tasks only, since
 * other screens count these as busy.
 */
export function liveActivity(store: Store, owner: string, options: { waiting?: boolean; staleMs?: number; now?: number } = {}): RunActivity[] {
  const runs = store.runs(owner); // the newest 100, newest first
  const running = runs.filter((run) => run.status === "running");
  /* The same tasks "Needs you" lists (server.ts `attention`): each conversation's newest, when it stopped to ask. */
  const newest = new Set<string>(), waiting: Run[] = [];
  if (options.waiting === true) for (const run of runs) {
    if (newest.has(run.sessionId)) continue;
    newest.add(run.sessionId);
    if (run.status === "needs_input") waiting.push(run);
  }
  return [...running, ...waiting].map((run) => {
    const working = store.working.describe(run.sessionId);
    return { ...runActivity(run, store.events(run.id), options), ...(working ? { working } : {}) };
  });
}

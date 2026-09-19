/**
 * Redesign phase 2 (panels): what the side panel's Browser and Terminal tabs show for one conversation.
 *
 * Nothing new runs here. It reads back what the assistant already did in the conversation's last few
 * tasks: the web pages it opened (the browser and web tools) and the commands it ran (the command tools),
 * each with what came back, and the commands it was refused or is waiting on a yes for. The owner's
 * alone: src/short-lived-keys.ts refuses it to every short-lived key, and so to a household person.
 *
 *   GET /api/panels/work?session=<id>
 */
import type { Store } from "./store.js";
import type { Event, Run } from "./contracts.js";

export const panelsWorkPath = "/api/panels/work";
/** How many of the conversation's latest tasks are read, and how much of any output is kept. */
const TASKS = 8;
const OUTPUT = 1200;
const ENTRIES = 40;

export type WorkState = "running" | "done" | "failed" | "stopped" | "practice" | "refused" | "waiting";
export interface WorkEntry {
  at: string;
  tool: string;
  /** The command line, or the web address or search; the step's plain label when neither is known. */
  what: string;
  output: string | null;
  state: WorkState;
}
export interface PanelsWork {
  running: boolean;
  browser: { entries: WorkEntry[]; picture: string | null };
  terminal: { entries: WorkEntry[] };
}

export const isBrowserTool = (tool: string): boolean => /^(browser|web)\./.test(tool);
/** The same tools src/policy-resources.ts treats as command lines, and the programs kept running. */
export const isTerminalTool = (tool: string): boolean =>
  tool === "shell.execute" || /^(shell|terminal)\./.test(tool) || tool === "process.start" || tool === "remote.run";

const text = (value: unknown): string => (typeof value === "string" ? value : "");
function parsed(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  try { const value: unknown = JSON.parse(text(raw)); return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
  catch { return {}; }
}
const joined = (program: unknown, rest: unknown): string =>
  [program, ...(Array.isArray(rest) ? rest : [])].map((v) => String(v ?? "")).join(" ").trim();

/** What a call was about, in the words a person would recognise: the command, or the address. */
export function describe(tool: string, args: Record<string, unknown>): string {
  if (tool === "shell.execute") return joined(args.executable, args.args);
  if (tool === "shell.session.run") return text(args.input);
  if (tool === "shell.session.open" || tool === "remote.run" || tool === "process.start") return joined(args.program ?? args.command, args.args);
  if (tool === "web.search") return text(args.query);
  return text(args.url) || text(args.address) || text(args.query);
}
function clipped(value: string): string {
  return value.length > OUTPUT ? value.slice(0, OUTPUT) + "…" : value;
}
/** What came back, as text: a command's printout, or the page's address and title. */
export function outputOf(tool: string, result: unknown): string | null {
  if (result === undefined || result === null) return null;
  if (typeof result === "string") return clipped(result);
  const r = result as Record<string, unknown>;
  if (isTerminalTool(tool)) {
    const printed = [text(r.stdout), text(r.stderr), text(r.output)].filter(Boolean).join("\n").trim();
    const exit = typeof r.exitCode === "number" && r.exitCode !== 0 ? `(finished with code ${r.exitCode})` : "";
    return clipped([printed, exit].filter(Boolean).join("\n")) || null;
  }
  const page = [text(r.title), text(r.url)].filter(Boolean).join(" · ");
  return page ? clipped(page) : null;
}

/** Each tool call's arguments, read back off the assistant messages by call id. */
function argumentsById(store: Store, sessionId: string): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  for (const message of store.messages(sessionId))
    for (const call of message.toolCalls ?? []) found.set(call.id, parsed(call.arguments));
  return found;
}
const ENDED: Record<string, WorkState> = {
  "tool.completed": "done", "tool.failed": "failed", "tool.stalled": "stopped", "tool.simulated": "practice",
  "policy.denied": "refused", "policy.ask": "waiting",
};
/** One task's browser and command steps, in the order they happened. */
function entriesOf(events: Event[], given: Map<string, Record<string, unknown>>, running: boolean): WorkEntry[] {
  const open = new Map<string, WorkEntry>();
  const out: WorkEntry[] = [];
  for (const event of events) {
    const data = event.data;
    const tool = text(data.name);
    if (!isBrowserTool(tool) && !isTerminalTool(tool)) continue;
    const id = text(data.id) || `event-${event.id}`; // a step with no call id stands alone
    const state = event.kind === "tool.started" ? "running" : ENDED[event.kind];
    if (!state) continue;
    const said = describe(tool, given.get(id) ?? {});
    const entry = open.get(id) ?? { at: event.createdAt, tool, what: said || text(data.target) || text(data.label), output: null, state };
    if (!open.has(id)) { open.set(id, entry); out.push(entry); }
    entry.state = state;
    if (event.kind === "tool.started") continue;
    // A browser step whose arguments named no page (a picture, a click) says which page it was on.
    const page = isBrowserTool(tool) && !said ? text(parsed(data.result).url) : "";
    if (page) entry.what = page;
    entry.output = (page ? text(parsed(data.result).title) || null : outputOf(tool, data.result ?? data.error ?? data.reason)) ?? entry.output;
  }
  // A step left "running" in a task that is over never finished; a question left open still waits.
  if (!running) for (const entry of out) if (entry.state === "running") entry.state = "stopped";
  return out;
}
/** The last picture the browser took in these tasks, as the path the artifacts route serves. */
function lastPicture(events: Event[]): string | null {
  let found: string | null = null;
  for (const event of events) {
    if (event.kind !== "tool.completed" || event.data.name !== "browser.screenshot") continue;
    const path = text(parsed(event.data.result).path);
    if (path) found = path;
  }
  return found;
}

/** Everything the two tabs show for this conversation; empty lists when it is not the owner's. */
export function panelsWork(store: Store, owner: string, sessionId: string): PanelsWork {
  const empty: PanelsWork = { running: false, browser: { entries: [], picture: null }, terminal: { entries: [] } };
  if (!sessionId || !store.ownsSession(owner, sessionId)) return empty;
  const runs: Run[] = store.runs(owner).filter((run) => run.sessionId === sessionId).slice(0, TASKS).reverse();
  const given = argumentsById(store, sessionId);
  const all: WorkEntry[] = [];
  let picture: string | null = null;
  for (const run of runs) {
    const events = store.events(run.id);
    all.push(...entriesOf(events, given, run.status === "running"));
    picture = lastPicture(events) ?? picture;
  }
  return {
    running: runs.some((run) => run.status === "running"),
    browser: { entries: all.filter((entry) => isBrowserTool(entry.tool)).slice(-ENTRIES), picture },
    terminal: { entries: all.filter((entry) => isTerminalTool(entry.tool)).slice(-ENTRIES) },
  };
}

import type { Event, Run } from "./contracts.js";
import { classifyToolEvent, type Receipts, type ToolOutcomeKind } from "./receipts.js";

/**
 * Q52: what a finished task made and how that was checked, told only from what its own record shows: each file it
 * wrote or changed and each artifact it kept, with the proof its tool's receipt gives (checked and confirmed, no
 * proof kept, changed after it was done...); the project checks it ran and the reviewer's verdict; and, when it
 * worked on Branch's own source, how far that change has got. Nothing here records a review's outcome, a merge or
 * a release, so those read "unknown" rather than a guess.
 */
export interface Made { kind: "file" | "artifact"; path: string; tool: string; created: boolean; proof: ToolOutcomeKind | "not recorded" }
export interface Checked { kind: "project check" | "review"; passed: boolean; detail: string }
export interface OwnChange { codeChanged: boolean; tests: "passed" | "failed" | "not run"; review: "pending" | "not opened"; merged: "unknown"; inRelease: "unknown" }
export interface RunResult { runId: string; status: Run["status"]; made: Made[]; checked: Checked[]; ownChange: OwnChange | null }

const artifactOf = (result: unknown): { path: string } | null => {
  const value = result && typeof result === "object" ? result as Record<string, unknown> : null;
  return value && typeof value.path === "string" && typeof value.sha256 === "string" ? { path: value.path } : null;
};

const ENDS = new Set(["tool.completed", "tool.failed", "tool.stalled"]);
const samePath = (a: string, b: string) => a.replace(/\\/g, "/").replace(/^\.\//, "") === b.replace(/\\/g, "/").replace(/^\.\//, "");

export async function runResult(receipts: Receipts, run: Run, events: Event[]): Promise<RunResult> {
  const open = new Map<string, { name: string; path?: string | undefined }>(), ended = new Map<string, Event>();
  const changes: { path: string; tool: string; id: string; created: boolean }[] = [];
  for (const event of events) {
    const id = String(event.data.id ?? "");
    if (event.kind === "tool.started") open.set(id, { name: String(event.data.name ?? "tool"), path: typeof event.data.path === "string" ? event.data.path : undefined });
    else if (ENDS.has(event.kind) && !ended.has(id)) ended.set(id, event);
    else if (event.kind === "file.changed" && typeof event.data.path === "string") {
      /* A change is made inside a tool still running when it is recorded: the one about that path, else the latest. */
      const path = event.data.path, running = [...open.entries()].filter(([one]) => !ended.has(one));
      const [toolId, tool] = running.find(([, one]) => one.path && samePath(one.path, path)) ?? running.at(-1) ?? ["", { name: "tool" }];
      changes.push({ path, tool: tool.name, id: toolId, created: event.data.existed === false });
    }
  }
  const proofOf = async (id: string) => {
    const done = ended.get(id);
    return done ? (await classifyToolEvent(receipts, run.id, done.kind, done.data)) ?? "not recorded" : "not recorded";
  };
  const made: Made[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.path)) continue;
    seen.add(change.path);
    made.push({ kind: "file", path: change.path, tool: change.tool, created: change.created, proof: await proofOf(change.id) });
  }
  for (const [id, event] of ended) {
    const artifact = event.kind === "tool.completed" ? artifactOf(event.data.result) : null;
    if (artifact && !seen.has(artifact.path)) {
      seen.add(artifact.path);
      made.push({ kind: "artifact", path: artifact.path, tool: String(event.data.name ?? "tool"), created: true, proof: await proofOf(id) });
    }
  }
  const checked: Checked[] = [];
  for (const event of events) {
    if (event.kind === "code.check") checked.push({ kind: "project check", passed: event.data.ok === true, detail: String(event.data.status ?? "") });
    if (event.kind === "verify.verdict") checked.push({ kind: "review", passed: event.data.verdict === "accept", detail: String(event.data.verdict ?? "") });
  }
  return { runId: run.id, status: run.status, made, checked, ownChange: ownChange(events, made, checked) };
}

/** Branch's own source: only when the task prepared a change to it or opened a pull request for one. */
function ownChange(events: Event[], made: Made[], checked: Checked[]): OwnChange | null {
  const prepared = events.some((event) => event.kind === "tool.started" && event.data.name === "branch.prepare_source_change");
  const opened = events.some((event) => event.kind === "pull_request.opened");
  if (!prepared && !opened) return null;
  const check = checked.filter((one) => one.kind === "project check").at(-1);
  return {
    codeChanged: made.some((one) => one.kind === "file"),
    tests: check ? (check.passed ? "passed" : "failed") : "not run",
    review: opened ? "pending" : "not opened",
    merged: "unknown", inRelease: "unknown",
  };
}

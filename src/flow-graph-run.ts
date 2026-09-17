import { z } from "zod";
import { errorText } from "./contracts.js";
import { ApprovalRequiredError, PolicyRefusedError } from "./approvals.js";
import { argumentFingerprint } from "./runtime.js";
import type { Runtime } from "./runtime.js";
import type { Store } from "./store.js";
import type { RunSource } from "./policy.js";
import { compileGraph, type CompiledGraph, type GraphEdge, type GraphNode } from "./flow-graph.js";

/**
 * Running a flow that is a real graph: one state object carried from box to box, each box handing
 * back a patch of just the values it said it would write, arrows chosen from what the last box
 * found, circles gone round only as many times as the owner allowed, and the state written down
 * after every single box — so a flow that stops at the ninth box carries on from the ninth box,
 * not from the first.
 *
 * Every start, finish and failure is also written as an event against the flow's own task, which
 * is what the run socket already streams, so a page watching the flow sees it happen.
 */
export type GraphRunStatus = "running" | "completed" | "failed" | "waiting_approval" | "interrupted";
export interface GraphNodeState { seq: number; nodeId: string; name: string; status: string; output: string; updatedAt: string }
export interface GraphRunView {
  runId: string; flowId: string; status: GraphRunStatus; nextNode: string | null;
  state: Record<string, unknown>; error: string | null; question: string | null;
  nodes: GraphNodeState[];
}
/**
 * How deep one flow may reach into another: three flows counting the outer one, so a flow inside a
 * flow inside a flow is the most there can be.
 *
 * Careful: this counts differently from `maximumFlowDepth` in `src/workflows.ts` even though the
 * number and the names match. There the chain is measured from the flow doing the calling, so the
 * outermost flow is not in it; here the check is `chain.length + 2 > maximumGraphDepth`, which puts
 * the outermost flow in the count. The two are the same depth in practice; the arithmetic is not
 * the same, so do not copy one condition into the other.
 */
export const maximumGraphDepth = 3;
const jsonOf = (value: unknown): string => {
  try { return JSON.stringify(value) ?? ""; } catch { return String(value); }
};
/** "{name}" in a box's words or arguments, filled in from the state. */
export function fillIn(text: string, state: Record<string, unknown>): string {
  return text.replace(/\{([a-z][A-Za-z0-9_]{0,39})\}/g, (whole, name: string) =>
    (name in state ? (typeof state[name] === "string" ? state[name] : jsonOf(state[name])) : whole));
}
const filledArgs = (args: Record<string, unknown>, state: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(args).map(([key, value]) =>
    [key, typeof value === "string" ? fillIn(value, state) : value]));

/** What one box handed back: its patch of the state, its words, and which way out it chose. */
interface NodeResult { patch: Record<string, unknown>; output: string; matched?: boolean }

export class FlowGraphRunner {
  constructor(
    private readonly store: Store,
    private readonly owner: string,
    private readonly runtime: Runtime,
    /** A saved flow's definition, so a box whose body is another flow can find it. */
    private readonly definitionOf: (flowId: string) => unknown,
  ) {
    this.store.sqlite.exec(`CREATE TABLE IF NOT EXISTS flow_graph_runs(run_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL, flow_id TEXT NOT NULL, status TEXT NOT NULL, next_node TEXT,
      state TEXT NOT NULL DEFAULT '{}', loops TEXT NOT NULL DEFAULT '{}', error TEXT, question TEXT,
      approval TEXT, depth INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS flow_graph_nodes(run_id TEXT NOT NULL, seq INTEGER NOT NULL,
      node_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL, PRIMARY KEY(run_id, seq))`);
  }

  /** Starts a flow. The task id comes back at once; the boxes are worked through after that. */
  begin(flow: unknown, input: Record<string, unknown>, options: { source?: RunSource; depth?: number; chain?: readonly string[] } = {}): { runId: string; compiled: CompiledGraph } {
    const compiled = compileGraph(flow);
    const state = { ...(compiled.inputSchema.parse(input) as Record<string, unknown>) };
    const run = this.store.createRun(this.owner, `Flow: ${compiled.definition.name}`, undefined, false, "schedule");
    const flowId = compiled.definition.id ?? run.id;
    this.store.sqlite.prepare(`INSERT INTO flow_graph_runs(run_id,owner,flow_id,status,next_node,state,loops,depth,updated_at)
      VALUES(?,?,?,'running',?,?,'{}',?,?)`).run(run.id, this.owner, flowId, compiled.definition.entry,
      JSON.stringify(state), options.depth ?? 0, new Date().toISOString());
    return { runId: run.id, compiled };
  }

  /** Works through the boxes from wherever the checkpoint says, writing the state after each one. */
  async work(runId: string, compiled: CompiledGraph, options: { source?: RunSource; chain?: readonly string[] } = {}): Promise<GraphRunView> {
    const limit = compiled.definition.loopLimit;
    let saved = this.checkpoint(runId);
    let at = saved.nextNode, state = saved.state, loops = saved.loops, seq = this.lastSeq(runId);
    while (at) {
      const node = compiled.nodes.get(at);
      if (!node) return this.stop(runId, "failed", `The flow points at a box "${at}" that is not there.`);
      this.writeNode(runId, ++seq, node, "running", "");
      this.store.event(runId, "flow.node.started", { node: node.id, name: node.name, kind: node.kind, seq });
      const result = await this.attempt(runId, seq, node, state, compiled, options);
      if ("stopped" in result) return result.stopped;
      state = { ...state, ...result.patch };
      this.writeNode(runId, seq, node, "done", result.output);
      this.store.event(runId, "flow.node.finished", { node: node.id, name: node.name, seq, output: result.output.slice(0, 500) });
      const step = this.chooseNext(node, result, compiled, loops, limit);
      if ("refusal" in step) return this.stop(runId, "failed", step.refusal);
      at = step.to; loops = step.loops;
      this.save(runId, { next_node: at, state: JSON.stringify(state), loops: JSON.stringify(loops) });
    }
    this.save(runId, { status: "completed", state: JSON.stringify(state) });
    this.store.finish(runId, "completed", `The flow "${compiled.definition.name}" finished.`);
    return this.view(runId);
  }

  /** One box, with the two ways it can stop the whole flow kept apart from an ordinary failure. */
  private async attempt(runId: string, seq: number, node: GraphNode, state: Record<string, unknown>,
    compiled: CompiledGraph, options: { source?: RunSource; chain?: readonly string[] }):
    Promise<NodeResult | { stopped: GraphRunView }> {
    try {
      const result = await this.runNode(node, state, compiled, options);
      compiled.patchSchema.get(node.id)?.parse(result.patch);
      return result;
    } catch (error) {
      if (error instanceof ApprovalRequiredError) {
        this.writeNode(runId, seq, node, "waiting", error.message);
        this.store.event(runId, "flow.node.waiting", { node: node.id, name: node.name, seq });
        this.save(runId, { status: "waiting_approval", next_node: node.id, question: error.message,
          approval: JSON.stringify({ tool: error.tool, target: error.target, label: error.label,
            remember: error.remember, fingerprint: error.fingerprint, source: options.source ?? "owner" }) });
        this.store.finish(runId, "needs_input", error.message);
        return { stopped: this.view(runId) };
      }
      const reason = this.reasonFor(node, error);
      this.writeNode(runId, seq, node, "failed", reason);
      this.store.event(runId, "flow.node.failed", { node: node.id, name: node.name, seq, error: reason });
      return { stopped: this.stop(runId, "failed", reason) };
    }
  }

  /** A failure said the way a person would say it, always naming the box it happened in. */
  private reasonFor(node: GraphNode, error: unknown): string {
    if (error instanceof z.ZodError)
      return `The box "${node.name}" handed back something it never said it would write: ${error.issues.map((i) => i.path.join(".") || i.message).join(", ")}.`;
    if (error instanceof PolicyRefusedError) return `The box "${node.name}" was refused: ${error.message}`;
    return `The box "${node.name}" did not finish: ${errorText(error)}`;
  }

  /** The arrow out of a box: the one its answer chose, and the count of every circle gone round. */
  private chooseNext(node: GraphNode, result: NodeResult, compiled: CompiledGraph,
    loops: Record<string, number>, limit: number): { to: string | null; loops: Record<string, number> } | { refusal: string } {
    const out = compiled.next.get(node.id) ?? [];
    const wanted = node.kind === "condition" ? (result.matched ? "matched" : "otherwise") : "always";
    const edge: GraphEdge | undefined = out.find((candidate) => candidate.when === wanted) ?? out.find((candidate) => candidate.when === "always");
    if (!edge) return { to: null, loops };
    if (!edge.loop) return { to: edge.to, loops };
    const key = `${edge.from}->${edge.to}`, taken = (loops[key] ?? 0) + 1;
    if (taken > limit)
      return { refusal: `The flow went from "${node.name}" back round the circle ${limit} time(s), which is the limit set on this flow, so it stopped there.` };
    return { to: edge.to, loops: { ...loops, [key]: taken } };
  }

  /** What one kind of box actually does. Each returns a patch of only what it said it would write. */
  private async runNode(node: GraphNode, state: Record<string, unknown>, compiled: CompiledGraph,
    options: { source?: RunSource; chain?: readonly string[] }): Promise<NodeResult> {
    if (node.kind === "condition") {
      const looked = String(state[node.field!] ?? "");
      return { patch: {}, output: looked.toLowerCase().includes(node.contains!.toLowerCase()) ? "matched" : "otherwise",
        matched: looked.toLowerCase().includes(node.contains!.toLowerCase()) };
    }
    if (node.kind === "gather") {
      const list = Array.isArray(state[node.overField!]) ? (state[node.overField!] as unknown[]) : [];
      const joined = list.map((item) => (typeof item === "string" ? item : jsonOf(item))).join("\n");
      return { patch: { [node.intoField!]: joined }, output: `Gathered ${list.length} answer(s).` };
    }
    if (node.kind === "map") return this.mapOver(node, state, options);
    if (node.kind === "subflow") return this.subflow(node, state, options);
    if (node.kind === "prompt") {
      const run = await this.runtime.run({ prompt: fillIn(node.prompt!, state),
        signal: AbortSignal.timeout(node.timeoutMs), source: "schedule", onTextDelta: () => undefined });
      if (run.status !== "completed") throw new Error(`the assistant stopped (${run.status})`);
      return { patch: this.asPatch(node, run.output), output: run.output.slice(0, 2000) };
    }
    const result = await this.useTool(node, filledArgs(node.args ?? {}, state), options.source ?? "owner");
    return { patch: this.asPatch(node, result), output: jsonOf(result).slice(0, 2000) };
  }

  /**
   * Fan-out then fan-in: the same tool over every item of a list, all at once, and what came back
   * collected in the list's own order. Where two items write the same value, the last one wins —
   * they finish in whatever order they finish, so only the order of the list is relied on.
   */
  private async mapOver(node: GraphNode, state: Record<string, unknown>, options: { source?: RunSource }): Promise<NodeResult> {
    const list = Array.isArray(state[node.overField!]) ? (state[node.overField!] as unknown[]) : [];
    if (!node.tool) throw new Error("a map box needs a tool to use on each item");
    const done = await Promise.all(list.map(async (item) => {
      const args = filledArgs(node.args ?? {}, { ...state, item });
      return jsonOf(await this.useTool(node, { ...args, item }, options.source ?? "owner"));
    }));
    return { patch: { [node.intoField!]: done }, output: `Worked through ${done.length} item(s).` };
  }

  /** A box whose body is another saved flow, with a state of its own and no way round in a circle. */
  private async subflow(node: GraphNode, state: Record<string, unknown>, options: { source?: RunSource; chain?: readonly string[] }): Promise<NodeResult> {
    const chain = [...(options.chain ?? [])];
    if (chain.includes(node.flowId!))
      throw new Error(`that flow leads back to one already running (${node.flowId}), so it was not started`);
    // The outer flow is the first of the three, so the chain may hold two before a fourth is asked for.
    if (chain.length + 2 > maximumGraphDepth)
      throw new Error(`flows may only go ${maximumGraphDepth} deep; this one would be ${chain.length + 2}`);
    const inner = Object.fromEntries(Object.keys(node.input).map((name) => [name, state[name]]));
    const started = this.begin(this.definitionOf(node.flowId!), inner, { ...(options.source === undefined ? {} : { source: options.source }), depth: chain.length + 1 });
    const finished = await this.work(started.runId, started.compiled, { ...(options.source === undefined ? {} : { source: options.source }), chain: [...chain, node.flowId!] });
    if (finished.status !== "completed") throw new Error(finished.error ?? `the flow inside it stopped (${finished.status})`);
    const patch = Object.fromEntries(Object.keys(node.output)
      .filter((name) => finished.state[name] !== undefined).map((name) => [name, finished.state[name]]));
    return { patch, output: `The flow inside it finished ${finished.nodes.length} box(es).` };
  }

  /** A tool used by a box, held to exactly the approval settings a step of a saved workflow is. */
  private async useTool(node: GraphNode, args: Record<string, unknown>, source: RunSource): Promise<unknown> {
    const context = this.runtime.context({ signal: AbortSignal.timeout(node.timeoutMs), source, approvalKey: `flow:${node.id}` });
    const fingerprint = argumentFingerprint(JSON.stringify(args));
    const check = this.runtime.checkPolicy(node.tool!, args, context, fingerprint);
    if (check.decision === "deny") throw new PolicyRefusedError(node.tool!, check.label);
    if (check.decision === "ask") throw new ApprovalRequiredError(node.tool!, check.target, check.label, check.remember, fingerprint);
    return this.runtime.executeTool(node.tool!, args);
  }

  /** What a box that hands back one thing writes: the single value it declared, filled in. */
  private asPatch(node: GraphNode, value: unknown): Record<string, unknown> {
    const declared = Object.entries(node.output);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const picked = Object.fromEntries(declared.filter(([name]) => name in (value as Record<string, unknown>))
        .map(([name]) => [name, (value as Record<string, unknown>)[name]]));
      if (Object.keys(picked).length) return picked;
    }
    const single = declared[0];
    if (declared.length !== 1 || !single) return {};
    const kind = single[1].replace(/\?$/, "");
    if (kind === "text") return { [single[0]]: typeof value === "string" ? value : jsonOf(value) };
    return { [single[0]]: value };
  }

  /* ---------- checkpoints ---------- */

  private lastSeq(runId: string): number {
    const row = this.store.sqlite.prepare("SELECT MAX(seq) AS top FROM flow_graph_nodes WHERE run_id=?").get(runId);
    return Number(row?.top ?? 0);
  }
  private writeNode(runId: string, seq: number, node: GraphNode, status: string, output: string): void {
    this.store.sqlite.prepare(`INSERT INTO flow_graph_nodes VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(run_id,seq) DO UPDATE SET status=excluded.status, output=excluded.output, updated_at=excluded.updated_at`)
      .run(runId, seq, node.id, node.name, status, output.slice(0, 4000), new Date().toISOString());
  }
  private save(runId: string, patch: Record<string, string | null>): void {
    const keys = Object.keys(patch);
    this.store.sqlite.prepare(`UPDATE flow_graph_runs SET ${keys.map((key) => `${key}=?`).join(",")}, updated_at=? WHERE run_id=?`)
      .run(...keys.map((key) => patch[key] ?? null), new Date().toISOString(), runId);
  }
  private stop(runId: string, status: GraphRunStatus, error: string): GraphRunView {
    this.save(runId, { status, error });
    this.store.finish(runId, "failed", error);
    return this.view(runId);
  }
  /** What the checkpoint says: where to carry on from, and the state as it was after the last box. */
  checkpoint(runId: string): { nextNode: string | null; state: Record<string, unknown>; loops: Record<string, number> } {
    const row = this.store.sqlite.prepare("SELECT * FROM flow_graph_runs WHERE run_id=? AND owner=?").get(runId, this.owner);
    if (!row) throw new Error("That flow run is not on file");
    return { nextNode: row.next_node === null ? null : String(row.next_node),
      state: JSON.parse(String(row.state ?? "{}")) as Record<string, unknown>,
      loops: JSON.parse(String(row.loops ?? "{}")) as Record<string, number> };
  }
  view(runId: string): GraphRunView {
    const row = this.store.sqlite.prepare("SELECT * FROM flow_graph_runs WHERE run_id=? AND owner=?").get(runId, this.owner);
    if (!row) throw new Error("That flow run is not on file");
    return { runId, flowId: String(row.flow_id), status: String(row.status) as GraphRunStatus,
      nextNode: row.next_node === null ? null : String(row.next_node),
      state: JSON.parse(String(row.state ?? "{}")) as Record<string, unknown>,
      error: row.error === null ? null : String(row.error),
      question: row.question === null ? null : String(row.question),
      nodes: this.store.sqlite.prepare("SELECT * FROM flow_graph_nodes WHERE run_id=? ORDER BY seq").all(runId)
        .map((node) => ({ seq: Number(node.seq), nodeId: String(node.node_id), name: String(node.name),
          status: String(node.status), output: String(node.output), updatedAt: String(node.updated_at) })) };
  }
  /** Runs left working when the app closed, newest first. These are the ones a start picks up. */
  unfinished(): GraphRunView[] {
    return this.store.sqlite.prepare(
      "SELECT run_id FROM flow_graph_runs WHERE owner=? AND status IN ('running','interrupted') ORDER BY updated_at DESC LIMIT 20")
      .all(this.owner).map((row) => this.view(String(row.run_id)));
  }
  /**
   * The newest run of one flow that has not finished — stopped, failed, or waiting on the owner.
   * This is what "carry it on" carries on, and it always has a box to carry on from.
   */
  resumable(flowId: string): GraphRunView | null {
    const row = this.store.sqlite.prepare(
      `SELECT run_id FROM flow_graph_runs WHERE owner=? AND flow_id=? AND status<>'completed'
       AND next_node IS NOT NULL ORDER BY updated_at DESC LIMIT 1`).get(this.owner, flowId);
    return row ? this.view(String(row.run_id)) : null;
  }
  /** A run left working when the app closed. Marked so the next start can pick it up again. */
  markInterrupted(): number {
    return Number(this.store.sqlite.prepare("UPDATE flow_graph_runs SET status='interrupted' WHERE owner=? AND status='running'")
      .run(this.owner).changes ?? 0);
  }
  /** The owner's yes to what a box stopped to ask about, remembered against this flow run. */
  approve(runId: string, remember?: "never" | "session" | "always"): void {
    const row = this.store.sqlite.prepare("SELECT approval, next_node FROM flow_graph_runs WHERE run_id=? AND owner=?").get(runId, this.owner);
    const asked = row?.approval ? JSON.parse(String(row.approval)) as { tool: string; target: string; label: string; remember: "never" | "session" | "always"; fingerprint?: string; source: RunSource } : null;
    if (!asked) return;
    this.runtime.grantApproval(`flow:${String(row?.next_node ?? "")}`, { tool: asked.tool, target: asked.target,
      label: asked.label, source: asked.source, ...(asked.fingerprint === undefined ? {} : { fingerprint: asked.fingerprint }) },
      remember ?? asked.remember);
    this.save(runId, { approval: null, question: null });
  }
  /** Carries a checkpointed run on from the box after the last one that finished. */
  async resume(runId: string, flow: unknown, options: { source?: RunSource; approve?: boolean } = {}): Promise<GraphRunView> {
    const current = this.view(runId);
    if (current.status === "completed") throw new Error("That flow has already finished");
    if (options.approve) this.approve(runId);
    const compiled = compileGraph(flow);
    this.save(runId, { status: "running", error: null });
    this.store.sqlite.prepare("UPDATE tasks SET status='running' WHERE id=?").run(runId);
    return this.work(runId, compiled, { ...(options.source === undefined ? {} : { source: options.source }) });
  }
}

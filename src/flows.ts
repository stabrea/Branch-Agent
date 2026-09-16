import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import type { WebhookNotifier } from "./webhooks.js";
import { WorkflowSchema, type StepState, type Workflows, type WorkflowStep, type WorkflowView } from "./workflows.js";

/**
 * A flow is a saved workflow seen as a picture: the steps are boxes and the arrows say what happens
 * after each one — carry straight on, or skip ahead because the last answer did not say what was
 * expected. The same thing runs it; this only gives it a shape other programs can read and draw,
 * a way in over HTTP, and a note sent out to whoever asked as each box finishes.
 */
export interface FlowNode {
  id: string; index: number; name: string; kind: string;
  /** What this box actually does, in one line, for anybody reading the picture. */
  detail: string;
  status: string; attempts: number; output: string; startedAt: string | null;
}
export interface FlowEdge { from: string; to: string; when: "next" | "matched" | "skipped" }
export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[] }
export interface FlowView extends Omit<WorkflowView, "state"> { graph: FlowGraph }

const nodeId = (index: number): string => `n${index + 1}`;
const detailOf = (step: WorkflowStep): string => {
  if (step.kind === "prompt") return (step.prompt ?? "").slice(0, 120);
  if (step.kind === "tool") return step.tool ?? "";
  if (step.kind === "recipe") return `saved procedure ${step.recipeId ?? ""}`;
  if (step.kind === "approval") return step.question ?? "waits for the owner to say yes";
  if (step.kind === "wait") return `waits ${step.waitMinutes ?? 0} minute(s)`;
  return `carries on when the last answer mentions "${step.contains ?? ""}"`;
};

/** The boxes and arrows of one workflow, with where each box has got to written on it. */
export function flowGraph(steps: WorkflowStep[], state: StepState[]): FlowGraph {
  const byIndex = new Map(state.map((entry) => [entry.index, entry]));
  const nodes: FlowNode[] = steps.map((step, index) => {
    const known = byIndex.get(index);
    return { id: nodeId(index), index, name: step.name, kind: step.kind, detail: detailOf(step),
      status: known?.status ?? "waiting", attempts: known?.attempts ?? 0,
      output: (known?.output ?? "").slice(0, 500), startedAt: known?.startedAt ?? null };
  });
  const edges: FlowEdge[] = [];
  for (const [index, step] of steps.entries()) {
    const next = index + 1;
    if (step.kind === "branch") {
      if (next < steps.length) edges.push({ from: nodeId(index), to: nodeId(next), when: "matched" });
      const skipped = next + (step.skipAhead ?? 1);
      if (skipped < steps.length) edges.push({ from: nodeId(index), to: nodeId(skipped), when: "skipped" });
      continue;
    }
    if (next < steps.length) edges.push({ from: nodeId(index), to: nodeId(next), when: "next" });
  }
  return { nodes, edges };
}

/** A flow given as a graph instead of a list; the nodes are the steps, in the order they are given. */
export const FlowGraphInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  nodes: z.array(z.record(z.string(), z.unknown())).min(1).max(20),
}).strict();

/** Either shape the API accepts, turned into what the workflow runner understands. */
export function flowDefinition(input: unknown): unknown {
  const asGraph = FlowGraphInputSchema.safeParse(input);
  if (!asGraph.success) return input;
  const { nodes, ...rest } = asGraph.data;
  return { ...rest, steps: nodes };
}

export class Flows {
  /** Set by the launch so each finished box can be announced to whoever asked to hear about it. */
  notifyEvent: WebhookNotifier = () => undefined;
  constructor(private readonly store: Store, private readonly owner: string, private readonly workflows: Workflows) {}
  private view(workflow: WorkflowView): FlowView {
    const { state, ...rest } = workflow;
    return { ...rest, graph: flowGraph(workflow.steps, state) };
  }
  list(): FlowView[] { return this.workflows.list(this.owner).map((flow) => this.view(flow)); }
  get(id: string): FlowView { return this.view(this.workflows.view(this.owner, id)); }
  save(input: unknown): FlowView {
    const parsed = WorkflowSchema.parse(flowDefinition(input));
    return this.view(this.workflows.create(this.owner, parsed));
  }
  remove(id: string): { removed: boolean } { return this.workflows.remove(this.owner, id); }
  /** Starts a flow, telling whoever asked about each box as it finishes. */
  async run(id: string, options: { resume?: boolean } = {}): Promise<FlowView> {
    const before = this.workflows.stepStates(this.owner, id);
    const finished = await (options.resume ? this.workflows.resume(this.owner, id) : this.workflows.run(this.owner, id));
    this.announce(id, before, this.workflows.stepStates(this.owner, id));
    return this.view(finished);
  }
  pause(id: string): FlowView { return this.view(this.workflows.pause(this.owner, id)); }
  /** Sends one note per box that reached a settled state while the flow was running. */
  private announce(id: string, before: StepState[], after: StepState[]): void {
    const was = new Map(before.map((entry) => [entry.index, entry.status]));
    for (const entry of after) {
      if (was.get(entry.index) === entry.status || entry.status === "running" || entry.status === "retrying") continue;
      this.notifyEvent("flow.node", { flowId: id, node: nodeId(entry.index), index: entry.index,
        name: entry.name, kind: entry.kind, status: entry.status, output: entry.output.slice(0, 500) });
    }
  }
}

export function registerFlows(registry: ToolRegistry, flows: Flows): void {
  registry.register({
    name: "flows.list", permission: "workflows.read", group: "agents",
    description: "Saved flows as boxes and arrows: every step, what it does, where it has got to, and which step follows which.",
    parameters: z.object({}).strict(),
    execute: async () => ({ flows: flows.list() }),
  });
}

/** The routes for flows: the whole list, one flow, and starting one. Returns null for other paths. */
export async function flowsApi(
  flows: Flows,
  request: { method?: string | undefined },
  path: string,
  body: () => Promise<unknown>,
): Promise<unknown | null> {
  const method = request.method ?? "GET";
  if (path === "/api/flows") {
    if (method === "GET") return { flows: flows.list() };
    if (method === "POST") return flows.save(await body());
    return null;
  }
  const match = /^\/api\/flows\/([a-f0-9-]{36})(?:\/(run|resume|pause))?$/.exec(path);
  if (!match) return null;
  const id = match[1]!;
  if (method === "GET" && !match[2]) return flows.get(id);
  if (method === "PUT" && !match[2]) return flows.save({ ...(await body() as Record<string, unknown>), id });
  if (method === "DELETE" && !match[2]) return flows.remove(id);
  if (method === "POST" && match[2] === "run") return flows.run(id);
  if (method === "POST" && match[2] === "resume") return flows.run(id, { resume: true });
  if (method === "POST" && match[2] === "pause") return flows.pause(id);
  return null;
}

import { z } from "zod";
import { errorText, estimateTokens, type ToolContext } from "../contracts.js";
import { compileGraph, FlowGraphError, type FlowGraphDefinition } from "../flow-graph.js";
import type { Flows } from "../flows.js";
import type { ToolRegistry } from "../registry.js";
import type { Runtime } from "../runtime.js";
import { requireInterop } from "./settings.js";

/**
 * Finding a better flow automatically. Given a goal and a few worked examples (an input and words
 * the answer should contain), the model drafts several different flows as boxes and arrows; each is
 * checked the way the flow editor checks one, tried on every example, and scored on how many answers
 * contain what was expected. The best is then shown its misses and asked for a better version, a
 * bounded number of times. Nothing is saved unless the owner asks, and a saved flow is an ordinary
 * flow they can open, change or delete.
 *
 * The idea is MetaGPT's AFlow (searching over agentic workflows by trying them); this is a small,
 * bounded, independent implementation: greedy improvement, not a tree search.
 */
export const FlowSearchSchema = z.object({
  goal: z.string().trim().min(1).max(2000),
  examples: z.array(z.object({
    input: z.record(z.string(), z.unknown()),
    expect: z.string().trim().min(1).max(500),
  }).strict()).min(1).max(5),
  candidates: z.number().int().min(1).max(4).default(3),
  rounds: z.number().int().min(0).max(2).default(1),
  save: z.boolean().default(false),
}).strict();
export type FlowSearchInput = z.input<typeof FlowSearchSchema>;

export interface FlowSearchParts {
  /** Answers one prompt with text: a model, or a fake in a test. */
  ask: (prompt: string) => Promise<string>;
  /** Runs one flow on one input and hands back its final state. */
  tryFlow: (definition: FlowGraphDefinition, input: Record<string, unknown>) => Promise<{ status: string; state: Record<string, unknown> }>;
  save: (definition: FlowGraphDefinition) => { id?: string };
}

export interface Scored { name: string; score: number; problems: string[]; misses: string[]; definition: FlowGraphDefinition | null }

const shapeNote = `Each flow is JSON: {"name":"…","input":{"field":"text"},"state":{"field":"text","answer":"text"},"entry":"first-box-id",` +
  `"nodes":[{"id":"box-id","name":"…","kind":"prompt","input":{"field":"text"},"output":{"answer":"text"},"prompt":"… {field} …"}],` +
  `"edges":[{"from":"box-id","to":"other-box-id"}]}. Kinds: prompt, condition (field, contains; edges when "matched"/"otherwise"). ` +
  `Every value a box reads or writes must be listed in "input" or "state". The flow must write its final answer to "answer".`;

export function draftPrompt(goal: string, fields: string[], count: number): string {
  return `Design ${count} different flows for this goal: ${goal}\nThe flow is given: ${fields.join(", ") || "nothing"}.\n${shapeNote}\n` +
    `Make them genuinely different (one box; several steps; a check before answering). Reply with JSON only: {"flows":[…]}.`;
}

/** Every flow a reply offers, as parsed JSON objects; anything unreadable yields none. */
export function readFlows(text: string): unknown[] {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { flows?: unknown };
    if (Array.isArray(parsed.flows)) return parsed.flows.slice(0, 6);
    return parsed && typeof parsed === "object" && "nodes" in parsed ? [parsed] : [];
  } catch { return []; }
}

/** A drafted flow may only ask the model and branch on what it said: no tools, lists or other flows. */
const draftKinds = new Set(["prompt", "condition"]);
const maxDraftBoxes = 8;
export function draftProblems(draft: unknown): string[] {
  const nodes = (draft as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  const problems: string[] = [];
  if (nodes.length > maxDraftBoxes) problems.push(`A drafted flow may have at most ${maxDraftBoxes} boxes; this one has ${nodes.length}.`);
  for (const node of nodes) {
    const kind = String((node as { kind?: unknown } | null)?.kind ?? "");
    if (!draftKinds.has(kind)) problems.push(`A drafted flow may only ask and branch; the "${kind}" box would use a tool or another flow, so it was not tried.`);
  }
  return problems;
}

const answerOf = (state: Record<string, unknown>): string => {
  const value = state.answer;
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
};

/** Checks one draft and tries it on every example. A draft that fails the check scores nothing. */
export async function scoreDraft(parts: FlowSearchParts, draft: unknown, examples: z.infer<typeof FlowSearchSchema>["examples"]): Promise<Scored> {
  const name = String((draft as { name?: unknown } | null)?.name ?? "unnamed").slice(0, 80);
  const refused = draftProblems(draft);
  if (refused.length) return { name, score: 0, definition: null, misses: [], problems: refused };
  let definition: FlowGraphDefinition;
  try { definition = compileGraph(draft).definition; }
  catch (error) {
    return { name, score: 0, definition: null, misses: [], problems: error instanceof FlowGraphError ? error.problems : [errorText(error)] };
  }
  let hits = 0;
  const misses: string[] = [];
  for (const example of examples) {
    try {
      const result = await parts.tryFlow(definition, example.input);
      const answer = answerOf(result.state);
      if (result.status === "completed" && answer.toLowerCase().includes(example.expect.toLowerCase())) hits++;
      else misses.push(`Given ${JSON.stringify(example.input).slice(0, 200)} it answered "${answer.slice(0, 200)}" (${result.status}); expected it to contain "${example.expect}".`);
    } catch (error) { misses.push(`Given ${JSON.stringify(example.input).slice(0, 200)} it failed: ${errorText(error)}`); }
  }
  return { name, score: hits / examples.length, definition, misses, problems: [] };
}

const best = (all: Scored[]): Scored | undefined => [...all].sort((a, b) => b.score - a.score)[0];

/** Drafts, tries, improves the best a bounded number of times, and optionally saves the winner. */
export async function searchFlows(parts: FlowSearchParts, input: FlowSearchInput) {
  const value = FlowSearchSchema.parse(input);
  const fields = [...new Set(value.examples.flatMap((e) => Object.keys(e.input)))];
  const tried: Scored[] = [];
  for (const draft of readFlows(await parts.ask(draftPrompt(value.goal, fields, value.candidates))).slice(0, value.candidates))
    tried.push(await scoreDraft(parts, draft, value.examples));
  for (let round = 0; round < value.rounds; round++) {
    const leader = best(tried.filter((t) => t.definition));
    if (!leader || leader.score === 1) break;
    const reply = await parts.ask(`This flow was tried on examples for the goal "${value.goal}":\n${JSON.stringify(leader.definition)}\n` +
      `What went wrong:\n${leader.misses.join("\n")}\n${shapeNote}\nReply with JSON only: one improved flow.`);
    const [revised] = readFlows(reply);
    if (revised) tried.push({ ...(await scoreDraft(parts, revised, value.examples)), name: `${leader.name} (improved, round ${round + 1})` });
  }
  const winner = best(tried.filter((t) => t.definition));
  const saved = value.save && winner?.definition && winner.score > 0 ? parts.save(winner.definition) : null;
  return {
    ranking: [...tried].sort((a, b) => b.score - a.score).map(({ name, score, problems, misses }) => ({ name, score, problems, misses: misses.slice(0, 3) })),
    best: winner?.definition ?? null, bestScore: winner?.score ?? 0,
    savedFlowId: saved?.id ?? null,
    note: tried.length ? "Scores are the share of examples whose answer contained what was expected." : "No draft could be read from the model's reply.",
  };
}

/** The real parts: the default model, the flow engine, and the saved flows. */
export function flowSearchParts(runtime: Runtime, flows: Flows, context?: ToolContext): FlowSearchParts {
  return {
    ask: async (prompt) => {
      const completion = await runtime.provider.complete({
        messages: [{ role: "user", content: prompt }], tools: [], maxTokens: 4000,
        signal: context?.signal ?? AbortSignal.timeout(120000),
      });
      context?.budget.charge(completion.usage ? completion.usage.input + completion.usage.output : estimateTokens(prompt + completion.content));
      return completion.content;
    },
    tryFlow: async (definition, input) => {
      const { runId, compiled } = flows.graphs.begin(definition, input, { source: "schedule" });
      const view = await flows.graphs.work(runId, compiled, { source: "schedule" });
      return { status: view.status, state: view.state };
    },
    save: (definition) => { const { id: _drop, ...rest } = definition; return flows.saveGraph(rest); },
  };
}

export function registerFlowSearch(registry: ToolRegistry, runtime: Runtime, flows: Flows): void {
  registry.register({
    name: "flow.search", group: "schedules", permission: "workflows.manage",
    description: "Draft several flows for a goal, try each on worked examples, improve the best, and report the scores.",
    // Saving is the owner's: the model's call has no "save", so a winner is only ever reported.
    parameters: FlowSearchSchema.omit({ save: true }),
    execute: async (args, context) => {
      requireInterop(runtime.store, context.owner, "flow-search");
      return searchFlows(flowSearchParts(runtime, flows, context), { ...args, save: false });
    },
  });
}

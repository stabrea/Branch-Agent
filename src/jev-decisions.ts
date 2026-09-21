import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import { FeatureModeSchema } from "./feature-switches.js";
import { runCliAgent, type CliAgentRow } from "./providers/cli-agent.js";

const safeArgument = z.string().max(500).refine((value) => !value.includes("\0"), "NUL is not permitted");
const decisionText = (maximum: number) => z.string().trim().min(1).max(maximum)
  .refine((value) => !value.startsWith("-"), "Decision text must not start with '-'");
const optionName = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const option = z.object({ name: optionName, description: z.string().trim().max(300).default("") }).strict();
const options = z.array(option).min(2).max(10).superRefine((rows, context) => {
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (seen.has(row.name)) context.addIssue({ code: "custom", path: [index, "name"], message: "Option names must be unique" });
    seen.add(row.name);
  }
});
const common = {
  question: decisionText(1000)
    .describe("A reusable criterion, not private state. JEV receives this in a local process argument."),
  state: z.string().min(1).max(100_000).describe("Only the state relevant to this decision. It is sent to the configured JEV provider."),
};

export const JevDecisionInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("yes"), ...common,
    true: decisionText(300).optional(), false: decisionText(300).optional() }).strict(),
  z.object({ kind: z.literal("pick"), ...common, options, other: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal("score"), ...common,
    labels: z.array(decisionText(80)).min(2).max(10) }).strict(),
]);
export type JevDecisionInput = z.infer<typeof JevDecisionInputSchema>;

export const JevSettingsSchema = z.object({
  mode: FeatureModeSchema.default("off"),
  command: z.string().trim().min(1).max(500).refine((value) => !/[\0\r\n]/.test(value), "Name one program"),
  args: z.array(safeArgument).max(8).default([]),
  provider: z.enum(["auto", "typesafe", "openrouter"]).default("auto"),
  model: z.string().trim().max(100).default(""),
  timeoutMs: z.number().int().min(500).max(30_000).default(5_000),
  retries: z.number().int().min(0).max(3).default(1),
  minConfidence: z.number().min(0.5).max(0.99).default(0.8),
}).strict();
export type JevSettings = z.infer<typeof JevSettingsSchema>;

const defaultSettings = (): JevSettings => JevSettingsSchema.parse({ command: "jev" });
export function jevSettings(store: Pick<Store, "get">, owner: string): JevSettings {
  const parsed = JevSettingsSchema.safeParse(store.get("settings", owner, "jev-decisions")?.data ?? {});
  return parsed.success ? parsed.data : defaultSettings();
}
export function saveJevSettings(store: Store, owner: string, input: unknown): JevSettings {
  const saved = JevSettingsSchema.parse(input ?? {});
  store.save("settings", owner, "jev-decisions", saved);
  return saved;
}

export interface JevRunOutput { code: number | null; stdout: string; stderr: string; missing?: boolean }
export type JevRunner = (
  command: string, args: string[], state: string, signal: AbortSignal,
  limits: { timeoutMs: number; maxOutputChars: number },
) => Promise<JevRunOutput>;

const runJev: JevRunner = (command, args, state, signal, limits) => {
  const row: CliAgentRow = { id: "jev", name: "JEV", command, args, jsonField: "",
    note: "Uses JEV's own configuration and sign-in." };
  return runCliAgent(row, state, signal, limits);
};

const probabilityMap = z.record(z.string(), z.number().min(0).max(1)).default({});
const envelope = z.object({
  model: z.string().min(1), id: z.string().optional(), provider: z.string().min(1),
  answer: z.record(z.string(), z.unknown()), usage: z.unknown().optional(),
}).passthrough();
const yesAnswer = z.object({ noul: z.number().min(0).max(1), yes: z.boolean().optional() }).passthrough();
const pickAnswer = z.object({ choice: z.string(), confidence: z.number().min(0).max(1).optional(),
  probabilities: probabilityMap }).passthrough();
const scoreAnswer = z.object({ score: z.number(), confidence: z.number().min(0).max(1).optional(),
  probabilities: probabilityMap, label: z.string().optional() }).passthrough();

const gateFor = (confidence: number, minimum: number): "ready" | "review" =>
  confidence >= minimum ? "ready" : "review";

function decisionArgs(input: JevDecisionInput, settings: JevSettings): string[] {
  const base = [...settings.args, input.kind, input.question];
  if (input.kind === "yes") {
    if (input.true !== undefined) base.push("--true", input.true);
    if (input.false !== undefined) base.push("--false", input.false);
  }
  if (input.kind === "pick") {
    base.push(...input.options.map((entry) => `${entry.name}=${entry.description}`));
    if (input.other) base.push("--other");
  }
  if (input.kind === "score") base.push(...input.labels);
  base.push("-s", "-", "--json", "--timeout", String(settings.timeoutMs / 1000), "--retries", String(settings.retries));
  if (settings.provider !== "auto") base.push("--provider", settings.provider);
  if (settings.model) base.push("--model", settings.model);
  return base;
}

function readEnvelope(output: JevRunOutput, kind: JevDecisionInput["kind"]): z.infer<typeof envelope> {
  if (output.missing) throw new Error("JEV is not installed at the configured command. Install it or change its command in Settings.");
  if (output.code === null) throw new Error("JEV took too long and was stopped.");
  if (output.code !== 0 && !(kind === "yes" && output.code === 1))
    throw new Error("JEV stopped with an error. Run jev auth check in your terminal, then try again.");
  try { return envelope.parse(JSON.parse(output.stdout)); }
  catch { throw new Error("Branch could not read JEV's JSON answer, so no decision was made."); }
}

export class JevDecisions {
  constructor(private readonly store: Store, private readonly owner: string, private readonly run: JevRunner = runJev) {}
  settings(): JevSettings { return jevSettings(this.store, this.owner); }
  configure(input: unknown): JevSettings { return saveJevSettings(this.store, this.owner, input); }
  target(): string {
    const provider = this.settings().provider;
    return provider === "openrouter" ? "openrouter.ai" : provider === "typesafe" ? "api.typesafe.ai" : "the JEV provider you configured";
  }
  async decide(raw: JevDecisionInput, signal: AbortSignal = new AbortController().signal): Promise<Record<string, unknown>> {
    const input = JevDecisionInputSchema.parse(raw), settings = this.settings();
    if (settings.mode === "off") throw new Error("JEV decisions are switched off. Turn them on in Settings before sending any state.");
    const output = await this.run(settings.command, decisionArgs(input, settings), input.state, signal,
      { timeoutMs: settings.timeoutMs + 1_000, maxOutputChars: 64_000 });
    const result = readEnvelope(output, input.kind);
    return this.result(input, result, settings.minConfidence);
  }
  private result(input: JevDecisionInput, result: z.infer<typeof envelope>, minimum: number): Record<string, unknown> {
    const commonResult = { model: result.model, provider: result.provider, usage: result.usage ?? null };
    if (input.kind === "yes") {
      const answer = yesAnswer.parse(result.answer), confidence = Math.max(answer.noul, 1 - answer.noul);
      return { ...commonResult, verdict: answer.noul >= 0.5 ? "yes" : "no", probability: answer.noul,
        confidence, gate: gateFor(confidence, minimum) };
    }
    if (input.kind === "pick") {
      const answer = pickAnswer.parse(result.answer);
      const offered = new Set([...input.options.map((entry) => entry.name), ...(input.other ? ["other"] : [])]);
      if (!offered.has(answer.choice)) throw new Error("JEV returned a choice that was not offered, so no decision was made.");
      const confidence = answer.confidence ?? answer.probabilities[answer.choice] ?? 0;
      return { ...commonResult, choice: answer.choice, probabilities: answer.probabilities,
        confidence, gate: gateFor(confidence, minimum) };
    }
    const answer = scoreAnswer.parse(result.answer), confidence = answer.confidence ?? 0;
    if (answer.score < 0 || answer.score > input.labels.length - 1)
      throw new Error("JEV returned a score outside the offered range, so no decision was made.");
    if (answer.label && !input.labels.includes(answer.label))
      throw new Error("JEV returned a label that was not offered, so no decision was made.");
    return { ...commonResult, score: answer.score, label: answer.label ?? "",
      probabilities: answer.probabilities, confidence, gate: gateFor(confidence, minimum) };
  }
}

export function registerJevDecisions(registry: ToolRegistry, decisions: JevDecisions): void {
  registry.register({
    name: "decisions.judge", permission: "web.read", group: "agents",
    description: "Ask the owner's optional JEV decision model one bounded yes, pick or score question. It is advisory: low confidence is returned for human or model review, never acted on by itself.",
    parameters: JevDecisionInputSchema,
    target: () => decisions.target(),
    execute: (input, context: ToolContext) => decisions.decide(input, context.signal),
  });
}

/**
 * A repeatable local stopwatch for a coding task, with no real model and no network.
 *
 * Wall time on a hosted model is roughly (number of model calls) x (round trip), so the two things
 * worth measuring here are how many times Branch goes back to the model for one task, and how much
 * of the clock is Branch's own code rather than the model or the tools. A scripted provider stands
 * in for the model: it waits a fixed time (so a round trip is a known quantity), hands back the
 * tool calls the script says, and writes down every request body it was sent.
 *
 * Nothing here talks to a provider, so it can be run as often as you like and costs nothing.
 */
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../../dist/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ms = (iso) => Date.parse(iso);

/** One scripted reply. `calls` is a list of [toolName, args]; an empty list ends the task. */
export const step = (calls, content = "") => ({ calls, content });
export const answer = (content) => ({ calls: [], content });

/**
 * A provider driven by a script. Each request waits `latencyMs` (the pretend round trip), then
 * returns the next step. Every request is kept, so the part that repeats round to round — the
 * instructions and the tool list — can be compared for whether a provider could cache it.
 */
export function scriptedProvider(steps, latencyMs) {
  let at = 0;
  const provider = {
    name: "scripted",
    requests: [],
    modelMs: 0,
    async complete(request) {
      const started = process.hrtime.bigint();
      const step = steps[Math.min(at, steps.length - 1)];
      at++;
      provider.requests.push({
        tools: JSON.stringify(request.tools),
        toolNames: request.tools.map((tool) => tool.name),
        system: request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"),
        messages: request.messages.length,
      });
      if (latencyMs) await sleep(latencyMs);
      provider.modelMs += Number(process.hrtime.bigint() - started) / 1e6;
      return {
        content: step.content,
        toolCalls: step.calls.map(([name, args], n) => ({ id: `c${at}_${n}`, name, arguments: JSON.stringify(args) })),
      };
    },
  };
  return provider;
}

/** A small project to work in, so the file tools have something real to read and change. */
export async function seedWorkspace(workspace) {
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "range.js"), "export function range(start, end) {\n  const out = [];\n  for (let n = start; n < end; n += 1) out.push(n);\n  return out;\n}\n");
  await writeFile(join(workspace, "src", "sum.js"), "export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n");
  await writeFile(join(workspace, "src", "mean.js"), "import { sum } from './sum.js';\nexport const mean = (xs) => sum(xs) / xs.length;\n");
  await writeFile(join(workspace, "README.md"), "# demo\n\nA tiny project.\n");
}

/**
 * Runs one scripted task and returns where its time went. `overheadMs` is the clock that belongs
 * to neither the model nor a tool: catalog building, the policy checks, store writes, fitting the
 * context, the journal — everything Branch does between one thing finishing and the next starting.
 */
export async function measure({ steps, prompt, latencyMs = 200, options = {}, seed = seedWorkspace }) {
  const root = await mkdtemp(join(tmpdir(), "branch-speed-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await seed(workspace);
  const provider = scriptedProvider(steps, latencyMs);
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider, ...options });
  try {
    const started = process.hrtime.bigint();
    const run = await app.runtime.run({ prompt });
    const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
    const spans = app.store.spans.forRun(run.id);
    const spent = (kind) => spans.filter((s) => s.kind === kind && s.endedAt)
      .reduce((total, s) => total + Math.max(0, ms(s.endedAt) - ms(s.startedAt)), 0);
    const modelSpanMs = spent("model");
    const toolMs = spent("tool");
    return {
      status: run.status,
      output: run.output,
      modelCalls: provider.requests.length,
      toolCalls: spans.filter((s) => s.kind === "tool").length,
      wallMs, modelSpanMs, toolMs,
      modelWaitMs: provider.modelMs,
      overheadMs: Math.max(0, wallMs - modelSpanMs - toolMs),
      latencyMs,
      prefix: prefixStability(provider.requests),
      requests: provider.requests,
    };
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * How much of what repeats every round really does repeat. A provider's prompt cache only serves a
 * request whose first bytes are exactly what it saw before, so a tool list that shuffles or a line
 * of instructions that changes throws the whole saving away.
 */
export function prefixStability(requests) {
  let sameTools = 0, sameSystem = 0;
  for (let at = 1; at < requests.length; at++) {
    if (requests[at].tools === requests[at - 1].tools) sameTools++;
    if (requests[at].system === requests[at - 1].system) sameSystem++;
  }
  const rounds = Math.max(0, requests.length - 1);
  return {
    rounds,
    toolsUnchanged: sameTools,
    systemUnchanged: sameSystem,
    toolsHitRate: rounds ? sameTools / rounds : 1,
    systemHitRate: rounds ? sameSystem / rounds : 1,
  };
}

/** One line a person can read, for the status file and the console. */
export function line(name, result) {
  const share = (value) => `${((value / result.wallMs) * 100).toFixed(0)}%`;
  return `${name}: ${result.modelCalls} model calls, ${result.toolCalls} tool calls, `
    + `${result.wallMs.toFixed(0)} ms wall = ${result.modelSpanMs.toFixed(0)} ms model (${share(result.modelSpanMs)}) `
    + `+ ${result.toolMs.toFixed(0)} ms tools (${share(result.toolMs)}) `
    + `+ ${result.overheadMs.toFixed(0)} ms Branch (${share(result.overheadMs)}); `
    + `tool list unchanged in ${result.prefix.toolsUnchanged}/${result.prefix.rounds} later rounds, `
    + `instructions unchanged in ${result.prefix.systemUnchanged}/${result.prefix.rounds}`;
}

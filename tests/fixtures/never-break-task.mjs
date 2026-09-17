/**
 * A whole Branch in a process of its own, working through a scripted plan of tool calls, so a test
 * can kill it at any moment and start it again on the same folder. Refuses to run outside a
 * temporary folder. No network, no real model, no window.
 *
 *   node never-break-task.mjs <root> work      works through CHAOS_PLAN, one tool call a round
 *   node never-break-task.mjs <root> recover   opens the same folder, settles what was cut off, prints JSON
 *
 * CHAOS_PLAN is a JSON list of { id, tool, args }. Tools: chaos.look (only looks), chaos.send
 * (reaches "outside": appends to outbox.log), and the real files.write.
 */
import { appendFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createBranch } from "../../dist/index.js";

const [root, phase] = process.argv.slice(2);
if (!realpathSync(resolve(root)).startsWith(realpathSync(tmpdir()))) { console.error("refusing: not a temporary folder"); process.exit(9); }
const plan = JSON.parse(process.env.CHAOS_PLAN ?? "[]");
const pause = phase === "work" ? Number(process.env.CHAOS_DELAY ?? 20) : 0;
const log = (file, line) => appendFileSync(join(root, file), `${line}\n`);

/** The next step is the first one the conversation holds no settled result for. */
function nextCall(messages) {
  const settled = new Set(messages.filter((m) => m.role === "tool" && !/"status":"not-done"/.test(m.content)).map((m) => m.toolCallId));
  const asked = messages.filter((m) => m.role === "assistant").flatMap((m) => m.toolCalls ?? []).map((c) => c.id);
  for (const step of plan) {
    const ids = asked.filter((id) => id === step.id || id.startsWith(`${step.id}~`));
    if (ids.some((id) => settled.has(id))) continue;
    const id = ids.length ? `${step.id}~${ids.length}` : step.id;
    return { id, name: step.tool, arguments: JSON.stringify(step.args ?? {}) };
  }
  return null;
}
const provider = { name: "scripted", async complete(request) {
  const call = nextCall(request.messages);
  return call ? { content: "", toolCalls: [call] } : { content: "all done", toolCalls: [] };
} };

const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
app.registry.register({ name: "chaos.look", permission: "files.read", description: "Look at something.",
  parameters: z.object({ n: z.number() }).strict(),
  execute: async ({ n }) => { log("calls.log", `look ${n}`); await delay(pause); return { seen: n }; } });
app.registry.register({ name: "chaos.send", permission: "chaos.send", description: "Send something to somebody.",
  parameters: z.object({ n: z.number() }).strict(),
  execute: async ({ n }) => { log("calls.log", `send ${n}`); await delay(pause); log("outbox.log", `sent ${n}`); await delay(pause); return { sent: n }; } });

if (phase === "work") {
  if (process.env.CHAOS_FAIL_JOURNAL === "1") app.runtime.journal = { turn: () => undefined, around: () => { throw new Error("Branch could not write this step down (ENOSPC)"); } };
  const run = await app.runtime.run({ prompt: "work through the plan", onTextDelta: () => undefined, onStarted: (r) => log("calls.log", `run ${r.id}`) });
  console.log(JSON.stringify({ status: run.status, output: run.output }));
  await app.close();
} else {
  const report = await app.neverBreak.recoverOnStart(join(root, "data"));
  await Promise.all(report.map((r) => r.resumed));
  const runs = app.store.runs("local").map((r) => ({ id: r.id, status: r.status, output: r.output }));
  const steps = Object.fromEntries(report.map((r) => [r.runId, app.neverBreak.journal.steps(r.runId)]));
  console.log(JSON.stringify({ report: report.map(({ resumed, ...rest }) => rest), runs, steps }));
  await app.close();
}

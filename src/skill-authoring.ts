import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Runtime } from "./runtime.js";

/**
 * Help with writing skills. The first part reads several tasks that went well and proposes one
 * improved set of instructions from all of them, saved as a new version that is not switched on.
 * The second part takes the examples the skill lists under an "## Examples" heading, runs each one
 * with the skill in place, and reports what happened, so a change can be judged before it is used.
 */
export const DraftFromRunsSchema = z.object({
  skillId: z.string().uuid(),
  /** Two or more finished tasks where this skill was used and the result was good. */
  runIds: z.array(z.string().uuid()).min(2).max(6),
}).strict();
export const SkillTestSchema = z.object({
  version: z.number().int().min(1).max(20).optional(),
  /** Overrides the examples in the document; each one is run as a task with the skill in place. */
  examples: z.array(z.string().trim().min(1).max(500)).max(6).optional(),
}).strict();

/** The example tasks a skill lists under an "## Examples" heading, one per bullet. */
export function skillExamples(document: string): string[] {
  const lines = document.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{2,}\s*Examples?\s*$/i.test(line));
  if (start < 0) return [];
  const examples: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{2,}\s/.test(line)) break;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)?.[1]?.trim();
    if (bullet && bullet.length > 3) examples.push(bullet);
  }
  return examples.slice(0, 6);
}

function transcriptOf(store: Store, owner: string, runId: string): string {
  const run = store.run(runId);
  if (!run || run.owner !== owner) throw new Error(`Task ${runId} was not found`);
  return store.messages(run.sessionId).filter((message) => message.role !== "system")
    .map((message) => `${message.role}: ${message.content.slice(0, 600)}`).join("\n").slice(0, 4000);
}

/** Proposes one improved version of a skill from several tasks that went well; the version in use does not change. */
export async function draftFromRuns(store: Store, owner: string, runtime: Runtime, input: unknown) {
  const spec = DraftFromRunsSchema.parse(input);
  const skill = store.skills.view(owner, spec.skillId);
  const examples = spec.runIds.map((runId, index) => `Task ${index + 1} (${runId}):\n${transcriptOf(store, owner, runId)}`).join("\n\n");
  const parent = await runtime.run({ prompt: `Draft an improved version of skill "${skill.name}" from ${spec.runIds.length} tasks` });
  const child = await runtime.delegate(
    `Current SKILL.md:\n${skill.document}\n\nTasks where this skill was used and things went well:\n${examples}\n\n` +
    "Write one improved SKILL.md covering what all of these tasks needed. Keep the same name line. Reply with the full document only, starting with ---.",
    runtime.context({ runId: parent.id }), [], "You improve skill documents from real task traces. Output only the document.", { timeoutMs: 120000 });
  if (child.status !== "completed") throw new Error(`The draft could not be produced (${child.status})`);
  const document = child.output.replace(/^```[a-z]*\n?|```$/g, "").trim();
  const updated = store.skills.update(owner, spec.skillId, { document, expectedRevision: skill.revision });
  store.save("settings", owner, `skill-candidate:${spec.skillId}:${updated.headVersion}`, { fromRunIds: spec.runIds, draftRunId: child.id, createdAt: new Date().toISOString() });
  store.event(parent.id, "skill.candidate_drafted", { skillId: spec.skillId, version: updated.headVersion, fromRunIds: spec.runIds, activeVersion: updated.activeVersion });
  return { skill: updated, candidateVersion: updated.headVersion, originalVersion: skill.headVersion, fromRunIds: spec.runIds };
}

/** Runs a skill's own examples with that skill in place and reports how each one went. */
export async function testSkill(store: Store, owner: string, runtime: Runtime, skillId: string, input: unknown) {
  const spec = SkillTestSchema.parse(input);
  const skill = store.skills.view(owner, skillId);
  const version = spec.version ?? skill.activeVersion ?? skill.headVersion;
  const document = store.skills.read(owner, skillId, { version }).document;
  const examples = spec.examples ?? skillExamples(document);
  if (!examples.length) throw new Error('This skill lists no examples. Add an "## Examples" heading with one task per bullet, or send examples with the request.');
  const parent = await runtime.run({ prompt: `Test skill "${skill.name}" v${version} on ${examples.length} example(s)` });
  const context = runtime.context({ runId: parent.id });
  const results: { example: number; prompt: string; runId: string; status: string; passed: boolean; output: string; ms: number }[] = [];
  for (const [index, example] of examples.entries()) {
    const started = Date.now();
    const run = await runtime.delegate(example, context, [...context.permissions].filter((p) => !["shell.execute", "remote.execute", "git.remote", "github.manage"].includes(p)),
      `Skill under test (v${version}):\n${document}`, { timeoutMs: 120000 });
    results.push({ example: index, prompt: example, runId: run.id, status: run.status, passed: run.status === "completed", output: run.output.slice(0, 600), ms: Date.now() - started });
  }
  const report = { id: randomUUID(), skillId, name: skill.name, version, parentRunId: parent.id, results,
    summary: { passed: results.filter((result) => result.passed).length, total: results.length }, createdAt: new Date().toISOString() };
  store.save("governance", owner, `skill-test:${report.id}`, report);
  store.event(parent.id, "skill.tested", { skillId, version, summary: report.summary });
  return report;
}

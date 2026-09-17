import { z } from "zod";
import type { Store } from "../store.js";
import type { LearningLoop } from "./loop.js";

/**
 * The window's side of the learning loop, under /api/reflection. Answers `undefined` for a path it
 * does not know, so the server can carry on looking.
 */
export const skipNewSkillTrial = "I have not tried this skill and I want it anyway";
const SkillBody = z.object({ skillId: z.string().uuid(), force: z.boolean().optional(), confirm: z.string().max(200).optional() }).strict();
const LookBody = z.object({ sessionId: z.string().min(1).max(200).optional() }).strict();
const LearnBody = z.object({ sessionId: z.string().min(1).max(200), notes: z.string().trim().max(2000).optional() }).strict();
const Empty = z.object({}).strict();

export async function reflectionApi(loop: LearningLoop, store: Store, method: string, path: string, body: () => Promise<unknown>): Promise<unknown> {
  if (!path.startsWith("/api/reflection")) return undefined;
  if (method === "GET" && path === "/api/reflection") return overview(loop);
  if (method !== "POST") return undefined;
  if (path === "/api/reflection/settings") return loop.configure(await body());
  if (path === "/api/reflection/look-back") return { batch: await loop.lookBackNow(LookBody.parse(await body()).sessionId) };
  if (path === "/api/reflection/learn") { const input = LearnBody.parse(await body()); return loop.learn({ sessionId: input.sessionId, notes: input.notes ?? "" }); }
  if (path === "/api/reflection/retire") { Empty.parse(await body()); return loop.offerRetirements(); }
  const batch = /^\/api\/reflection\/batches\/([a-f0-9-]{36})\/(accept|reject)$/.exec(path);
  if (batch) { Empty.parse(await body()); return loop.decideBatch(batch[1]!, batch[2] === "accept"); }
  const skill = /^\/api\/reflection\/new-skills\/(try|accept|reject)$/.exec(path);
  if (skill) return newSkillAction(loop, store, skill[1]!, SkillBody.parse(await body()));
  return undefined;
}

function overview(loop: LearningLoop) {
  return { settings: loop.settings(), batches: loop.batches(), newSkills: loop.newSkills(),
    jobs: loop.jobs.recent(), working: loop.jobs.running };
}

async function newSkillAction(loop: LearningLoop, store: Store, action: string, input: z.infer<typeof SkillBody>): Promise<unknown> {
  if (action === "try") return loop.drafts.tryOut(input.skillId);
  if (action === "reject") return loop.drafts.reject(input.skillId);
  if (!input.force) return loop.drafts.accept(input.skillId);
  store.profiles.requireOwner("Switching on a new skill without trying it");
  if (input.confirm !== skipNewSkillTrial)
    throw new Error(`To switch this on without trying it, confirm it in the app. It is refused until the words "${skipNewSkillTrial}" come with the request.`);
  return loop.drafts.accept(input.skillId, { force: true });
}

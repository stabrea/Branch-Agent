/**
 * Q61: a whole Branch in a process of its own that claims a team task and then hangs mid-turn, so a
 * test can SIGKILL it with the claim held. Refuses to run outside a temporary folder. No network,
 * no real model. Prints one JSON line ({ teamId, requestId, taskId }) once the claim is written.
 *
 *   node team-claim-crash.mjs <root>
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createBranch } from "../../dist/index.js";

const [root] = process.argv.slice(2);
if (!realpathSync(resolve(root)).startsWith(realpathSync(tmpdir()))) { console.error("refusing: not a temporary folder"); process.exit(9); }
const inert = { name: "inert", async complete() { return { content: "ok", toolCalls: [] }; } };
const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: inert });
const owner = app.runtime.owner;
const specialistId = randomUUID();
app.store.save("specialists", owner, specialistId, { id: specialistId, name: "planner" });
const team = app.teams.save({ name: "Crew", members: [{ specialistId, role: "planner", brief: "" }] });
const requestId = randomUUID();
// The parent run is created and linked, then the turn never ends: the process is killed while it holds the claim.
const hanging = { run: (options) => { const run = app.store.createRun(owner, "team parent"); options.onStarted(run); return new Promise(() => {}); } };
void app.teams.run(hanging, { activeSpecialist: () => ({}) }, team.id, "hang here", { requestId });
await new Promise((done) => setImmediate(done));
const { task_id: taskId } = app.store.sqlite.prepare("SELECT task_id FROM team_tasks WHERE request_id=?").get(requestId);
process.stdout.write(`${JSON.stringify({ teamId: team.id, requestId, taskId })}\n`);
setInterval(() => {}, 1000);

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const root = await mkdtemp(join(tmpdir(), "branch-debug-"));
const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
const call = (path) => fetch(new URL(path, server.url), {
  method: "GET", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
}).then((response) => response.json());

const owner = app.runtime.owner;
const working = app.store.createRun(owner, "Summarise the notes");
app.store.event(working.id, "tool.started", { name: "files.read", id: "t2", label: "Reading notes.md" });
const sessionId = working.sessionId;

console.log("Created working task:", { runId: working.id.slice(0, 4), sessionId: sessionId.slice(0, 4) });

const q1 = app.runtime.followUp(sessionId, "First queued message");
console.log("Q1 result:", q1);

const q2 = app.runtime.followUp(sessionId, "Second queued message");
console.log("Q2 result:", q2);

const activity = await call("/api/activity?waiting=1");
console.log("Activity count:", activity.length);
console.log("Activity states:", activity.map((a) => ({ runId: a.runId.slice(0, 4), state: a.task?.state, prompt: a.prompt.slice(0, 30) })));

const queued = activity.filter((one) => one.task?.state === "queued");
console.log("Queued count:", queued.length);
console.log("Queued tasks:", queued.map((q) => ({ position: q.task?.position, prompt: q.prompt })));

await server.close();
await app.close();

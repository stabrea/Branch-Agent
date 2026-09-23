#!/usr/bin/env node
/**
 * A tiny stand-in for the real gateway a packaged portable binary boots, used only by
 * tests/portable-operations.test.mjs to prove the launch/measurement logic in
 * src/operations/portable-launch.ts against a process that this host will actually let run (see
 * that test for why the real packaged binary cannot be executed here).
 *
 * It speaks the same readiness contract as the real program (running.json + session-token, written
 * by src/install/running.ts) and answers POST /api/run the same shape the real one does.
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dataDir = process.env.BRANCH_DATA_DIR;
if (!dataDir) throw new Error("BRANCH_DATA_DIR is required");
await mkdir(dataDir, { recursive: true });

// A real, non-zero delay before "ready" so cold start measures something.
await new Promise((resolve) => { setTimeout(resolve, 200); });

const server = createServer((request, response) => {
  if (request.method === "POST" && request.url === "/api/run") {
    // Burns real CPU briefly so the task-memory/CPU sample differs from the idle one.
    const until = Date.now() + 150;
    let sum = 0;
    while (Date.now() < until) sum += Math.sqrt(sum + 1);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "completed", output: `ok ${sum.toFixed(0)}` }));
    return;
  }
  response.writeHead(404).end();
});

await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
const { port } = server.address();

await writeFile(join(dataDir, "session-token"), "a".repeat(64), "utf8");
await writeFile(
  join(dataDir, "running.json"),
  JSON.stringify({
    port, pid: process.pid, url: `http://127.0.0.1:${port}`, mode: "daemon",
    version: "0.0.0-test", startedAt: new Date().toISOString(),
  }),
  "utf8",
);

const stop = () => { server.close(() => process.exit(0)); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

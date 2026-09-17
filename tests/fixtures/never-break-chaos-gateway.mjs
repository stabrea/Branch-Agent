/**
 * A gateway in a process of its own whose engine is the scripted task (never-break-task.mjs in
 * gateway mode), so a test can kill the gateway in the middle of a task and start it again.
 */
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { Gateway } from "../../dist/never-break/gateway.js";

const root = process.argv[2];
if (!realpathSync(resolve(root)).startsWith(realpathSync(tmpdir()))) process.exit(9);
const gateway = new Gateway({
  dataDir: join(root, "data"), script: resolve("tests/fixtures/never-break-task.mjs"), args: [root, "gateway"],
  port: 0, version: "chaos",
  onWorker: (event) => { if (event.kind === "ready") console.log(JSON.stringify({ worker: event.ready.pid })); },
});
await gateway.start();
process.once("SIGTERM", () => { void gateway.stop().finally(() => process.exit(0)); });

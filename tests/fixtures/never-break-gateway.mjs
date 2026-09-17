/**
 * A gateway in a process of its own, running the stand-in engine, so a test can kill the gateway
 * itself and check what happens to the engine. Prints one JSON line when the engine is ready.
 */
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { Gateway } from "../../dist/never-break/gateway.js";

const dataDir = process.argv[2];
if (!realpathSync(resolve(dataDir)).startsWith(realpathSync(tmpdir()))) process.exit(9);
const gateway = new Gateway({
  dataDir, script: resolve("tests/fixtures/never-break-worker.mjs"), args: [], port: 0, version: "test",
  onWorker: (event) => { if (event.kind === "ready") console.log(JSON.stringify({ url: gateway.url, worker: event.ready.pid })); },
});
await gateway.start();
process.once("SIGTERM", () => { void gateway.stop().finally(() => process.exit(0)); });

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";

/**
 * The Python client in packages/sdk-python, proved two ways: its own unittest suite against a fake
 * server, and a short script driving a real Branch Agent over the network, so the routes the Python
 * client calls are the routes the app really answers. Both need a Python 3.9 or later on the
 * computer; where there is none, the tests say so and are skipped rather than failing.
 */
const run = promisify(execFile);
const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "sdk-python");

async function findPython() {
  const candidates = process.platform === "win32" ? [["python"], ["py", "-3"], ["python3"]] : [["python3"], ["python"]];
  for (const [command, ...prefix] of candidates) {
    try {
      const { stdout } = await run(command, [...prefix, "-c", "import sys; print(sys.version_info >= (3, 9))"], { timeout: 15000 });
      if (stdout.trim() === "True") return { command, prefix };
    } catch { /* not this one */ }
  }
  return null;
}
const python = await findPython();
const skip = python ? false : "no Python 3.9+ on this computer";

const say = (content) => () => ({ content, toolCalls: [] });
function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
  } };
  return provider;
}

test("the Python client's own tests pass", { skip }, async () => {
  const { stdout, stderr } = await run(python.command, [...python.prefix, "-m", "unittest", "discover", "-s", join(packageDir, "tests")], { timeout: 120000 });
  assert.match(`${stdout}${stderr}`, /\nOK\b/);
});

const drive = `
import json, os, sys
sys.path.insert(0, os.environ["BRANCH_SDK_DIR"])
from branch_agent import BranchClient, BranchError, from_data_dir
branch = from_data_dir(os.environ["BRANCH_DATA_DIR"], port=int(os.environ["BRANCH_PORT"]))
out = {}
started = branch.runs.start("Summarise the meeting notes")
out["kinds"] = [event["kind"] for event in branch.runs.stream(started["id"])]
out["output"] = branch.runs.get(started["id"])["run"]["output"]
branch.documents.add("Notes", "The Northgate invoice is due on Friday.")
out["found"] = len(branch.search("Northgate invoice")["passages"])
out["memory"] = len(branch.memory.search("Northgate")["results"])
out["categories"] = [row["id"] for row in branch.policy.categories()["categories"]]
branch.policy.save(preset="read-only")
out["audited"] = [entry["action"] for entry in branch.audit(action="policy.changed")["entries"]]
out["described"] = sorted(branch.get("/api/openapi.json")["paths"])
try:
    branch.runs.get("00000000-0000-0000-0000-000000000000")
except BranchError as error:
    out["refused"] = [error.status, error.message]
try:
    BranchClient(branch.url, "0" * 64).state()
except BranchError as error:
    out["wrongKey"] = error.status
print(json.dumps(out))
`;

test("the Python client drives a real Branch Agent: start, stream, read, search, approvals, refusals", { skip }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-sdk-python-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted([say("Three lines about the meeting.")]) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  app.store.save("memory", "local", "fact-1", { text: "Northgate pays on Fridays" });
  const script = join(root, "drive.py");
  await writeFile(script, drive);

  // The key is read from the data folder by the client itself, never passed on a command line.
  const env = { ...process.env, BRANCH_SDK_DIR: packageDir, BRANCH_DATA_DIR: join(root, "data"), BRANCH_PORT: new URL(server.url).port };
  const { stdout } = await run(python.command, [...python.prefix, script], { env, timeout: 120000 });
  const out = JSON.parse(stdout.trim().split("\n").at(-1));

  assert.equal(out.kinds.at(-1), "end", "the stream says when the task is over");
  assert.equal(out.output, "Three lines about the meeting.");
  assert.ok(out.found >= 1, "documents are found through the Python client");
  assert.ok(out.memory >= 1, "saved notes are found through the Python client");
  assert.ok(out.categories.includes("commands"));
  assert.ok(out.audited.includes("policy.changed"), "a change made from Python is in the record");
  for (const path of ["/api/run", "/api/runs/{runId}", "/api/memory/search", "/api/state", "/api/tools", "/api/policy"])
    assert.ok(out.described.includes(path), `${path}, which the Python client calls, is in the OpenAPI description`);
  assert.equal(out.refused[0], 404);
  assert.match(out.refused[1], /not found/i);
  assert.equal(out.wrongKey, 401);
});

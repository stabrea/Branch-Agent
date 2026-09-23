/**
 * FQ-operations.hibernation (owner-facing surface): `branch hibernation` on the command line, and
 * the `GET /api/hibernation/operations` list any other client can fetch the same way. Both read the
 * same `<dataDir>/hibernation/` store as tests/hibernation.test.mjs's HTTP routes; nothing here
 * touches a real cloud provider. Everything runs from a temporary data folder.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discardTemp } from "./temp-dir.mjs";
import { cliCommands } from "../dist/cli-completion.js";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const run = promisify(execFile);

async function branchCli(root, args) {
  const env = {
    ...process.env, BRANCH_PROVIDER: "demo",
    BRANCH_WORKSPACE: join(root, "workspace"), BRANCH_DATA_DIR: join(root, "data"),
  };
  return run(process.execPath, ["dist/cli.js", ...args], { env });
}

test("HC1 `branch hibernation` is a known command with its own help", (t) => {
  const entry = cliCommands.find((command) => command.name === "hibernation");
  assert.ok(entry, "hibernation is not registered in cliCommands");
  assert.ok(entry.options.includes("--json"));
});

test("HC2 `branch hibernation list` says there is nothing yet, before any operation exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-hibernation-cli-"));
  t.after(() => discardTemp(root));
  const { stdout } = await branchCli(root, ["hibernation", "list"]);
  assert.match(stdout, /No hibernation operations yet/);
});

test("HC3 start, advance, suspend and resume an operation entirely from the command line", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-hibernation-cli-"));
  t.after(() => discardTemp(root));

  const started = await branchCli(root, ["hibernation", "start", "--json", "write the brief", "write the draft"]);
  const record = JSON.parse(started.stdout);
  assert.equal(record.status, "running");
  assert.equal(record.steps.length, 2);

  const afterOne = JSON.parse((await branchCli(root, ["hibernation", "advance", record.id, "--json"])).stdout);
  assert.equal(afterOne.step, 1);

  const listed = JSON.parse((await branchCli(root, ["hibernation", "list", "--json"])).stdout);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, record.id);

  const suspended = JSON.parse((await branchCli(root, ["hibernation", "suspend", record.id, "--json"])).stdout);
  assert.equal(suspended.status, "suspended");
  assert.equal(Object.keys(suspended.hashes).length, 1);

  const resumed = await branchCli(root, ["hibernation", "resume", record.id]);
  assert.match(resumed.stdout, /came back exactly as it was/);

  const shown = JSON.parse((await branchCli(root, ["hibernation", "show", record.id, "--json"])).stdout);
  assert.equal(shown.status, "running");
  assert.equal(shown.step, 1, "resume continued from the saved step, not from the start");
});

test("HC4 `branch hibernation resume` reports a changed workspace in plain words, not just JSON", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-hibernation-cli-"));
  t.after(() => discardTemp(root));
  const record = JSON.parse((await branchCli(root, ["hibernation", "start", "--json", "one step", "another step"])).stdout);
  await branchCli(root, ["hibernation", "advance", record.id]);
  await branchCli(root, ["hibernation", "suspend", record.id]);
  const { writeFile } = await import("node:fs/promises");
  const filePath = join(root, "data", "hibernation", record.id, "workspace", "step-0.txt");
  await writeFile(filePath, "tampered", "utf8");
  const resumed = await branchCli(root, ["hibernation", "resume", record.id]);
  assert.match(resumed.stdout, /workspace changed since it was suspended: step-0\.txt/);
});

test("HC5 `branch hibernation settings` reads and renames the configured environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-hibernation-cli-"));
  t.after(() => discardTemp(root));
  const before = await branchCli(root, ["hibernation", "settings"]);
  assert.match(before.stdout, /Serverless environment: local/);
  const after = await branchCli(root, ["hibernation", "settings", "test-cloud"]);
  assert.match(after.stdout, /Serverless environment: test-cloud/);
  const read = await branchCli(root, ["hibernation", "settings", "--json"]);
  assert.deepEqual(JSON.parse(read.stdout), { environment: "test-cloud" });
});

test("HC6 an unknown operation id fails with a plain message, not a crash", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-hibernation-cli-"));
  t.after(() => discardTemp(root));
  await assert.rejects(branchCli(root, ["hibernation", "suspend", "not-a-real-id"]), /No operation by the id/);
});

test("HC7 GET /api/hibernation/operations lists every operation, for any client", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-hibernation-api-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider: { name: "scripted", complete: async () => ({ content: "ok", toolCalls: [] }) } });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/hibernation${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error);
    return json;
  };
  assert.deepEqual(await call("/operations", undefined), []);
  const started = await call("/start", { steps: ["a step"] });
  const listed = await call("/operations", undefined);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, started.id);
});

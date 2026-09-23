import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  agentContainerRoot, agentContainerSlice, agentFolderName,
} from "../dist/sandbox-agent-containers.js";
import {
  ContainerBackend, defaultSandboxProbe, defaultSandboxSpawn, SandboxBackendSettingsSchema,
} from "../dist/sandbox-backends.js";

/**
 * FQ-security.containers: a container run used to be scoped only by an approval rule's folder list,
 * never by who was asking — two Trunks running the same allowed rule got the same folder. These
 * check the per-agent folder itself (no container needed), then run a real one to prove what it
 * buys: a container started for one agent cannot reach another agent's folder, or anything of the
 * host outside its own.
 */

test("an agent id becomes a plain, safe folder name", () => {
  assert.equal(agentFolderName("trunk:9c1e"), "trunk_9c1e");
  assert.equal(agentFolderName("mode:research"), "mode_research");
  // Every "/" a path separator could read is gone, and a name starting with "." cannot hide as a
  // dotfile or, once turned into a folder name, ever be mistaken for "go up a folder" on its own.
  const traversal = agentFolderName("../../etc/passwd");
  assert.ok(!traversal.includes("/") && !traversal.startsWith("."), traversal);
  assert.equal(agentFolderName(".hidden"), "_hidden");
  assert.equal(agentFolderName(""), "agent");
});

test("with no agent, the slice is the plain workspace slice — containers keep working exactly as before", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-agent-containers-"));
  t.after(() => discardTemp(root));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  const slice = await agentContainerSlice(workspace, undefined, []);
  assert.equal(slice.hostPath, workspace);
});

test("two agents in the same workspace get two separate, made folders, and cannot see one another's files by listing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-agent-containers-"));
  t.after(() => discardTemp(root));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  const sliceA = await agentContainerSlice(workspace, "trunk:alpha", []);
  const sliceB = await agentContainerSlice(workspace, "trunk:beta", []);
  assert.notEqual(sliceA.hostPath, sliceB.hostPath);
  assert.equal(sliceA.hostPath, agentContainerRoot(workspace, "trunk:alpha"));
  assert.ok(sliceA.hostPath.startsWith(workspace));

  await writeFile(join(sliceA.hostPath, "marker.txt"), "alpha's own file", "utf8");
  assert.deepEqual(await readdir(sliceB.hostPath), [], "beta's own folder starts empty even though alpha wrote into its own");
});

test("a rule's folder list still narrows inside the agent's own folder, and still refuses to leave it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-agent-containers-"));
  t.after(() => discardTemp(root));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  const narrowed = await agentContainerSlice(workspace, "trunk:alpha", ["reports"]);
  assert.equal(narrowed.hostPath, join(agentContainerRoot(workspace, "trunk:alpha"), "reports"));

  await assert.rejects(agentContainerSlice(workspace, "trunk:alpha", ["../escape"]),
    /outside your workspace|given relative to your workspace/);
});

// ------------------------------------------------------------------ a real container

async function containerEngine(probe) {
  for (const engine of ["docker", "podman"]) {
    const answer = await probe(engine, ["version", "--format", "{{.Client.Version}}"]);
    if (!answer.missing && answer.code === 0) return engine;
  }
  return null;
}
async function imagePulled(probe, engine, image) {
  const answer = await probe(engine, ["image", "inspect", image]);
  return !answer.missing && answer.code === 0;
}

test("FQ-security.containers: a real container started for one agent cannot reach another agent's folder or a host file outside its own", async (t) => {
  const probe = defaultSandboxProbe();
  const engine = await containerEngine(probe);
  if (!engine) return t.skip("Docker or Podman is not on this computer");
  const image = "node:22-alpine";
  if (!(await imagePulled(probe, engine, image))) return t.skip(`the "${image}" image is not already on this computer — Branch never pulls one`);

  const root = await mkdtemp(join(tmpdir(), "branch-agent-containers-real-"));
  t.after(() => discardTemp(root));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  // Something on the host, outside every agent's own folder — the container's own filesystem is
  // read-only and nothing but the one agent folder is ever bound into it, so this should never
  // become readable from inside no matter how the run tries to reach it.
  await writeFile(join(workspace, "host-secret.txt"), "only the host should ever read this", "utf8");

  const sliceA = await agentContainerSlice(workspace, "trunk:alpha", []);
  await writeFile(join(sliceA.hostPath, "marker.txt"), "alpha's own file", "utf8");
  const sliceB = await agentContainerSlice(workspace, "trunk:beta", []);
  await writeFile(join(sliceB.hostPath, "own.txt"), "beta's own file", "utf8");

  const settings = SandboxBackendSettingsSchema.parse({ image });
  const backend = new ContainerBackend(settings, probe, defaultSandboxSpawn());
  const handle = await backend.prepare(sliceB);
  t.after(() => handle.dispose());

  const alphaFolder = agentFolderName("trunk:alpha");
  // Run entirely inside the real container: read its own file (must work), then try the other
  // agent's folder and the host file by every route a script could try — a relative escape from
  // /work, and the absolute host-rooted name. None of it is bound into this container at all.
  const script = [
    "const fs = require('fs');",
    "const out = {};",
    "out.ownFile = fs.readFileSync('/work/own.txt', 'utf8');",
    "const attempts = [",
    `  '/work/../${alphaFolder}/marker.txt',`,
    "  '/work/../../host-secret.txt',",
    "  '/host-secret.txt',",
    "];",
    "out.reached = attempts.filter((p) => { try { fs.readFileSync(p, 'utf8'); return true; } catch { return false; } });",
    "console.log(JSON.stringify(out));",
  ].join("\n");

  const limits = { timeoutMs: 30000, maxMemoryMb: 128, maxCpuSeconds: 15, maxOutputBytes: 8192, network: false, job: false };
  const result = await handle.run({ executable: "node", args: ["-e", script] }, limits, AbortSignal.timeout(35000));

  assert.equal(result.status, "completed", result.stderr);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.backend, "docker");
  const out = JSON.parse(result.stdout.trim());
  assert.equal(out.ownFile, "beta's own file", "the container could read its own agent's file");
  assert.deepEqual(out.reached, [], "neither the other agent's folder nor the host file outside it was reachable");
});

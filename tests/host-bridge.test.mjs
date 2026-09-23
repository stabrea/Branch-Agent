import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";

/**
 * FQ-execution.host-bridge: the owner names a computer explicitly and gets back which computer
 * answered, right alongside what it said. `RemoteWorkspaces.execute` (src/remote/ssh-workspace.ts)
 * already carries that identity through the tool call; this proves the same thing happens through
 * the Settings screen's own door (`src/host-bridge-api.ts`, `public/host-bridge.js`), and that a
 * reply really is the one from the computer that was asked, not whichever was configured first.
 *
 * No SSH connection is ever made: `RemoteWorkspaces` takes an `SshRun` it calls instead, and the
 * fake here answers by which computer's alias appears on the command line — the only way to prove
 * the identity that comes back really tracks the computer that was asked, rather than being echoed
 * straight from the request.
 */

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-host-bridge-"));
  const provider = { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const { createBranch } = await import("../dist/index.js");
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }],
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}

/** The owner's own SSH files, written where the test can point at them; never touched otherwise. */
async function sshHome(root, config, knownHosts) {
  const folder = join(root, `ssh-${Math.random().toString(36).slice(2)}`);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "config"), config, "utf8");
  await writeFile(join(folder, "known_hosts"), knownHosts, "utf8");
  return { config: join(folder, "config"), knownHosts: join(folder, "known_hosts") };
}

/**
 * A stand-in for the OpenSSH programs. It answers by whichever computer's alias is on the command
 * line, so two computers configured at once can never be told apart by coincidence.
 */
function fakeSshByHost(outputs) {
  const calls = [];
  const run = async (executable, args) => {
    calls.push({ executable, args });
    const alias = Object.keys(outputs).find((name) => args.includes(name));
    return { status: "completed", stdout: alias ? outputs[alias] : "", stderr: "", exitCode: 0 };
  };
  return { calls, run };
}

/** A stand-in for the `Branch` app: `hostBridgeApi` only ever reaches into `.remotes`. */
const branchOf = (remotes) => ({ remotes });
const request = { method: "POST" };
const bodyOf = (body) => async () => body;

test("FQ-execution.host-bridge: an explicitly chosen host's identity travels back with its result", async (t) => {
  const { app, root } = await fixture(t);
  const { RemoteWorkspaces } = await import("../dist/remote/ssh-workspace.js");
  const { hostBridgeApi, handlesHostBridgePath, HostBridgeApiError } = await import("../dist/host-bridge-api.js");

  const home = await sshHome(root,
    "Host tower\n  HostName tower.lan\nHost pi\n  HostName pi.lan\n",
    "tower.lan ssh-ed25519 AAAA\npi.lan ssh-ed25519 AAAA\n");
  const ssh = fakeSshByHost({ tower: "built on tower\n", pi: "built on pi\n" });
  const remotes = new RemoteWorkspaces(app.store, "local", ssh.run, home);
  await remotes.add({ alias: "tower", root: "/srv/work", executables: ["make"] });
  await remotes.add({ alias: "pi", root: "/srv/work", executables: ["make"] });
  const branch = branchOf(remotes);

  assert.equal(handlesHostBridgePath("/api/host-bridge/run"), true);
  assert.equal(handlesHostBridgePath("/api/host-bridge"), false);
  assert.equal(handlesHostBridgePath("/api/remotes"), false);

  // Asking "tower" explicitly gets tower's own answer back, with tower's own name on it.
  const fromTower = await hostBridgeApi(branch, request, "/api/host-bridge/run",
    bodyOf({ computer: "tower", program: "make", args: ["build"] }));
  assert.equal(fromTower.computer, "tower");
  assert.equal(fromTower.program, "make");
  assert.equal(fromTower.output.trim(), "built on tower");

  // Asking "pi" explicitly — the other computer, same program — gets pi's own name and pi's own
  // answer, never tower's: the identity that comes back is asserted, not assumed.
  const fromPi = await hostBridgeApi(branch, request, "/api/host-bridge/run",
    bodyOf({ computer: "pi", program: "make", args: ["build"] }));
  assert.equal(fromPi.computer, "pi");
  assert.equal(fromPi.output.trim(), "built on pi");
  assert.notEqual(fromPi.computer, fromTower.computer);
  assert.notEqual(fromPi.output, fromTower.output);

  // Every call actually named the computer it was asked to reach, on the wire, and no other.
  assert.equal(ssh.calls.length, 2);
  assert.ok(ssh.calls[0].args.includes("tower") && !ssh.calls[0].args.includes("pi"));
  assert.ok(ssh.calls[1].args.includes("pi") && !ssh.calls[1].args.includes("tower"));

  // A computer that was never added is refused plainly, not silently ignored.
  await assert.rejects(
    hostBridgeApi(branch, request, "/api/host-bridge/run", bodyOf({ computer: "nowhere", program: "make", args: [] })),
    (error) => error instanceof HostBridgeApiError && error.status === 400 && /not one of the computers/.test(error.message));

  // A program that computer was never allowed to run is refused, and names the computer.
  await assert.rejects(
    hostBridgeApi(branch, request, "/api/host-bridge/run", bodyOf({ computer: "tower", program: "rm", args: ["-rf", "/"] })),
    (error) => error instanceof HostBridgeApiError && /not one of the programs tower is allowed to run/.test(error.message));

  // A malformed body, and the wrong method or address, are both refused before anything is asked.
  await assert.rejects(
    hostBridgeApi(branch, request, "/api/host-bridge/run", bodyOf({ computer: "tower" })),
    (error) => error instanceof HostBridgeApiError && error.status === 400);
  await assert.rejects(
    hostBridgeApi(branch, { method: "GET" }, "/api/host-bridge/run", bodyOf({})),
    (error) => error instanceof HostBridgeApiError && error.status === 404);
  await assert.rejects(
    hostBridgeApi(branch, request, "/api/host-bridge/other", bodyOf({})),
    (error) => error instanceof HostBridgeApiError && error.status === 404);

  assert.equal(ssh.calls.length, 2, "the refused calls never reached OpenSSH at all");
});

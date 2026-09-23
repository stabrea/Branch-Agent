import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/**
 * FQ-security.host-pinning's last gap: a test that runs a command against a host whose key has
 * changed and proves it is refused, through the same `RemoteWorkspaces.execute` the wired
 * `remote.run` tool calls (see `registerRemoteWorkspaces` in src/remote/ssh-workspace.ts, whose
 * `execute` handler is exactly this method). The product already forces
 * `StrictHostKeyChecking=yes` and never falls back to `=no`; what was missing was proof that a
 * changed key is refused rather than silently accepted, and that nothing gets re-pinned.
 *
 * No real sshd is started (there is none to install for free, locally, inside a test), so the
 * "other computer" is a fake `ssh` that answers the way real OpenSSH does. The fake does not
 * return a canned refusal string: it reads the key the owner already pinned in their own
 * `known_hosts` file and compares it against the key the "server" is presenting right now, and it
 * only refuses when the arguments it was actually given still carry `StrictHostKeyChecking=yes`.
 * That way the test fails if the product ever weakened that option, not only if the wording of an
 * error message changed.
 */

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-host-pinning-"));
  const provider = { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }],
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}

/** The owner's own two SSH files, written where the test can point at them. */
async function sshHome(root, config, knownHosts) {
  const folder = join(root, `ssh-${Math.random().toString(36).slice(2)}`);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "config"), config, "utf8");
  await writeFile(join(folder, "known_hosts"), knownHosts, "utf8");
  return { config: join(folder, "config"), knownHosts: join(folder, "known_hosts") };
}

/**
 * A fake OpenSSH that decides for itself, the way the real client does: it reads the key already
 * pinned in the owner's `known_hosts` file, compares it with whatever key the "server" is
 * presenting at the moment of the call, and refuses with OpenSSH's own wording when they differ —
 * but only while the call still carries `StrictHostKeyChecking=yes`. `setServerKey` is how a test
 * changes what the host presents, standing in for the host's key actually having changed.
 */
function fakeHostPinningSsh(home, presentedKey) {
  const calls = [];
  let presented = presentedKey;
  const run = async (executable, args) => {
    let out;
    if (executable !== "ssh") {
      out = { status: "completed", stdout: "", stderr: "", exitCode: 0 };
    } else {
      const pinnedText = await readFile(home.knownHosts, "utf8").catch(() => "");
      const pinned = (pinnedText.match(/ssh-ed25519 \S+/) ?? [])[0] ?? "";
      const strict = args.includes("StrictHostKeyChecking=yes") && !args.includes("StrictHostKeyChecking=no");
      if (strict && pinned && presented !== pinned) {
        out = { status: "completed", exitCode: 255, stdout: "", stderr:
          "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n" +
          "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n" +
          "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n" +
          "Someone could be eavesdropping on you right now (man-in-the-middle attack)!\r\n" +
          "Host key verification failed.\r\n" };
      } else {
        out = { status: "completed", exitCode: 0, stdout: "ok\n", stderr: "" };
      }
    }
    calls.push({ executable, args, out });
    return out;
  };
  return { calls, run, setServerKey: (key) => { presented = key; }, last: () => calls.at(-1).out,
    lastCall: () => calls.at(-1) };
}

test("FQ-security.host-pinning a command refuses once the host's key no longer matches what was pinned", async (t) => {
  const { app, root } = await fixture(t);
  const { RemoteWorkspaces, explainSsh } = await import("../dist/remote/ssh-workspace.js");

  const originalKey = "ssh-ed25519 AAAAoriginalPinnedKeyForTower";
  const changedKey = "ssh-ed25519 AAAAdifferentKeyAfterAReinstall";
  const home = await sshHome(root, "Host tower\n  HostName tower.lan\n", `tower.lan ${originalKey}\n`);
  const beforeKnownHosts = await readFile(home.knownHosts, "utf8");

  const world = fakeHostPinningSsh(home, originalKey);
  const remotes = new RemoteWorkspaces(app.store, "local", world.run, home);
  await remotes.add({ alias: "tower", root: "/srv/work", executables: ["make"] });

  // While the host still presents the key the owner accepted, a run goes through normally.
  const ok = await remotes.execute("tower", "make", ["build"], AbortSignal.timeout(5000));
  assert.equal(ok.output.trim(), "ok");
  const callsBeforeChange = world.calls.length;

  // The host's key changes (a reinstall, a spoofed address, whatever the cause) without the owner
  // re-accepting anything.
  world.setServerKey(changedKey);

  // remote.run's own handler is `remotes.execute` (registerRemoteWorkspaces wires it directly), so
  // calling it here is calling exactly what the owner's approval runs.
  await assert.rejects(
    remotes.execute("tower", "make", ["build"], AbortSignal.timeout(5000)),
    /tower showed a different key from the one you accepted before/);
  // The same refusal the owner would actually read, produced by the same ssh() call path.
  assert.equal(
    explainSsh("tower", world.last()),
    "tower showed a different key from the one you accepted before. Branch stopped rather than carry on. Check with whoever looks after that computer.");

  // Exactly one more attempt was made — no silent retry, and nothing weakened the options.
  assert.equal(world.calls.length, callsBeforeChange + 1);
  const refused = world.lastCall();
  assert.ok(refused.args.includes("StrictHostKeyChecking=yes"));
  assert.equal(refused.args.includes("StrictHostKeyChecking=no"), false);

  // Refusing never rewrites what the owner already pinned: the file on disk is untouched.
  assert.equal(await readFile(home.knownHosts, "utf8"), beforeKnownHosts);

  // The same gate protects every other command against that computer, not only remote.run: listing
  // a folder is refused the same way, through the same private ssh() call.
  await assert.rejects(
    remotes.files("tower", "reports", AbortSignal.timeout(5000)),
    /tower showed a different key from the one you accepted before/);

  // Once the owner accepts the new key themselves (by writing it into known_hosts, exactly as
  // adding a computer required in the first place) the same command is allowed again.
  await writeFile(home.knownHosts, `tower.lan ${changedKey}\n`, "utf8");
  const again = await remotes.execute("tower", "make", ["build"], AbortSignal.timeout(5000));
  assert.equal(again.output.trim(), "ok");
});

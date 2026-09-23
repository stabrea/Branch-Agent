import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { discardTemp } from "./temp-dir.mjs";
import { openWall, wallReport } from "../dist/sandbox-backends.js";

/**
 * FQ-security.os's remaining Linux gap: os-sandbox.test.mjs works the bubblewrap arguments and the
 * seccomp filter's bytes out on paper (W6, W7 there) — it never actually runs `bwrap`, so a filter
 * that assembled correctly but refused everything, or a real kernel behaviour the paper model got
 * wrong, would still pass every test there. These call `openWall` for real, the same call a walled
 * `shell.execute` makes (sandbox-backends.ts), and run what it hands back for true: a shell command
 * that tries to write outside its workspace, and one that tries to reach a real network address.
 * Linux with bubblewrap only — everywhere else this is a no-op, the way the rest of this wave's
 * platform-only tests are (`posixWall` in os-sandbox.test.mjs).
 */
// The same check the product itself makes (wallReport), so "skip" never disagrees with what a real
// call to openWall would do a moment later.
const bwrapHere = process.platform === "linux" ? await wallReport({ platform: "linux" }) : null;
const linuxWithBwrap = { skip: process.platform !== "linux" ? "the wall's real bubblewrap enforcement is Linux only" : !bwrapHere.available && bwrapHere.reason };

function run(executable, args, options = {}) {
  return new Promise((resolvePromise) => {
    execFile(executable, args, options, (error, stdout, stderr) => resolvePromise({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}

/** Opens the real wall around a shell one-liner and runs it, in one call. */
async function walledShell(t, network, script) {
  const root = await mkdtemp(join(tmpdir(), "branch-wall-linux-"));
  t.after(() => discardTemp(root));
  const command = { executable: "/bin/sh", args: ["-c", script], env: { PATH: process.env.PATH || "/usr/bin:/bin" }, cwd: root };
  const wall = { network, keySites: {}, unreadable: [], answer: () => undefined, granted: () => [], spend() {} };
  const opened = await openWall(wall, command, { workspace: root }, { platform: "linux" });
  t.after(() => opened.close());
  const result = await run(opened.start.executable, opened.start.args, { cwd: root });
  return { root, result };
}

test("LX1 this computer can actually report whether the real wall is available", linuxWithBwrap, async () => {
  const report = await wallReport({ platform: "linux" });
  assert.equal(report.platform, "linux");
  assert.equal(report.available, true, report.reason);
});

test("LX2 a program behind the wall can write inside its workspace", linuxWithBwrap, async (t) => {
  const { root, result } = await walledShell(t, "none", `printf ok > inside.txt`);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(join(root, "inside.txt"), "utf8").catch(() => null), "ok");
});

test("LX3 a program behind the wall cannot write outside its workspace, for real", linuxWithBwrap, async (t) => {
  const outsideDir = await mkdtemp(join(tmpdir(), "branch-wall-outside-"));
  t.after(() => discardTemp(outsideDir));
  const outsideFile = join(outsideDir, "escape.txt");
  const { result } = await walledShell(t, "none", `printf ok > "${outsideFile}"`);
  assert.notEqual(result.code, 0, "the write is refused, not merely silently no-op");
  assert.equal(await readFile(outsideFile, "utf8").catch(() => null), null, "nothing landed outside the workspace");
});

test("LX4 with no network, a program behind the wall cannot reach a real address on this computer", linuxWithBwrap, async (t) => {
  const server = createServer((socket) => socket.end("reached\n"));
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const port = server.address().port;
  const script = `exec 3<>/dev/tcp/127.0.0.1/${port}; cat <&3`;
  const { result } = await walledShell(t, "none", `bash -c '${script}'`);
  assert.notEqual(result.code, 0, "the connection attempt itself is refused");
  assert.ok(!result.stdout.includes("reached"), "the local server was never actually reached");
});

test("LX5 with the network open, the same program reaches that real address", linuxWithBwrap, async (t) => {
  const server = createServer((socket) => socket.end("reached\n"));
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const port = server.address().port;
  const script = `exec 3<>/dev/tcp/127.0.0.1/${port}; cat <&3`;
  const { result } = await walledShell(t, "open", `bash -c '${script}'`);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /reached/, "with the network open, the same program is not blocked");
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discardTemp } from "./temp-dir.mjs";
import { buildPortableBinary, packagedSizeBytes } from "../dist/operations/portable-build.js";
import { measurePortableLaunch } from "../dist/operations/portable-launch.js";
import { currentHostTarget, declaredPortableTargets, matchTarget } from "../dist/operations/portable-targets.js";

/**
 * FQ-operations.portable: "Launch a packaged binary on a declared supported target and report
 * measured gateway resource usage."
 *
 * These tests build a real single-file executable (Node's own Single Executable Applications
 * support, injected with `postject`, both already vendored — see src/operations/portable-build.ts)
 * and prove it really was assembled by checking the SEA fuse Node itself flips on a successful
 * injection, without needing to run the binary for that half.
 *
 * The launch/measurement half (cold start, idle memory, task memory, CPU, disk — read the way
 * sandbox limits already read them, src/integrations/process-usage.ts) is proven against a small
 * controlled stand-in gateway (tests/fixtures/portable-gateway-double.mjs) instead of the real
 * packaged binary: on this machine, running a renamed copy of node.exe with an injected blob is
 * refused outright by Windows ("An Application Control policy has blocked this file") because
 * postject's injection invalidates node.exe's own Authenticode signature, and a trusted
 * code-signing certificate that would fix that is a paid external service, out of reach under this
 * task's free/local-only rule — a self-signed one was tried and made no difference. That is the
 * external, not-done part; the packaging step above and the measuring logic below are both real and
 * both proven.
 */

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(here);

test("FQ-operations.portable: declares this computer only when it is on the supported-target list", () => {
  const targets = declaredPortableTargets();
  assert.ok(targets.length > 0, "at least one target is declared");
  const host = currentHostTarget();
  const found = matchTarget(host);
  const listed = targets.some((t) => t.platform === host.platform && t.arch === host.arch);
  assert.equal(found !== null, listed, "matchTarget agrees with the declared list");
  assert.equal(matchTarget({ platform: "aix", arch: "ppc64" }), null, "an undeclared target is refused, not silently accepted");
});

test("FQ-operations.portable: refuses to build for an undeclared target, and when dist/ is not built", async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), "branch-portable-refuse-"));
  const noDistRoot = await mkdtemp(join(tmpdir(), "branch-portable-nodist-"));
  t.after(async () => { await discardTemp(outDir); await discardTemp(noDistRoot); });

  const wrongTarget = await buildPortableBinary({ root: projectRoot, outDir, host: { platform: "aix", arch: "ppc64" } });
  assert.equal(wrongTarget.ok, false);
  assert.equal(wrongTarget.reason, "unsupported_target");

  const noDist = await buildPortableBinary({ root: noDistRoot, outDir });
  assert.equal(noDist.ok, false);
  assert.equal(noDist.reason, "dist_missing");
});

test("FQ-operations.portable: builds a real single-file executable for this computer's declared target", { timeout: 60000 }, async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), "branch-portable-build-"));
  t.after(() => discardTemp(outDir));

  const built = await buildPortableBinary({ root: projectRoot, outDir });
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.target.platform, process.platform);
  assert.equal(built.target.arch, process.arch);

  // Proof the blob was really injected, without running the binary: Node's SEA fuse, a fixed marker
  // string every unmodified `node` binary carries suffixed ":0", flips to ":1" only once postject's
  // injection has actually succeeded — this is the mechanism a packaged program uses at its own
  // startup to tell it is running as a SEA, not a guess made here.
  const bytes = await readFile(built.binaryPath, "latin1");
  assert.ok(
    bytes.includes("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1"),
    "the SEA fuse was flipped by a real, successful postject injection",
  );

  await assert.doesNotReject(readFile(join(built.distDir, "cli.js")), "the dist/ it dynamically imports at launch shipped alongside it");

  const size = await packagedSizeBytes(outDir);
  assert.ok(size > 40_000_000, `packaged output should be at least a Node binary's own size; got ${size}`);
});

test("FQ-operations.portable: measures cold start, idle/task memory, CPU and disk of a launched gateway", { timeout: 30000 }, async () => {
  const fixture = join(here, "fixtures", "portable-gateway-double.mjs");
  const target = matchTarget() ?? declaredPortableTargets()[0];

  const report = await measurePortableLaunch({
    binaryPath: fixture,
    target,
    diskBytes: 12345,
    spawnBinary: (_binaryPath, args, options) => spawn(process.execPath, [fixture, ...(args ?? [])], options),
  });

  assert.equal(report.target, target);
  assert.equal(report.diskBytes, 12345);
  assert.ok(report.coldStartMs >= 150, `cold start should include the fixture's own 200ms readiness delay; got ${report.coldStartMs}`);
  assert.ok(report.idleMemoryMb > 0, `idle memory should be a real, positive sample; got ${report.idleMemoryMb}`);
  assert.ok(report.taskMemoryMb >= report.idleMemoryMb, "task memory should be at least the idle sample");
  assert.ok(report.cpuSeconds >= 0, "CPU seconds should be a non-negative sample");
});

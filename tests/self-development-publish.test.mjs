import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/store.js";
import { proposeBranchSourceChange, branchSourceDiff, publishBranchSourceChange, reviewedBranchSourceChanges } from "../dist/self-development.js";

const ok = (stdout = "") => ({ status: "completed", exitCode: 0, stdout, stderr: "", command: "git" });

test("draft publication rejects changed diff, wrong provenance, replay and concurrent requests", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "source-publish-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const store = new Store(join(workspace, "store.sqlite"));
  t.after(() => store.close());
  const folder = "branch-agent-source/.branch-worktrees/self-safe";
  mkdirSync(join(workspace, folder), { recursive: true });
  const run = store.createRun("local", "request", undefined, false, "channel");
  store.event(run.id, "run.started", { source: "channel" });
  const input = { name: "safe", goal: "Publish the reviewed change safely", repository: "https://github.com/stabrea/Branch-Agent.git", base: "mac/cross-platform" };
  const id = proposeBranchSourceChange({ store, owner: "local" }, input, { runId: run.id, source: "channel" }).id;
  store.sqlite.prepare("UPDATE branch_source_requests SET status = 'review', worktree_folder = ? WHERE id = ?").run(folder, id);
  let diff = "diff --git a/a b/a\n+safe", branch = "branch/self-safe", committed = false, pushed = false, opened = 0;
  let release, entered;
  const barrier = new Promise((resolve) => { release = resolve; });
  const atAdd = new Promise((resolve) => { entered = resolve; });
  const git = async ({ args }) => {
    const cmd = args.join(" ");
    if (cmd.includes("config --get-regexp")) return { ...ok(), status: "failed", exitCode: 1 };
    if (cmd.includes("symbolic-ref")) return ok(branch);
    if (cmd.includes("remote get-url")) return ok(input.repository);
    if (cmd.includes("merge-base") || cmd === "rev-parse HEAD" && !committed) return ok("a".repeat(40));
    if (cmd === "rev-parse HEAD") return ok("b".repeat(40));
    if (cmd.includes("ls-files")) return ok();
    if (cmd.includes("status --porcelain")) return ok(committed ? "" : " M a");
    if (cmd.includes("diff --cached") || cmd.includes("diff HEAD^ HEAD") || cmd.includes("diff HEAD --binary")) return ok(diff);
    if (cmd.includes("ls-remote")) return ok(pushed ? `${"b".repeat(40)}\trefs/heads/${branch}` : "");
    if (cmd.includes(" add ")) { entered(); await barrier; return ok(); }
    if (cmd.includes(" commit ")) { committed = true; return ok(); }
    if (cmd.startsWith("push ")) { pushed = true; return ok(); }
    return ok();
  };
  const deps = { workspace, store, owner: "local", git, policy: { assertAllowed: async () => {} },
    openDraft: async ({ draft }) => { assert.equal(draft, true); opened++; return { number: 42 }; } };
  const signal = AbortSignal.timeout(10000);
  const { publishDigest } = await branchSourceDiff(deps, id, signal);
  assert.match(publishDigest, /^[a-f0-9]{64}$/);
  await assert.rejects(publishBranchSourceChange({ ...deps, owner: "other" }, id, publishDigest, signal), /matching reviewed/);
  await assert.rejects(publishBranchSourceChange(deps, id, "0".repeat(64), signal), /matching reviewed/);
  store.sqlite.prepare("UPDATE branch_source_requests SET run_id = ? WHERE id = ?").run("missing-origin", id);
  await assert.rejects(publishBranchSourceChange(deps, id, publishDigest, signal), /provenance is invalid/);
  store.sqlite.prepare("UPDATE branch_source_requests SET run_id = ? WHERE id = ?").run(run.id, id);
  diff += "\n+tampered";
  await assert.rejects(publishBranchSourceChange(deps, id, publishDigest, signal), /changed since review/);
  diff = "diff --git a/a b/a\n+safe";
  branch = "branch/other";
  await assert.rejects(publishBranchSourceChange(deps, id, publishDigest, signal), /branch changed/);
  branch = "branch/self-safe";
  const first = publishBranchSourceChange(deps, id, publishDigest, signal);
  await atAdd;
  await assert.rejects(publishBranchSourceChange(deps, id, publishDigest, signal), /matching reviewed/);
  release();
  const result = await first;
  assert.equal(result.sha, "b".repeat(40));
  assert.equal(pushed, true);
  assert.equal(opened, 1);
  assert.equal(reviewedBranchSourceChanges(deps)[0].publishedSha, result.sha);
  await assert.rejects(publishBranchSourceChange(deps, id, publishDigest, signal), /matching reviewed/);
});

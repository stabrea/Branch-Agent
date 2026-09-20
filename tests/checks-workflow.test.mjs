import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const workflow = YAML.parse(await readFile(new URL("../.github/workflows/checks.yml", import.meta.url), "utf8"));
const fast = YAML.parse(await readFile(new URL("../.github/workflows/pr-fast.yml", import.meta.url), "utf8"));

test("exhaustive checks keep every integration-trunk result without occupying every pull request", () => {
  assert.equal(workflow.concurrency.group, "checks-${{ github.ref }}");
  assert.equal(workflow.concurrency["cancel-in-progress"],
    "${{ github.ref != 'refs/heads/main' && github.ref != 'refs/heads/mac/cross-platform' }}");
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.on.schedule[0].cron, "17 3 * * *");
});

test("checks include current development branches and end in one durable verification job", () => {
  assert.ok(workflow.on.push.branches.includes("mac7/**"));
  assert.deepEqual(workflow.jobs.verify.needs, ["test", "package"]);
  assert.equal(workflow.jobs.verify.if, "always()");
});

test("the required pull-request gate has one job and a hard five-minute execution ceiling", () => {
  assert.deepEqual(Object.keys(fast.jobs), ["verify-fast"]);
  assert.equal(fast.jobs["verify-fast"]["timeout-minutes"], 5);
  assert.ok(Object.hasOwn(fast.on, "pull_request"));
  assert.equal(fast.permissions.actions, "read");
  assert.equal(fast.concurrency["cancel-in-progress"], true);
  const serialized = JSON.stringify(fast.jobs["verify-fast"]);
  assert.match(serialized, /select-affected-tests\.mjs/);
  assert.match(serialized, /actions\/workflows\/checks\.yml\/runs/);
  assert.match(serialized, /head_sha/);
  assert.match(serialized, /npm ci/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const workflow = YAML.parse(await readFile(new URL("../.github/workflows/checks.yml", import.meta.url), "utf8"));

test("checks keep every integration-trunk result without wasting superseded PR runs", () => {
  assert.equal(workflow.concurrency.group, "checks-${{ github.event.pull_request.number || github.ref }}");
  assert.equal(workflow.concurrency["cancel-in-progress"],
    "${{ github.ref != 'refs/heads/main' && github.ref != 'refs/heads/mac/cross-platform' }}");
});

test("checks include current development branches and end in one durable verification job", () => {
  assert.ok(workflow.on.push.branches.includes("mac7/**"));
  assert.deepEqual(workflow.jobs.verify.needs, ["test", "package"]);
  assert.equal(workflow.jobs.verify.if, "always()");
});

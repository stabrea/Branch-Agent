/**
 * FQ-extensions.visual-workflows: a conditional branch built in the visual editor, not only in a
 * saved fixture. A branch step already exists on the engine (src/workflows.ts, kind "branch") and
 * on the editor's own form (public/flow-editor.js, STEP_FIELDS.branch); what was missing was a test
 * that builds one on the page and runs it, proving it actually goes two different ways rather than
 * only drawing two arrows that are never followed.
 *
 * The scripted provider always answers "ok", so a branch whose words are "ok" carries straight on
 * and one whose words are not in "ok" skips ahead — the same flow shape, told apart only by what
 * the owner typed into the branch's own boxes on the page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { openPlace } from "./places.mjs";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-flow-editor-branch-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } },
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); await server.close(); await app.close();
    await discardTemp(root);
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url, { timeout: 120000 });
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  if (await page.locator("#first-run").isVisible()) {
    await page.getByRole("button", { name: /Try it without an account/ }).click();
    await page.locator("#first-run").waitFor({ state: "hidden" });
  }
  await openPlace(page, "procedures");
  await page.locator("#flow-editor").waitFor({ state: "visible" });
  return { app, page, errors };
}

/**
 * Builds, on the page, a four-step flow: ask something, a branch that looks for `contains` in what
 * was just asked, a step that only the "matched" arrow reaches, and one both arrows reach. Saves it,
 * runs it, and hands back the id so the caller can read what actually happened.
 */
async function buildAndRunBranch(page, { name, contains, skipAhead }) {
  await page.locator("#editor-flow").selectOption("");
  await page.locator("#editor-name").fill(name);
  await page.locator("#editor-description").fill("");

  const addStep = async (kind) => {
    await page.locator("#editor-kind").selectOption(kind);
    await page.getByRole("button", { name: "Add a step", exact: true }).click();
    return (await page.locator("#editor-steps .editor-step").count()) - 1;
  };

  const askAt = await addStep("prompt");
  await page.locator(`#editor-${askAt}-prompt`).fill("Say ok");

  const branchAt = await addStep("branch");
  /* Only a branch step is offered these two boxes; a prompt step never was (covered by F1). */
  await page.locator(`#editor-${branchAt}-contains`).fill(contains);
  await page.locator(`#editor-${branchAt}-skipAhead`).fill(String(skipAhead));

  const matchedAt = await addStep("prompt");
  await page.locator(`#editor-${matchedAt}-prompt`).fill("Only reached when the branch matched");

  await addStep("approval");
  await page.locator(`#editor-3-question`).fill("Did we get here?");

  /* The picture is drawn from the steps being edited: a branch step draws two arrows out of it,
     one for each way the flow could go, before anything is saved. */
  const picture = await page.locator("#editor-picture svg").evaluate((svg) => svg.textContent ?? "");
  assert.match(picture, /as expected/, "the branch's matched arrow was never drawn");
  assert.match(picture, /otherwise/, "the branch's skipped arrow was never drawn");

  await page.getByRole("button", { name: "Save this flow", exact: true }).click();
  await page.waitForFunction(() => /Saved\./.test(document.getElementById("editor-status")?.textContent ?? ""));

  await page.getByRole("button", { name: "Run this flow", exact: true }).click();
  await page.waitForFunction(() => /finished/i.test(document.getElementById("editor-status")?.textContent ?? ""),
    undefined, { timeout: 120000 });

  const flowId = await page.locator("#editor-flow").inputValue();
  return flowId;
}

test("F4 a conditional branch built in the visual editor takes the matched arrow or the skipped one, never both", async (t) => {
  const { app, page, errors } = await fixture(t);

  /* "ok" is what the scripted provider always answers, so a branch looking for "ok" matches and
     carries straight on to the step only the matched arrow reaches. */
  const matchedId = await buildAndRunBranch(page, { name: "Branch — matched", contains: "ok", skipAhead: 1 });
  const matchedFlow = app.flows.get(matchedId);
  const [, branchNode, skippableNode] = matchedFlow.graph.nodes;
  assert.equal(branchNode.output, "carried on", "a branch whose words were found did not say it carried on");
  assert.equal(skippableNode.status, "done", "the branch matched, but the step only its matched arrow reaches never ran");

  /* "nope" is never in "ok", so this branch does not match and jumps the step over instead. */
  const skippedId = await buildAndRunBranch(page, { name: "Branch — skipped", contains: "nope", skipAhead: 1 });
  const skippedFlow = app.flows.get(skippedId);
  const [, skippedBranchNode, jumpedNode] = skippedFlow.graph.nodes;
  assert.equal(skippedBranchNode.output, "skipped ahead", "a branch whose words were missing did not say it skipped ahead");
  assert.equal(jumpedNode.status, "waiting", "the branch missed, but the step its skipped arrow jumps over ran anyway");

  assert.deepEqual(errors, []);
});

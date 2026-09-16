/**
 * Hardening pass 2: the gaps the wave 7 integrators wrote down as "not fixed". One test per gap,
 * each one the test that would have caught it. Fakes only: no real network, no real screen, no
 * real outside server, nothing on the desktop.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, savePolicy } from "../dist/index.js";

const say = (content) => ({ content, toolCalls: [] });

async function fixture(t, reply = () => say("done"), options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-hardening2-"));
  const provider = { name: "scripted", async complete(request) { return reply(request); } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  t.after(async () => {
    await app.processes.stopAll().catch(() => undefined);
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, root };
}

// ---------------------------------------------------------------------------
// 7. The owner may add websites their own browser must never be pointed at, and
//    may never take one off the built-in list.
// ---------------------------------------------------------------------------

test("the owner's extra refused websites are added to the built-in list, never subtracted", async () => {
  const { hostRefusalFor } = await import("../dist/integrations/desktop-config.js");
  const { attachedAddressRefusal, AttachSettingsSchema } = await import("../dist/integrations/browser-attach.js");
  // A site of the owner's own is refused once they name it, and not before.
  assert.equal(hostRefusalFor("payroll.example"), null);
  assert.match(hostRefusalFor("payroll.example", ["payroll.example"]) ?? "", /passwords/);
  // Anything under it is refused too, exactly as the built-in entries are.
  assert.match(hostRefusalFor("login.payroll.example", ["payroll.example"]) ?? "", /passwords/);
  // The list is additive only: naming a built-in entry cannot turn it off, and neither can
  // handing in an empty list, whitespace, or something that looks like a removal.
  for (const extra of [[], ["chase.com"], ["  "], ["-chase.com"], ["!chase.com"]])
    assert.match(hostRefusalFor("chase.com", extra) ?? "", /money or passwords/, JSON.stringify(extra));
  // The whole-address check carries the owner's extra sites through.
  assert.equal(attachedAddressRefusal("https://payroll.example/pay"), null);
  assert.match(attachedAddressRefusal("https://payroll.example/pay", "", ["payroll.example"]) ?? "", /passwords/);
  // And the setting is a plain list kept beside the rest of the browser settings.
  assert.deepEqual(AttachSettingsSchema.parse({}).extraRefusedHosts, []);
});

test("the extra refused websites are saved and read back through the browser settings", async (t) => {
  const { app } = await fixture(t);
  const { readAttachSettings, saveAttachSettings } = await import("../dist/integrations/browser-attach.js");
  const saved = saveAttachSettings(app.store, app.runtime.owner, { extraRefusedHosts: ["payroll.example"] });
  assert.deepEqual(saved.extraRefusedHosts, ["payroll.example"]);
  assert.deepEqual(readAttachSettings(app.store, app.runtime.owner).extraRefusedHosts, ["payroll.example"]);
});

// ---------------------------------------------------------------------------
// 9. Every answer to an approval question is bound to the exact bytes it was
//    put for — the workflow/flow resume and `branch approve` included.
// ---------------------------------------------------------------------------

/** A workflow whose one step writes a file, which an "ask about this tool" rule stops on. */
const writingWorkflow = (app, content) => app.workflows.create("local", {
  name: "Writes one file",
  steps: [{ name: "Write it", kind: "tool", tool: "files.write", args: { path: "note.txt", content } }],
});

test("a workflow's yes is bound to the exact arguments the step asked about", async (t) => {
  const { app } = await fixture(t);
  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: "files.write", decision: "ask", remember: "session" }] });
  const made = writingWorkflow(app, "first");
  const held = await app.workflows.run("local", made.id);
  assert.equal(held.status, "waiting_approval");
  const asked = app.store.get("workflows", "local", made.id).data.pendingApproval;
  assert.match(String(asked.fingerprint ?? ""), /^[a-f0-9]{32}$/, "the question must carry the exact-bytes fingerprint");
  // The owner says yes, and the yes is remembered against that fingerprint and no other.
  const done = await app.workflows.resume("local", made.id);
  assert.equal(done.status, "completed", done.error ?? "");
  const key = `workflow:${made.id}`;
  assert.equal(app.runtime.approvals.answer(key, "files.write", asked.target, asked.fingerprint), "allow");
  assert.equal(app.runtime.approvals.answer(key, "files.write", asked.target, "0".repeat(32)), undefined,
    "a yes given for one request must not cover a different one");
});

test("`branch approve` binds its answer to the request the task actually stopped on", async (t) => {
  const tool = { id: "c1", name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hello" }) };
  const { app } = await fixture(t, (request) =>
    request.messages.some((message) => message.role === "tool") ? say("written") : { content: "", toolCalls: [tool] });
  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: "files.write", decision: "ask", remember: "session" }] });
  const { answerFromCommand } = await import("../dist/cli-run.js");
  const run = await app.runtime.run({ prompt: "write a note" });
  assert.equal(run.status, "needs_input");
  const asked = app.store.events(run.id).filter((event) => event.kind === "policy.ask").at(-1);
  assert.match(String(asked.data.fingerprint ?? ""), /^[a-f0-9]{32}$/);
  const target = String(asked.data.target ?? "");
  answerFromCommand(app.runtime, run.id, "yes");
  assert.equal(app.runtime.approvals.answer(run.sessionId, "files.write", target, asked.data.fingerprint), "allow");
  assert.equal(app.runtime.approvals.answer(run.sessionId, "files.write", target, "0".repeat(32)), undefined,
    "the answer must not cover a request the owner never saw");
});

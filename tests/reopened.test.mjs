import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";

/**
 * Wave 8: the rows the 2026-09-17 ledger verification re-opened. Each test names the audit id it
 * stands for, and asserts the behaviour the row promised rather than that a symbol exists.
 */
export const say = (content) => ({ content, toolCalls: [] });
export const call = (name, args) =>
  ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 9)}`, name, arguments: JSON.stringify(args) }] });

/** A provider whose answer is chosen from the request, so a test can make the model ask for a tool. */
function scripted(reply) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    const user = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    return reply({ user, last: request.messages.at(-1), request });
  } };
  return provider;
}
async function fixture(t, reply = () => say("done")) {
  const root = await mkdtemp(join(tmpdir(), "branch-reopened-"));
  const provider = scripted(reply);
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }],
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, root, provider, alpha: provider };
}

/** A password manager's command line that never leaves this process. */
function fakeCli(answers) {
  const calls = [];
  return {
    calls,
    runner: async (executable, args, timeoutMs) => {
      calls.push({ executable, args, timeoutMs });
      const answer = answers[executable];
      if (!answer) return { code: null, stdout: "", stderr: "", missing: true };
      return typeof answer === "function" ? answer(args) : answer;
    },
  };
}

// ---------------------------------------------------------------- A1519 / A1841

test("A1519/A1841 a bitwarden and a 1password reference are resolved through the owner's own command line, only at the call", async (t) => {
  const { app } = await fixture(t);
  const { CredentialResolver, saveCredentialSettings, parseCredentialReference, commandFor } =
    await import("../dist/credential-cli.js");
  const cli = fakeCli({
    bw: { code: 0, stdout: "bw-password-8f7e6d\n", stderr: "" },
    op: { code: 0, stdout: "op-password-1a2b3c", stderr: "" },
  });
  const resolver = new CredentialResolver(app.store, "local", app.store.secrets.scrubber, cli.runner);

  // Off until the owner turns it on, and then only for the services they ticked.
  await assert.rejects(resolver.read({ service: "bitwarden", item: "GitHub" }, { purpose: "test" }),
    /not set up to read passwords/);
  saveCredentialSettings(app.store, "local", { enabled: true, services: ["bitwarden"] });
  await assert.rejects(resolver.read({ service: "1password", item: "Private/GitHub/password" }, { purpose: "test" }),
    /not allowed to read from 1Password/);
  saveCredentialSettings(app.store, "local", { enabled: true, services: ["bitwarden", "1password"] });

  assert.deepEqual(parseCredentialReference("secret://bitwarden/GitHub Deploy"), { service: "bitwarden", item: "GitHub Deploy" });
  assert.equal(parseCredentialReference("secret://default/DEPLOY_TOKEN"), null, "a locker reference is not a vault reference");
  assert.deepEqual(commandFor({ service: "bitwarden", item: "GitHub" }, { bitwardenCommand: "bw", onePasswordCommand: "op" }).args,
    ["--nointeraction", "--raw", "get", "password", "GitHub"]);

  const filled = await resolver.fill(
    { header: "Bearer secret://bitwarden/GitHub", other: "secret://1password/Private/Deploy/password", untouched: 7 },
    { purpose: "a test" });
  assert.equal(filled.header, "Bearer bw-password-8f7e6d", "the trailing newline is taken off");
  assert.equal(filled.other, "op-password-1a2b3c");
  assert.equal(filled.untouched, 7);
  assert.deepEqual(cli.calls.map((c) => c.executable), ["bw", "op"]);
  assert.ok(cli.calls[1].args.includes("op://Private/Deploy/password"), "1Password is read by its own path");

  // The value never reaches the record, and is taken back out of anything written afterwards.
  const written = app.store.audit.list("local").filter((row) => row.action === "secret.used");
  assert.ok(written.some((row) => row.subject === "secret://bitwarden/GitHub"), "the item name is recorded");
  assert.ok(!JSON.stringify(written).includes("bw-password-8f7e6d"), "the password is not");
  assert.match(app.store.secrets.scrubber.text("the key is bw-password-8f7e6d ok"), /\[secret bitwarden:GitHub\]/);
});

test("A1519 a missing or locked command line is a plain refusal, never a guess", async (t) => {
  const { app } = await fixture(t);
  const { CredentialResolver, saveCredentialSettings, refusalFrom } = await import("../dist/credential-cli.js");
  saveCredentialSettings(app.store, "local", { enabled: true, services: ["bitwarden", "1password"] });
  const absent = new CredentialResolver(app.store, "local", app.store.secrets.scrubber, fakeCli({}).runner);
  await assert.rejects(absent.read({ service: "bitwarden", item: "GitHub" }, { purpose: "t" }),
    /Bitwarden's command line \(bw\) is not on this computer/);
  const shut = new CredentialResolver(app.store, "local", app.store.secrets.scrubber,
    fakeCli({ bw: { code: 1, stdout: "", stderr: "You are not logged in." } }).runner);
  await assert.rejects(shut.read({ service: "bitwarden", item: "GitHub" }, { purpose: "t" }), /vault is locked/);
  assert.match(refusalFrom({ service: "1password", item: "x" }, { code: 1, stdout: "", stderr: "could not find item" }, "op"),
    /There is nothing called "x" in your 1Password vault\./);
  assert.equal(refusalFrom({ service: "bitwarden", item: "x" }, { code: 0, stdout: "value", stderr: "" }, "bw"), null);
});

test("A1841 the locker still resolves its own references while a vault reference goes to the vault", async (t) => {
  const { app } = await fixture(t);
  const { CredentialResolver, saveCredentialSettings } = await import("../dist/credential-cli.js");
  await app.store.locker.set("local", "default", "DEPLOY_TOKEN", "tok-local-4d5e6f");
  saveCredentialSettings(app.store, "local", { enabled: true, services: ["bitwarden"] });
  app.store.secrets.credentials = new CredentialResolver(app.store, "local", app.store.secrets.scrubber,
    fakeCli({ bw: { code: 0, stdout: "bw-value-7a8b", stderr: "" } }).runner);
  const filled = await app.store.secrets.fill("local", "default",
    { a: "secret://default/DEPLOY_TOKEN", b: "secret://bitwarden/GitHub" }, { purpose: "both at once" });
  assert.deepEqual(filled, { a: "tok-local-4d5e6f", b: "bw-value-7a8b" });
});

// ---------------------------------------------------------------- A0245 / A2277

function taskContext(app, prompt = "a task") {
  const run = app.store.createRun(app.runtime.owner, prompt);
  return { run, context: app.runtime.context({ runId: run.id }) };
}
const allowScripts = (app) => app.store.save("settings", app.runtime.owner, "code-run",
  { enabled: true, python: "", network: true, timeoutMs: 8000, maxMemoryMb: 256, maxCpuSeconds: 10, maxOutputBytes: 2048 });
/** A script that prints where its way out to the internet points, or says it is open. */
const proxyProbe = 'console.log(process.env.HTTPS_PROXY || "reachable")';

test("A0245/A2277 an approval rule picks how tightly a program is held, and code.run honours it", async (t) => {
  const { app } = await fixture(t);
  const { savePolicy } = await import("../dist/policy.js");
  const { sandboxShape, shapeChoice, ruleSentence } = await import("../dist/index.js");
  allowScripts(app);
  const { context } = taskContext(app);

  // Without a rule the script settings decide, exactly as before rules could say anything.
  const plain = await app.registry.execute("code.run", { language: "javascript", source: proxyProbe }, context);
  assert.match(plain.output, /reachable/, "network: true in the script settings still means reachable");
  assert.equal(plain.sandbox, "limits-only");

  // A rule that says "no way out to the internet" reaches the program that is started.
  savePolicy(app.store, app.runtime.owner,
    { rules: [{ tool: "code.run", match: "*", applies: "any", decision: "allow", remember: "session", sandbox: "no-internet" }] });
  const check = app.runtime.checkPolicy("code.run", { language: "javascript", source: proxyProbe }, context);
  assert.equal(check.sandbox, "no-internet", "the rule's choice comes back with the decision");
  const held = await app.registry.execute("code.run", { language: "javascript", source: proxyProbe },
    { ...context, sandbox: check.sandbox });
  assert.match(held.output, /127\.0\.0\.1:9/, "the script is pointed at a dead address");
  assert.equal(held.sandbox, "no-internet");
  assert.equal(held.network, false);

  // And "none" takes the box away again, which is the owner's to choose.
  const loose = await app.registry.execute("code.run", { language: "javascript", source: proxyProbe },
    { ...context, sandbox: "none" });
  assert.match(loose.output, /reachable/);
  assert.equal(loose.sandbox, "none");
  assert.equal(loose.isolation, "sampling", "no Windows job is asked for at all");

  assert.deepEqual(sandboxShape(undefined, { job: true, netless: false }), { job: true, netless: false });
  assert.equal(shapeChoice({ job: true, netless: true }), "no-internet");
  assert.match(ruleSentence({ tool: "code.run", match: "*", applies: "any", decision: "ask", sandbox: "no-internet" }),
    /Run it in a box .* no way out to the internet\./);
});

test("A0245 the choice reaches the question the model's turn stops on, and an older rule list still reads back", async (t) => {
  const { app } = await fixture(t);
  const { savePolicy, readPolicy, PolicySchema } = await import("../dist/policy.js");
  allowScripts(app);
  savePolicy(app.store, app.runtime.owner,
    { rules: [{ tool: "code.run", match: "*", applies: "any", decision: "ask", remember: "session", sandbox: "limits-only" }] });
  const run = await app.runtime.run({ prompt: "run a script", toolCalls: undefined }).catch(() => null);
  assert.ok(run, "the fixture model answers without tools");

  // The gate hands the rule's choice to the card through the same record the socket reads.
  const { run: task } = taskContext(app);
  app.runtime.approvals.ask({ runId: task.id, sessionId: task.sessionId, tool: "code.run", target: "",
    label: "run a small script", question: "Before I go ahead?", source: "owner", remember: "session",
    sandbox: "limits-only", askedAt: new Date().toISOString() });
  assert.equal(app.runtime.approvals.waiting(task.sessionId).at(-1).sandbox, "limits-only");

  // A rule list saved before this field existed still reads back whole, rather than being wiped.
  app.store.save("settings", app.runtime.owner, "policy", { preset: "custom",
    rules: [{ tool: "shell.execute", match: "*", applies: "any", decision: "ask", remember: "session" }],
    limits: { toolCallsPerMinute: 0, modelRoundsPerMinute: 0 } });
  assert.equal(readPolicy(app.store, app.runtime.owner).rules.length, 1, "an old saved policy is not wiped");
  assert.equal(PolicySchema.parse({ rules: [{ decision: "allow" }] }).rules[0].sandbox, undefined);
});

// ---------------------------------------------------------------- A0824 / A1126

/** A hook that answers with whatever verdict the test hands it, and counts how often it was asked. */
function scriptedHook(verdict, { slow = false } = {}) {
  const seen = [];
  return {
    seen,
    runner: async (hook, payload) => {
      seen.push({ hook: hook.id, payload });
      if (slow) await new Promise((resolve) => setTimeout(resolve, hook.timeoutMs + 800).unref?.() ?? setTimeout(resolve, 5));
      return verdict === "fail" ? { ok: false, error: "the check fell over" } : { ok: true, verdict };
    },
  };
}

test("A0824/A1126 a check turns an allow into a question that really stops the task, and into a refusal", async (t) => {
  // The model asks to write a file once, then answers; nothing in the policy holds it back.
  const { app } = await fixture(t, ({ last }) =>
    last?.role === "tool" ? say("written") : call("files.write", { path: "note.txt", content: "hello" }));
  const { context } = taskContext(app, "write a file");

  // Nothing registered: the call goes as the policy said, which is exactly how it behaved before.
  assert.equal(await app.hooks.decide(context.runId, { tool: "files.write" }), null);
  const plain = await app.runtime.run({ prompt: "write the note" });
  assert.equal(plain.status, "completed", "with no check, the write goes ahead");

  const ask = scriptedHook({ decision: "ask", reason: "Finance files are checked with you first." });
  app.hooks.configure([{ id: "finance", event: "tool.before", executable: "checker" }], ask.runner);
  const stopped = await app.runtime.run({ prompt: "write the note again" });
  assert.equal(stopped.status, "needs_input", "the check turned an allow into a question");
  assert.match(stopped.output, /Finance files are checked with you first/);
  assert.equal(ask.seen[0].payload.event, "tool.before", "the hook is told which moment this is");
  assert.equal(ask.seen[0].payload.decision, "allow", "and what the policy had already decided");
  assert.equal(app.store.audit.list(app.runtime.owner).filter((r) => r.action === "hook.blocked")[0].outcome, "held for a yes");
  assert.ok(app.runtime.approvals.waiting(stopped.sessionId).length, "the task is waiting on a real question");

  // A refusal comes back to the model as the check's own words, and is written down.
  const deny = scriptedHook({ decision: "deny", reason: "That folder is off limits." });
  app.hooks.configure([{ id: "guard", event: "tool.before", executable: "checker" }], deny.runner);
  const refused = await app.runtime.run({ prompt: "write it anyway" });
  assert.equal(refused.status, "completed");
  assert.ok(app.store.events(refused.id).some((event) => event.kind === "hook.blocked"), "the refusal is on the task");
  const denied = app.store.events(refused.id).find((event) => event.kind === "policy.denied");
  assert.equal(denied.data.hook, "guard");
  assert.equal(app.store.audit.list(app.runtime.owner).filter((r) => r.action === "hook.blocked")[0].outcome, "refused");
});

test("A0824 a check that says nothing, or falls over, cannot let something through by accident", async (t) => {
  const { app } = await fixture(t);
  const { context } = taskContext(app);
  // A verdict that is not one leaves the decision alone.
  app.hooks.configure([{ id: "quiet", event: "tool.before", executable: "checker" }], scriptedHook({ nonsense: true }).runner);
  assert.equal(await app.hooks.decide(context.runId, { tool: "files.write" }), null);
  // A check that falls over holds the call for a yes, which is what onTimeout says by default.
  app.hooks.configure([{ id: "broken", event: "tool.before", executable: "checker" }], scriptedHook("fail").runner);
  const fallback = await app.hooks.decide(context.runId, { tool: "files.write" });
  assert.equal(fallback.decision, "ask");
  assert.match(fallback.reason, /did not answer in time|being put to you/);
  // Unless the owner said to let it through instead.
  app.hooks.configure([{ id: "broken", event: "tool.before", executable: "checker", onTimeout: "allow" }], scriptedHook("fail").runner);
  assert.equal(await app.hooks.decide(context.runId, { tool: "files.write" }), null);
  // The strictest of several answers wins.
  app.hooks.configure([
    { id: "soft", event: "tool.before", executable: "checker" },
    { id: "hard", event: "tool.before", executable: "checker" },
  ], async (hook) => ({ ok: true, verdict: { decision: hook.id === "hard" ? "deny" : "ask", reason: hook.id } }));
  assert.equal((await app.hooks.decide(context.runId, { tool: "files.write" })).hook, "hard");
});

// ---------------------------------------------------------------- A0638

test("A0638 the terminal says what the conversation has cost and what this one answer cost", async (t) => {
  const { app } = await fixture(t);
  const { statusLine, sessionTotals, runTotals, answerLine, activeModel } = await import("../dist/terminal-commands.js");
  const run = await app.runtime.run({ prompt: "hello" });

  // The running totals were already there: the verification report looked in terminal-tui.ts,
  // where the line is drawn, rather than terminal-commands.ts, where it is worked out.
  const line = statusLine(app.runtime, run.sessionId, "alpha", 120);
  assert.match(line, /[\d.]+k? in \/ [\d.]+k? out/, "tokens are on the status line");
  const totals = sessionTotals(app.runtime, run.sessionId, "a");
  assert.ok(totals.input > 0 || totals.output > 0);

  // What is new: the same reckoning for one answer, printed under it.
  const one = runTotals(app.runtime, run.id, activeModel(app.runtime, "alpha"));
  assert.equal(one.input, totals.input, "one answer in a one-answer conversation is the whole of it");
  assert.match(answerLine(one), /^\[this answer: .* in \/ .* out · .*\]$/);
  assert.equal(answerLine({ input: 0, output: 0, cost: "$0.00" }), "", "nothing counted, nothing said");
  assert.equal(activeModel(app.runtime, "alpha"), "a");
});

// ---------------------------------------------------------------- A1465

test("A1465 Windows is asked before the screen and the microphone, and the answer is a plain sentence", async (t) => {
  const { OsPermissions, capabilityCheck, probeReader } = await import("../dist/os-permissions.js");

  // The decision logic on its own: only an outright refusal stops anything.
  assert.equal(capabilityCheck("microphone", "allowed").allowed, true);
  assert.equal(capabilityCheck("microphone", "unknown").allowed, true, "a computer that cannot say never blocks");
  const refused = capabilityCheck("microphone", "refused");
  assert.equal(refused.allowed, false);
  assert.match(refused.message, /Windows is not letting Branch use the microphone/);
  assert.equal(refused.settingsLink, "ms-settings:privacy-microphone");
  assert.equal(capabilityCheck("camera", "refused").settingsLink, "ms-settings:privacy-webcam");
  assert.equal(capabilityCheck("screen", "refused").settingsLink, "ms-settings:privacy-graphicscaptureprogrammatic");

  // Read through a fake Windows, and kept for a short while rather than asked over and over.
  const asked = [];
  const permissions = new OsPermissions(async (capability) => { asked.push(capability); return capability === "microphone" ? "refused" : "allowed"; }, 1000);
  permissions.now = () => 1_000_000;
  assert.equal((await permissions.check("microphone")).allowed, false);
  assert.equal((await permissions.check("microphone")).allowed, false);
  assert.deepEqual(asked, ["microphone"], "the same question is not put to Windows twice");
  assert.deepEqual((await permissions.all()).map((entry) => entry.allowed), [false, true, true]);
  permissions.forget();
  await permissions.check("microphone");
  assert.equal(asked.length, 4, "after a change of mind it is asked again");

  // The screen has no switch to read, so it is probed; a probe that throws means refused.
  const good = probeReader(async () => 7, async () => "unknown");
  assert.equal(await good("screen"), "allowed");
  const bad = probeReader(async () => { throw new Error("no access"); }, async () => "unknown");
  assert.equal(await bad("screen"), "refused");
  assert.equal(await bad("camera"), "unknown", "the other two are left to the registry");
});

test("A1465 screen control stops with the Windows sentence before it touches anything", async (t) => {
  const { app } = await fixture(t);
  const { OsPermissions } = await import("../dist/os-permissions.js");
  const { context } = taskContext(app);
  app.store.save("settings", app.runtime.owner, "desktop-control", { enabled: true, maxActionsPerRun: 40 });
  app.desktop.permissions = new OsPermissions(async () => "refused");
  await assert.rejects(() => app.desktop.windows({ action: "list" }, context),
    /Windows is not letting Branch take hold of other programs' windows/);
  // Nothing was attempted: the refusal happens before the notice goes up or an action is counted.
  assert.ok(!app.store.events(context.runId).some((event) => event.kind === "desktop.started"));
});

// ---------------------------------------------------------------- A1629

test("A1629 a command nobody has ruled on is asked about, and saying yes settles it for good", async (t) => {
  const { app } = await fixture(t);
  const { evaluatePolicy, readPolicy, savePolicy } = await import("../dist/policy.js");
  const { resourceOf } = await import("../dist/policy-resources.js");
  const command = (target) => ({ tool: "shell.execute", target, readOnly: false, resource: resourceOf("shell.execute", "shell.execute", target, {}) });

  // Out of the box, with no rules at all, a command is a question rather than a guess.
  const fresh = readPolicy(app.store, app.runtime.owner);
  assert.equal(fresh.unmatchedCommands, "ask", "asking is what a fresh install does");
  const asked = evaluatePolicy(fresh, command("rm -rf notes"));
  assert.equal(asked.decision, "ask");
  assert.equal(asked.rule.remember, "always", "so answering it once settles that command for good");

  // Everything else that nothing matches is still simply allowed; only commands changed.
  assert.equal(evaluatePolicy(fresh, { tool: "files.write", target: "a.txt", readOnly: false, resource: { kind: "path", value: "a.txt" } }).decision, "allow");
  assert.equal(evaluatePolicy(fresh, { tool: "web.fetch", target: "example.org", readOnly: true, resource: { kind: "host", value: "example.org" } }).decision, "allow");

  // A rule that does match still decides, whichever way it goes.
  const ruled = savePolicy(app.store, app.runtime.owner,
    { rules: [{ tool: "shell.execute", match: "*", applies: "any", decision: "allow", remember: "session", resource: { kind: "command", pattern: "git" } }] });
  assert.equal(evaluatePolicy(ruled, command("git status")).decision, "allow");
  assert.equal(evaluatePolicy(ruled, command("rm -rf notes")).decision, "ask", "a rule about git says nothing about rm");

  // An owner who would rather have the old behaviour back can say so, and it comes back.
  const back = savePolicy(app.store, app.runtime.owner, { unmatchedCommands: "allow" });
  assert.equal(evaluatePolicy(back, command("rm -rf notes")).decision, "allow");
  assert.equal(back.rules.length, 1, "and the rules they already had are untouched");
});

// ---------------------------------------------------------------- A2006

test("A2006 a child's profile is refused a purchase-class tool and a project outside its grant", async (t) => {
  const { app } = await fixture(t);
  const { grantedCategories, grantRefusal, roleLabels } = await import("../dist/profile-roles.js");
  const roles = app.runtime.roles;

  // The three roles say plainly what each may have Branch do.
  assert.deepEqual(grantedCategories({ role: "child", projects: [], dailySpendLimit: 0 }), ["read"]);
  assert.ok(!grantedCategories({ role: "adult", projects: [], dailySpendLimit: 0 }).includes("spend"));
  assert.ok(grantedCategories({ role: "owner", projects: [], dailySpendLimit: 0 }).includes("settings"));
  assert.match(roleLabels.child.description, /look things up/);

  const child = app.store.profiles.create({ name: "Sam", pin: "1234" });
  roles.save(child.id, { role: "child", projects: [], dailySpendLimit: 2 });
  assert.deepEqual(roles.all([child.id])[0].categories, ["read"]);

  // The owner is never held to any of this.
  assert.equal(app.runtime.checkPolicy("files.write", { path: "a.txt" }, app.runtime.context({ runId: taskContext(app).run.id })).decision, "allow");

  // Switched to the child's profile, a tool that spends money is refused, in their own words.
  app.store.profiles.switch({ profileId: child.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  const { context } = taskContext(app);
  const { categoryOf } = await import("../dist/tool-categories.js");
  assert.equal(categoryOf("payments.charge", "payments.spend"), "spend");
  assert.match(grantRefusal({ role: "child", projects: [], dailySpendLimit: 0 }, "Sam",
    { category: "spend", project: "default", spentToday: 0 }),
    /Sam is set up as "Child" here, which does not cover spend money/);
  const write = app.runtime.checkPolicy("files.write", { path: "a.txt" }, context);
  assert.equal(write.decision, "deny", "a child may not change files either");
  assert.equal(app.runtime.checkPolicy("files.read", { path: "a.txt" }, context).decision, "allow", "but may still look things up");

  // A project outside the grant is refused, whatever the role allows.
  roles.save(child.id, { role: "adult", projects: ["homework"] });
  assert.equal(app.runtime.checkPolicy("files.write", { path: "a.txt" }, context).decision, "deny");
  assert.match(app.runtime.checkPolicy("files.write", { path: "a.txt" }, context).reason,
    /not set up to work in the project "default"/);
  roles.save(child.id, { role: "adult", projects: [] });
  assert.equal(app.runtime.checkPolicy("files.write", { path: "a.txt" }, context).decision, "allow");

  // And a day's allowance that has been used up refuses everything that is not looking.
  assert.match(grantRefusal({ role: "adult", projects: [], dailySpendLimit: 1 }, "Sam",
    { category: "files", project: "default", spentToday: 1.5 }), /used up today's allowance of 1\.00/);
  assert.equal(grantRefusal({ role: "adult", projects: [], dailySpendLimit: 1 }, "Sam",
    { category: "files", project: "default", spentToday: 0.2 }), null);
});

// ---------------------------------------------------------------- A1481

test("A1481 a finished task can be run again with the same words, tools and model, and the two compared", async (t) => {
  const { app, provider } = await fixture(t, ({ last }) =>
    last?.role === "tool" ? say("counted") : call("files.write", { path: "n.txt", content: "one" }));
  const { replayPlan, replayRun } = await import("../dist/replay.js");
  const { inspectRun } = await import("../dist/inspect.js");
  app.store.save("settings", app.runtime.owner, "policy", { preset: "custom", rules: [], limits: {}, unmatchedCommands: "allow" });

  const first = await app.runtime.run({ prompt: "write the note", permissions: ["files.write", "files.read"] });
  assert.equal(first.status, "completed");

  // What the task was is read back off its own record, not guessed at.
  const plan = replayPlan(app.store, first.id);
  assert.equal(plan.prompt, "write the note");
  assert.deepEqual(plan.permissions, ["files.read", "files.write"], "the very same tools it had");
  assert.equal(plan.model, "alpha");

  const before = provider.requests.length;
  const again = await replayRun(app.runtime, app.store, first.id);
  assert.equal(again.original, first.id);
  assert.notEqual(again.replay, first.id);
  assert.ok(provider.requests.length > before, "the model really was asked again");
  assert.notEqual(app.store.run(again.replay).sessionId, first.sessionId, "in a conversation of its own");
  assert.equal(app.store.run(again.replay).prompt, "write the note");
  assert.ok(app.store.events(again.replay).some((event) => event.kind === "run.replayed"));
  const permissionsUsed = app.store.events(again.replay).find((event) => event.kind === "run.started").data.permissions;
  assert.deepEqual(permissionsUsed, ["files.read", "files.write"]);

  // Both tasks answer the same "Look inside" question, which is what the side-by-side screen reads.
  for (const runId of [again.original, again.replay]) {
    const view = inspectRun(app.store, runId, { receipts: { items: [], counts: {} }, timeline: null, cost: null, version: "test" });
    assert.equal(view.run.prompt, "write the note");
    assert.ok(view.rounds.length >= 1);
  }
  await assert.rejects(async () => replayPlan(app.store, "00000000-0000-4000-8000-000000000000"), /no task with that number/);
});

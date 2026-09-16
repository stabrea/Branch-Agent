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
function scripted(name) {
  const provider = {
    name, requests: [],
    async complete(request) { provider.requests.push(request); return { content: `${name} answered`, toolCalls: [] }; },
  };
  return provider;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-reopened-"));
  const alpha = scripted("alpha");
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider: alpha, model: "a" }],
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, root, alpha };
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

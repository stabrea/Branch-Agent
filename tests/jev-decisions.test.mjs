import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/store.js";
import { ToolRegistry } from "../dist/registry.js";
import { switchedToolTiers } from "../dist/feature-switches.js";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";
import {
  JevDecisions, JevDecisionInputSchema, jevSettings, registerJevDecisions, saveJevSettings,
} from "../dist/jev-decisions.js";

const owner = "local";
const envelope = (answer) => JSON.stringify({
  model: "jev-1.13.0", id: "decision-1", provider: "typesafe", answer,
  usage: { input_tokens: 42, output_tokens: 0, cost: 0.0000018 },
});

function fixture(t, answer, code = 0) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const calls = [];
  const runner = async (command, args, state) => {
    calls.push({ command, args, state });
    return { code, stdout: envelope(answer), stderr: "" };
  };
  return { store, calls, decisions: new JevDecisions(store, owner, runner) };
}

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-jev-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (method, body, token = server.token) => {
    const response = await fetch(server.url + "/api/jev", { method, headers: {
      authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return { app, call };
}

test("JEV ships off and cannot send state until the owner enables it", async (t) => {
  const { store, calls, decisions } = fixture(t, { type: "noul", noul: 0.9, yes: true });
  assert.equal(jevSettings(store, owner).mode, "off");
  await assert.rejects(() => decisions.decide({ kind: "yes", question: "Is it urgent?", state: "private" }),
    /switched off/i);
  assert.equal(calls.length, 0);
});

test("only the owner can read or save strict JEV settings", async (t) => {
  const { app, call } = await served(t);
  const initial = await call("GET");
  assert.equal(initial.status, 200);
  assert.equal(initial.body.mode, "off");
  assert.equal("apiKey" in initial.body, false, "Branch never asks for or returns a JEV credential");
  const settings = { mode: "when-needed", command: "wsl.exe", args: ["--exec", "jev"], provider: "typesafe",
    model: "jev-1.13.0", timeoutMs: 4000, retries: 1, minConfidence: 0.84 };
  assert.deepEqual((await call("POST", settings)).body, settings);
  assert.equal((await call("POST", { ...settings, apiKey: "not-accepted" })).status, 400);
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run" }).token;
  assert.equal((await call("GET", undefined, key)).status, 401, "a short-lived key cannot discover the command or provider");
  const person = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: person.id, pin: "2468" });
  assert.equal((await call("GET")).status, 400, "a household profile cannot read the owner's JEV setup");
  assert.equal((await call("POST", settings)).status, 400, "a household profile cannot change the owner's JEV setup");
});

test("the JEV tool is hidden off, available when needed, and preloaded only on", (t) => {
  const { store, decisions } = fixture(t, { type: "noul", noul: 0.9, yes: true });
  const registry = new ToolRegistry();
  registerJevDecisions(registry, decisions);
  const names = registry.names();
  assert.deepEqual(switchedToolTiers(store, owner, names).hidden, ["decisions.judge"]);
  saveJevSettings(store, owner, { ...jevSettings(store, owner), mode: "when-needed" });
  assert.deepEqual(switchedToolTiers(store, owner, names), { preload: [], hidden: [] });
  saveJevSettings(store, owner, { ...jevSettings(store, owner), mode: "on" });
  assert.deepEqual(switchedToolTiers(store, owner, names).preload.map((entry) => entry.name), ["decisions.judge"]);
});

test("a yes decision sends only state on stdin and returns a confidence gate", async (t) => {
  const { store, calls, decisions } = fixture(t, { type: "noul", noul: 0.93, yes: true });
  saveJevSettings(store, owner, { mode: "when-needed", command: "jev", provider: "typesafe",
    timeoutMs: 4000, retries: 0, minConfidence: 0.8 });
  const result = await decisions.decide({ kind: "yes", question: "Is this a refund request?",
    state: "Refund me", true: "asks for money back", false: "does not ask for money back" });
  assert.equal(result.verdict, "yes");
  assert.equal(result.gate, "ready");
  assert.equal(result.confidence, 0.93);
  assert.equal(calls[0].command, "jev");
  assert.equal(calls[0].state, "Refund me");
  assert.ok(calls[0].args.includes("-s") && calls[0].args.includes("-"));
  assert.ok(calls[0].args.includes("--json") && calls[0].args.includes("typesafe"));
  assert.ok(!calls[0].args.includes("Refund me"), "personal state is never put in the process list");
});

test("a low-confidence pick is returned for review rather than promoted to an action", async (t) => {
  const answer = { type: "choice", choice: "code", confidence: 0.61,
    probabilities: { code: 0.61, research: 0.39 } };
  const { store, calls, decisions } = fixture(t, answer);
  saveJevSettings(store, owner, { mode: "on", command: "jev", provider: "auto",
    timeoutMs: 5000, retries: 1, minConfidence: 0.8 });
  const result = await decisions.decide({ kind: "pick", question: "Who should handle this?", state: "Fix the parser",
    options: [{ name: "code", description: "write or change code" },
      { name: "research", description: "needs web research" }], other: true });
  assert.equal(result.choice, "code");
  assert.equal(result.gate, "review");
  assert.deepEqual(result.probabilities, { code: 0.61, research: 0.39 });
  assert.ok(calls[0].args.includes("code=write or change code"));
  assert.ok(calls[0].args.includes("--other"));
  assert.ok(!calls[0].args.includes("--provider"), "auto lets JEV use its owner-configured provider");
});

test("a provider cannot return a choice or score outside the declared decision", async (t) => {
  const pick = fixture(t, { type: "choice", choice: "delete", confidence: 0.99,
    probabilities: { code: 0.01, delete: 0.99 } });
  saveJevSettings(pick.store, owner, { ...jevSettings(pick.store, owner), mode: "on" });
  await assert.rejects(() => pick.decisions.decide({ kind: "pick", question: "Who should handle this?",
    state: "Fix it", options: [{ name: "code", description: "write code" },
      { name: "research", description: "research" }] }), /choice that was not offered/i);

  const score = fixture(t, { type: "score", score: 8, confidence: 0.99,
    probabilities: { 0: 0.01, 1: 0.99 }, label: "critical" });
  saveJevSettings(score.store, owner, { ...jevSettings(score.store, owner), mode: "on" });
  await assert.rejects(() => score.decisions.decide({ kind: "score", question: "How risky?",
    state: "Routine change", labels: ["low", "high"] }), /score outside the offered range/i);
});

test("score labels are bounded and ordered before a process can start", () => {
  const parsed = JevDecisionInputSchema.safeParse({ kind: "score", question: "How risky?", state: "x", labels: ["low"] });
  assert.equal(parsed.success, false);
  const tooMany = JevDecisionInputSchema.safeParse({ kind: "score", question: "How risky?", state: "x",
    labels: Array.from({ length: 11 }, (_, i) => String(i)) });
  assert.equal(tooMany.success, false);
});

test("model-written decision text cannot turn into JEV command options", () => {
  for (const input of [
    { kind: "yes", question: "--provider=openrouter", state: "x" },
    { kind: "yes", question: "Is it urgent?", state: "x", true: "--provider=openrouter" },
    { kind: "score", question: "How risky?", state: "x", labels: ["low", "--provider=openrouter"] },
  ]) assert.equal(JevDecisionInputSchema.safeParse(input).success, false);
});

test("a no result may exit one and malformed output never becomes a decision", async (t) => {
  const no = fixture(t, { type: "noul", noul: 0.08, yes: false }, 1);
  saveJevSettings(no.store, owner, { mode: "on", command: "jev", provider: "auto",
    timeoutMs: 5000, retries: 0, minConfidence: 0.8 });
  assert.equal((await no.decisions.decide({ kind: "yes", question: "Is it urgent?", state: "No rush" })).verdict, "no");

  const store = new Store(":memory:");
  t.after(() => store.close());
  saveJevSettings(store, owner, { mode: "on", command: "jev", provider: "auto",
    timeoutMs: 5000, retries: 0, minConfidence: 0.8 });
  const broken = new JevDecisions(store, owner, async () => ({ code: 0, stdout: "not json", stderr: "" }));
  await assert.rejects(() => broken.decide({ kind: "yes", question: "Is it urgent?", state: "secret state" }),
    /could not read JEV's JSON/i);
});

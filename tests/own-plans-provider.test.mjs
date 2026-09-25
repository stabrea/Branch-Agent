/**
 * NAS's review of own plans (e3b9bd67): three LOWs, each pinned here on the pool's own router with stand-in plans.
 *   - a plan whose sign-in is refused, behind a default at its limit, rests and the next own plan answers;
 *   - a record with sharing off never moves between own plans, whatever `ownPlans` says;
 *   - the turn that finds the pick at its limit is the one that replaces it.
 * Nothing reaches a provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AccountPoolProvider } from "../dist/accounts/pool-provider.js";
import { withAccountCall } from "../dist/accounts/context.js";
import { ProviderHttpError } from "../dist/provider-retry.js";

const at = "2026-09-25T10:00:00.000Z";
const account = (id) => ({ id, label: id, pinned: false, disabled: false, monthlyCapUsd: null, shared: false, keptSeparate: false, createdAt: at });

/** A pool of three own plans and a router whose plans answer as `outcomes` says ("ok", "limit" or "refused"). */
function router(pool, outcomes) {
  const asked = [], choices = new Map();
  const plan = (id) => ({ name: id, async complete() {
    asked.push(id);
    if (outcomes[id] === "limit") throw new ProviderHttpError(429, 60_000, "rate_limit_exceeded");
    if (outcomes[id] === "refused") throw new ProviderHttpError(401, undefined, "invalid_api_key");
    return { content: `from ${id}`, toolCalls: [] };
  } });
  const provider = new AccountPoolProvider(plan("original"), {
    owner: "local", pool: "chatgpt", model: "gpt-6-sol", settings: () => pool, states: new Map(), cursor: { value: 0 },
    providerFor: async (id) => plan(id), capReached: () => false, record: () => {}, personIsNotOwner: () => false,
    sessionChoice: (session) => choices.get(session) ?? null, rememberChoice: (session, id) => choices.set(session, id), now: () => Date.parse(at),
  });
  const ask = (sessionId) => withAccountCall({ sessionId }, () => provider.complete({ messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal }));
  return { ask, asked, choices };
}
const pool = (extra) => ({ pool: "chatgpt", kind: "sign-in", strategy: "priority", autoSwitch: true, ownPlans: true, defaultAccount: "one",
  accounts: [account("one"), account("two"), account("three")], ...extra });

test("with own plans on, a plan whose sign-in is refused behind a limited default rests, and the next plan answers", async () => {
  const { ask, asked } = router(pool(), { one: "limit", two: "refused" });
  assert.equal((await ask("s1")).content, "from three");
  assert.equal((await ask("s2")).content, "from three", "the refused plan rests, so it is not asked on every call");
  assert.deepEqual(asked, ["one", "two", "three", "three"]);
});

test("with own plans off, a refused sign-in is still said as it is, not passed over", async () => {
  const { ask } = router(pool({ ownPlans: false, accounts: [account("one"), { ...account("two"), keptSeparate: true }] }), { one: "refused" });
  await assert.rejects(ask("s1"), (error) => error.status === 401);
});

test("a record with sharing off never moves between own plans, whatever ownPlans says", async () => {
  const { ask, asked } = router(pool({ autoSwitch: false }), { one: "limit" });
  await assert.rejects(ask("s1"), /does not move your work between your own plans/, "it never offers the owner's other plans");
  assert.deepEqual(asked, ["one"], "only the default was asked");
});

test("the turn that finds the picked plan at its limit replaces the pick with the plan that answered", async () => {
  const { ask, choices } = router(pool(), { two: "limit" });
  choices.set("s1", "two");
  assert.equal((await ask("s1")).content, "from one");
  assert.equal(choices.get("s1"), "one", "replaced on this turn, not the next");
});

// NAS 61f58fb (MAJOR): the owner switches sharing, or own plans, off while the picked plan is still answering, and that
// plan then reaches its limit. The work must not move on, and the pick must not change.
for (const off of [{ autoSwitch: false }, { ownPlans: false }]) {
  test(`switching ${Object.keys(off)[0]} off during a call stops the work moving to another own plan`, async () => {
    const saved = pool();
    const asked = [], choices = new Map([["s1", "one"]]);
    const plan = (id) => ({ name: id, async complete() {
      asked.push(id);
      if (id === "one") { Object.assign(saved, off); throw new ProviderHttpError(429, 60_000, "rate_limit_exceeded"); }
      return { content: `from ${id}`, toolCalls: [] };
    } });
    const provider = new AccountPoolProvider(plan("original"), {
      // NAS c6feb33: a fresh copy on every read, as the real settings hook parses one, so the re-read itself is tested.
      owner: "local", pool: "chatgpt", model: "gpt-6-sol", settings: () => structuredClone(saved), states: new Map(), cursor: { value: 0 },
      providerFor: async (id) => plan(id), capReached: () => false, record: () => {}, personIsNotOwner: () => false,
      sessionChoice: (session) => choices.get(session) ?? null, rememberChoice: (session, id) => choices.set(session, id), now: () => Date.parse(at),
    });
    await assert.rejects(withAccountCall({ sessionId: "s1" }, () => provider.complete({ messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal })),
      Object.keys(off)[0] === "autoSwitch" ? /The account "one" has reached its plan limit/ : /./);
    assert.deepEqual(asked, ["one"], "no other plan was asked");
    assert.equal(choices.get("s1"), "one", "the pick stays");
  });
}

// NAS's review (p202): a program is signed out only by its own words about its sign-in, not a task's text quoting another.
test("a program counts as signed out only by its own words, never by a task's text that quotes another program", async () => {
  const { CliAgentProvider, cliAgentCatalog } = await import("../dist/providers/cli-agent.js");
  const claude = cliAgentCatalog.find((row) => row.id === "claude-code");
  const stopped = async (outcome) => {
    const provider = new CliAgentProvider(claude, {}, async () => ({ code: 1, stdout: "", stderr: "", ...outcome }), { name: "CLAUDE_CONFIG_DIR", path: "/tmp/second" });
    return provider.complete({ messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal }).then(() => null, (error) => error.name);
  };
  assert.equal(await stopped({ stderr: "Not logged in · Please run /login" }), "ProgramSignInError");
  // Claude Code's own JSON result when it is signed out, and Codex's error event (NAS c6feb33).
  assert.equal(await stopped({ stdout: JSON.stringify({ type: "result", is_error: true, result: "Invalid API key · Please run /login" }) }), "ProgramSignInError");
  assert.equal(await stopped({ stdout: `${JSON.stringify({ type: "thread.started" })}
${JSON.stringify({ type: "error", message: "Not logged in. Please run /login" })}` }), "ProgramSignInError");
  // Codex's turn.failed comes last, after however many events (NAS 5606f75); it is read.
  const events = Array.from({ length: 450 }, (_, n) => JSON.stringify({ type: "item.completed", n })).join(String.fromCharCode(10));
  const failed = JSON.stringify({ type: "turn.failed", error: { message: "Not logged in. Please run /login" } });
  assert.equal(await stopped({ stdout: events + String.fromCharCode(10) + failed }), "ProgramSignInError");
  assert.equal(await stopped({ stdout: "Invalid API key · Please run /login" }), "ProgramSignInError", "a one-line plain answer about itself");
  assert.notEqual(await stopped({ stdout: JSON.stringify({ result: "git push said: Authentication failed for origin" }) }), "ProgramSignInError");
  assert.notEqual(await stopped({ stdout: '{"type":"item","text":"You are not logged into any GitHub hosts. Run gh auth login"}' }), "ProgramSignInError");
  assert.notEqual(await stopped({ stderr: "MCP server github: authentication failed (500)" }), "ProgramSignInError");
  assert.notEqual(await stopped({ stdout: JSON.stringify({ result: "The README says: please run /login before you start." }) }), "ProgramSignInError",
    "the task's own answer quoting the words is not the program speaking");
});

// Q247 (NAS c6feb33): a plan's limit is the program's own words too, never a task's text or a tool's output.
test("a program is at its plan limit only by its own words, never by a task's text that mentions a rate limit", async () => {
  const { CliAgentProvider, cliAgentCatalog } = await import("../dist/providers/cli-agent.js");
  const claude = cliAgentCatalog.find((row) => row.id === "claude-code");
  const stopped = async (outcome) => {
    const provider = new CliAgentProvider(claude, {}, async () => ({ code: 1, stdout: "", stderr: "", ...outcome }), { name: "CLAUDE_CONFIG_DIR", path: "/tmp/second" });
    return provider.complete({ messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal }).then(() => null, (error) => error.name);
  };
  assert.equal(await stopped({ stderr: "Claude usage limit reached. Your limit resets at 3pm." }), "ProgramLimitError");
  assert.equal(await stopped({ stdout: JSON.stringify({ type: "result", is_error: true, result: "Claude AI usage limit reached|1790370000" }) }), "ProgramLimitError");
  assert.equal(await stopped({ stdout: JSON.stringify({ type: "error", message: "You've hit your usage limit. Try again later." }) }), "ProgramLimitError");
  assert.notEqual(await stopped({ stdout: "Updated src/rate limit.ts: the usage limit check now counts retries.\nAll 3 tests pass." }), "ProgramLimitError");
  assert.notEqual(await stopped({ stdout: `${JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "HTTP 429 Too Many Requests" } })}\n${JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected" } })}` }), "ProgramLimitError");
});

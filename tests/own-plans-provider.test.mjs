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

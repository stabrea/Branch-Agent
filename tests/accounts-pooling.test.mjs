/**
 * mac7/account-pooling (owner decision 2026-09-19): Branch never moves one person's work between
 * their own identical sign-in plans to get past a limit. Work moves only between API keys, and
 * between sign-in accounts the owner marked "kept separate" (someone else's, or work's) plus at most
 * one of the owner's own. Every service is a stand-in; nothing reaches a provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import {
  AccountsSettingsSchema, applyPoolingRule, poolingRuleVersion, saveAccountsSettings, sessionChoice,
} from "../dist/accounts/settings.js";
import { firstChoice, rotationSet } from "../dist/accounts/pool.js";
import {
  addAccount, dismissNotice, setMode, switchAccount, updateAccount, updatePool, viewAll,
} from "../dist/accounts/manage.js";
import { executeCommand } from "../dist/commands/execute.js";
import { saveCommandSettings } from "../dist/commands/settings.js";

const POOL = "cli-claude-code";
const at = "2026-09-19T10:00:00.000Z";
const acct = (id, extra = {}) => ({
  id, label: extra.label ?? id, pinned: false, disabled: false, monthlyCapUsd: null, shared: false, keptSeparate: false, createdAt: at, ...extra,
});
const ids = (accounts) => accounts.map((account) => account.id);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-pooling-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models);
  let clock = Date.parse("2026-09-19T10:00:00Z");
  service.deps.now = () => clock;
  Object.defineProperty(service, "now", { value: () => clock });
  return { app, service, owner: app.runtime.owner, root };
}
const limited = { code: 1, stdout: "", stderr: "Claude usage limit reached. Your limit resets at 3pm." };
const answer = (text) => ({ code: 0, stdout: JSON.stringify({ result: text }), stderr: "" });
/** The installed Claude Code program, answered by a stand-in per account folder. */
function program(fx, outcomes) {
  const seen = [];
  const spawn = async (row, prompt, signal, limits, home) => {
    const who = home ? home.path.split(/[\\/]/).pop() : "primary";
    seen.push(who);
    return outcomes[who] ?? answer(`from ${who}`);
  };
  registerCliAgent(fx.app.runtime.models, { id: "claude-code" }, {}, spawn);
  fx.app.runtime.models.configure(fx.owner, { activePreset: POOL });
  fx.service.deps.spawnAgent = spawn;
  return seen;
}
/** The owner's own two plans ("primary", "Second") and a work account ("Work"), with sharing on. */
async function threeAccounts(fx) {
  setMode(fx.service, { mode: "on" });
  const second = (await addAccount(fx.service, { pool: POOL, label: "Second" })).accounts.at(-1).id;
  const work = (await addAccount(fx.service, { pool: POOL, label: "Work" })).accounts.at(-1).id;
  updatePool(fx.service, { pool: POOL, autoSwitch: true });
  await updateAccount(fx.service, { pool: POOL, account: work, keptSeparate: true });
  return { second, work };
}

test("P1 which accounts may share work: at most one of the owner's own sign-ins, plus those kept separate", () => {
  const A = acct("aaaaaaaa"), B = acct("bbbbbbbb"), C = acct("cccccccc", { keptSeparate: true });
  const D = acct("dddddddd", { keptSeparate: true, disabled: true }), P = acct("eeeeeeee", { pinned: true });
  const off = acct("ffffffff", { disabled: true });
  const cases = [
    { name: "API keys all rotate", kind: "api-key", usable: [A, B, P], def: null, sticky: null, want: [A, B, P] },
    { name: "two own plans: only the first", kind: "cli", usable: [A, B], def: null, sticky: null, want: [A] },
    { name: "two own plans on ChatGPT: only the first", kind: "chatgpt", usable: [A, B], def: null, sticky: null, want: [A] },
    { name: "the owner's default is their one", kind: "cli", usable: [A, B, C], def: B.id, sticky: null, want: [B, C] },
    { name: "the conversation's own pick beats the default", kind: "cli", usable: [A, B, C], def: B.id, sticky: A.id, want: [A, C] },
    { name: "a kept-separate pick leaves the default as the own one", kind: "cli", usable: [A, B, C], def: B.id, sticky: C.id, want: [B, C] },
    { name: "pinned before first", kind: "cli", usable: [A, P, C], def: null, sticky: null, want: [P, C] },
    { name: "a switched-off default falls to the pinned one", kind: "cli", usable: [off, A, P], def: off.id, sticky: null, want: [P] },
    { name: "every account kept separate: all of them", kind: "chatgpt", usable: [C, D], def: null, sticky: null, want: [C, D] },
    { name: "no own account switched on: only those kept separate", kind: "cli", usable: [off, C], def: null, sticky: null, want: [C] },
  ];
  for (const c of cases) assert.deepEqual(ids(rotationSet(c.kind, c.usable, c.def, c.sticky)), ids(c.want), c.name);
  assert.equal(firstChoice([off, A], [off.id]).id, A.id, "a switched-off pick is passed over");
});

test("P1b for every mix of accounts, picks and limits, never two of the owner's own sign-ins", () => {
  const pool = [acct("aaaaaaaa"), acct("bbbbbbbb", { pinned: true }), acct("cccccccc", { disabled: true }),
    acct("dddddddd", { keptSeparate: true }), acct("eeeeeeee", { keptSeparate: true, pinned: true })];
  let checked = 0;
  for (let mask = 1; mask < 1 << pool.length; mask++) {
    const usable = pool.filter((_, index) => mask & (1 << index));
    for (const def of [null, ...ids(pool)]) for (const sticky of [null, ...ids(pool)]) for (const kind of ["cli", "chatgpt"]) {
      const set = rotationSet(kind, usable, def, sticky);
      assert.ok(set.filter((account) => !account.keptSeparate).length <= 1, JSON.stringify({ mask, def, sticky }));
      assert.ok(usable.filter((a) => a.keptSeparate).every((a) => set.includes(a)), "every kept-separate account may share");
      checked++;
    }
  }
  assert.ok(checked > 1000);
});

test("P2 bringing a saved list up to the rule: only lists that shared between the owner's own plans stop", () => {
  const base = (pools, extra = {}) => AccountsSettingsSchema.parse({ mode: "on", pools, poolingRule: 0, ...extra });
  const pool = (name, kind, accounts, extra = {}) => ({ pool: name, kind, accounts, autoSwitch: kind !== "api-key", ...extra });
  const two = [acct("primary"), acct("bbbbbbbb")];
  const cases = [
    { name: "API keys are left alone", pools: [pool("openai", "api-key", two)], stopped: [] },
    { name: "sharing off is left alone", pools: [pool("chatgpt", "chatgpt", two, { autoSwitch: false })], stopped: [] },
    { name: "one own plan and one kept separate is allowed", pools: [pool(POOL, "cli", [acct("primary"), acct("bbbbbbbb", { keptSeparate: true })])], stopped: [] },
    { name: "two own plans stop", pools: [pool(POOL, "cli", two)], stopped: [POOL], def: "primary" },
    { name: "the owner's own default is kept", pools: [pool("chatgpt", "chatgpt", two, { defaultAccount: "bbbbbbbb" })], stopped: ["chatgpt"], def: "bbbbbbbb" },
  ];
  for (const c of cases) {
    const { settings, stopped } = applyPoolingRule(base(c.pools));
    assert.deepEqual(stopped, c.stopped, c.name);
    assert.equal(settings.poolingRule, poolingRuleVersion, c.name);
    assert.deepEqual(settings.poolingNotices, c.stopped, c.name);
    if (c.stopped.length) {
      assert.equal(settings.pools[0].autoSwitch, false, c.name);
      assert.equal(settings.pools[0].defaultAccount, c.def, c.name);
      assert.equal(settings.pools[0].accounts.some((account) => account.keptSeparate), false, "nothing is marked kept separate for them");
    } else assert.deepEqual(settings.pools, base(c.pools).pools, c.name);
  }
  const done = base([pool(POOL, "cli", two)], { poolingRule: poolingRuleVersion });
  assert.equal(applyPoolingRule(done).settings, done, "a list already under the rule is left exactly as it is");
  const again = applyPoolingRule(base([pool(POOL, "cli", two)], { poolingNotices: [POOL] }));
  assert.deepEqual(again.settings.poolingNotices, [POOL], "one notice per list");
});

test("P3 at start: an old list stops once, with a notice and a record; new, missing and damaged lists are left alone", async (t) => {
  const fx = await fixture(t);
  const { app, owner, service } = fx;
  program(fx, {});
  assert.deepEqual(service.applyPoolingRule(), [], "nothing saved: nothing written");
  assert.ok(!app.store.get("settings", owner, "accounts"));
  assert.equal(service.settings().poolingRule, poolingRuleVersion, "a list never saved starts under the rule");
  app.store.save("settings", owner, "accounts", { mode: "sideways" });
  assert.deepEqual(service.applyPoolingRule(), []);
  assert.deepEqual(app.store.get("settings", owner, "accounts").data, { mode: "sideways" }, "a damaged record is not overwritten");
  // A list saved before the rule: no poolingRule field, sharing on between two own plans.
  app.store.save("settings", owner, "accounts", { mode: "on", pools: [{ pool: POOL, kind: "cli", autoSwitch: true,
    accounts: [acct("primary", { label: "Mine" }), acct("bbbbbbbb", { label: "Also mine" })] }] });
  assert.deepEqual(service.applyPoolingRule(), [POOL]);
  assert.deepEqual(service.applyPoolingRule(), [], "once only");
  const saved = service.settings();
  assert.equal(saved.pools[0].autoSwitch, false);
  assert.equal(saved.pools[0].defaultAccount, "primary");
  assert.ok(app.store.audit.list(owner).some((row) => row.action === "connection.changed" && row.subject === POOL && /own sign-ins/.test(row.reason)));
  const view = (await viewAll(service)).pools.find((pool) => pool.pool === POOL);
  assert.equal(view.notice.key, "accounts.notice.own-plans");
  assert.match(view.notice.text, /no longer switches between your own .* plans/);
  // A list made under the rule never gets the notice, even with sharing on between two own plans.
  saveAccountsSettings(app.store, owner, AccountsSettingsSchema.parse({ mode: "on", poolingRule: poolingRuleVersion,
    pools: [{ pool: POOL, kind: "cli", autoSwitch: true, accounts: [acct("primary"), acct("bbbbbbbb")] }] }));
  assert.deepEqual(service.applyPoolingRule(), []);
  assert.equal(service.settings().pools[0].autoSwitch, true, "the owner's own later choice stands");
});

test("P4 with sharing on, work moves from the owner's plan to the work account and never to their other plan", async (t) => {
  const fx = await fixture(t);
  const { app, owner, service } = fx;
  const seen = program(fx, { primary: limited });
  const { second, work } = await threeAccounts(fx);
  const moved = await app.runtime.run({ prompt: "hello" });
  assert.equal(moved.output, `from ${work}`);
  assert.equal(sessionChoice(app.store, owner, moved.sessionId)[POOL], work, "only an allowed account is remembered");
  for (let tries = 0; tries < 4; tries++) await app.runtime.run({ prompt: "again", ...(tries % 2 ? { sessionId: moved.sessionId } : {}) });
  assert.ok(!seen.includes(second), "the owner's second plan is never used by itself");
  // The work account runs out too: the task stops and suggests nothing of the owner's own.
  service.deps.spawnAgent = async (row, prompt, signal, limits, home) => {
    const who = home ? home.path.split(/[\\/]/).pop() : "primary";
    seen.push(who);
    return limited;
  };
  service.dropBuilt(POOL, work);
  service.statesOf(POOL).delete(work);
  const stopped = await app.runtime.run({ prompt: "more" });
  assert.equal(stopped.status, "failed");
  assert.match(stopped.output, /may share work between has reached its plan limit/);
  assert.match(stopped.output, /does not move your work between your own plans/);
  assert.ok(!stopped.output.includes("Second"));
  assert.ok(!seen.includes(second), "still never the second plan");
  // With the mark taken off, the work account is one of the owner's own too and nothing moves.
  await updateAccount(service, { pool: POOL, account: work, keptSeparate: false });
  service.statesOf(POOL).clear();
  service.deps.spawnAgent = async () => limited;
  const none = await app.runtime.run({ prompt: "last" });
  assert.equal(none.status, "failed");
});

test("P5 with sharing off, the limit sentence names only an account kept separate", async (t) => {
  const fx = await fixture(t);
  const { app, service } = fx;
  program(fx, { primary: limited });
  const { work } = await threeAccounts(fx);
  updatePool(service, { pool: POOL, autoSwitch: false });
  const stopped = await app.runtime.run({ prompt: "hello" });
  assert.equal(stopped.status, "failed");
  assert.match(stopped.output, /does not switch sign-in accounts by itself.*\/account Work.*available: "Work"\)/);
  assert.ok(!stopped.output.includes("Second"));
  await assert.rejects(updateAccount(service, { pool: POOL, account: work, keptSeparate: "yes" }), { name: "ZodError" });
});

test("P6 the mark and the notice are the owner's: routes, /account, household and short-lived keys", async (t) => {
  const fx = await fixture(t);
  const { app, owner, service } = fx;
  program(fx, {});
  saveCommandSettings(app.store, owner, { mode: "on" });
  setMode(service, { mode: "on" });
  const second = (await addAccount(service, { pool: POOL, label: "Second" })).accounts.at(-1).id;
  const settings = service.settings();
  saveAccountsSettings(app.store, owner, { ...settings, poolingNotices: [POOL] });
  const server = await startServer(app, { dataDir: join(fx.root, "data"), port: 0 });
  t.after(() => server.close());
  const run = app.sessionTokens.create(owner, { name: "script", scope: "run" }).token;
  const call = async (path, key, body) => (await fetch(server.url + path, { method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) })).status;
  assert.equal(await call("/api/accounts/update", run, { pool: POOL, account: second, keptSeparate: true }), 401);
  assert.equal(await call("/api/accounts/notice", run, { pool: POOL }), 401);
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  assert.ok(await call("/api/accounts/update", server.token, { pool: POOL, account: second, keptSeparate: true }) >= 400, "a household person cannot mark the owner's account");
  assert.ok(await call("/api/accounts/notice", server.token, { pool: POOL }) >= 400);
  assert.equal((await viewAll(service)).pools.find((pool) => pool.pool === POOL).notice, null, "the notice is the owner's to read");
  app.store.profiles.switch({ profileId: null });
  assert.equal(service.settings().pools[0].accounts.find((a) => a.id === second).keptSeparate, false);
  // /account: the notice once, then the mark on and off; from a phone with a "run" key it is refused.
  const host = { runtime: app.runtime, requireOwner: (what) => app.store.profiles.requireOwner(what) };
  const looked = await executeCommand(host, { surface: "dashboard", line: "/account", access: "read" });
  assert.match(looked.text, /no longer switches between your own/);
  assert.deepEqual(service.settings().poolingNotices, [POOL], "a read-only look leaves the notice for the owner");
  const listed = await executeCommand(host, { surface: "window", line: "/account", access: "full" });
  assert.match(listed.text, /no longer switches between your own/);
  assert.doesNotMatch((await executeCommand(host, { surface: "window", line: "/account", access: "full" })).text, /no longer switches/);
  const refused = await executeCommand(host, { surface: "phone", line: "/account separate Second", access: "run" });
  assert.ok(refused.refused);
  const marked = await executeCommand(host, { surface: "window", line: "/account separate second", access: "full" });
  assert.match(marked.text, /"Second" is now kept separate/);
  assert.match((await executeCommand(host, { surface: "window", line: "/account", access: "full" })).text, /Second \(kept separate\)/);
  const unmarked = await executeCommand(host, { surface: "window", line: "/account not-separate Second", access: "full" });
  assert.match(unmarked.text, /no longer kept separate/);
  assert.equal(service.settings().pools[0].accounts.find((a) => a.id === second).keptSeparate, false);
  assert.equal(await call("/api/accounts/update", server.token, { pool: POOL, account: second, keptSeparate: true }), 200);
  assert.equal(await call("/api/accounts/notice", server.token, { pool: POOL }), 200);
  assert.deepEqual(dismissNotice(service, { pool: POOL }), { pool: POOL, dismissed: true });
});

test("P7 API keys take no mark: they already share work", async (t) => {
  const fx = await fixture(t);
  const { app, owner, service } = fx;
  app.store.save("settings", owner, "model-connections", { connections: [{ id: "openai-pool", name: "OpenAI", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  app.runtime.models.register({ id: "openai-pool", name: "OpenAI", model: "gpt-4o-mini", catalogId: "openai",
    provider: { name: "openai-chat", complete: async () => ({ content: "first", toolCalls: [] }) } });
  setMode(service, { mode: "on" });
  updatePool(service, { pool: "openai-pool", strategy: "priority" });
  await assert.rejects(updateAccount(service, { pool: "openai-pool", account: "primary", keptSeparate: true }), /API keys already share work/);
});

test("P8 a conversation switched by hand to the owner's second plan never reaches their first plan through the work account", async (t) => {
  const fx = await fixture(t);
  const { app, owner, service } = fx;
  let workAnswers = 1;
  const seen = [];
  const spawn = async (row, prompt, signal, limits, home) => {
    const who = home ? home.path.split(/[\\/]/).pop() : "primary";
    seen.push(who);
    if (who === ids.second) return limited;
    if (who === ids.work) return workAnswers-- > 0 ? answer("from work") : limited;
    return answer("from primary");
  };
  const ids = {};
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, spawn);
  app.runtime.models.configure(owner, { activePreset: POOL });
  service.deps.spawnAgent = spawn;
  Object.assign(ids, await threeAccounts(fx));
  const opened = await app.runtime.run({ prompt: "hello" });
  assert.equal(opened.output, "from primary");
  switchAccount(service, { pool: POOL, account: ids.second, sessionId: opened.sessionId });
  const moved = await app.runtime.run({ prompt: "more", sessionId: opened.sessionId });
  assert.equal(moved.output, "from work", "the second plan ran out: work moves to the account kept separate");
  assert.equal(sessionChoice(app.store, owner, opened.sessionId)[POOL], ids.second, "the conversation's own plan is kept");
  seen.length = 0;
  const stopped = await app.runtime.run({ prompt: "and more", sessionId: opened.sessionId });
  assert.equal(stopped.status, "failed");
  assert.ok(!seen.includes("primary"), "never the owner's first plan: that would be moving between their own plans");
});

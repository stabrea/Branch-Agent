import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { setImmediate as settle } from "node:timers/promises";
import { allComfort, saveComfort, updatePlan, noteUpdateCheck } from "../dist/index.js";

// Run the real renderer scheduler and server planner together. Only the DOM, IPC/network,
// storage and clock are doubles; no downloads, installs, windows or owner data are touched.
const renderer = (await readFile(new URL("../public/comfort.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");

function clock() {
  let now = 0, nextId = 0;
  const timers = new Map();
  const add = (fn, ms, repeat = false) => {
    const id = ++nextId;
    timers.set(id, { fn, at: now + ms, ms, repeat });
    return id;
  };
  return {
    get now() { return now; },
    setTimeout: (fn, ms) => add(fn, ms),
    setInterval: (fn, ms) => add(fn, ms, true),
    clear: (id) => timers.delete(id),
    async advance(ms) {
      const end = now + ms;
      await settle();
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.repeat) timer.at += timer.ms; else timers.delete(id);
        timer.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

function fixture(latency) {
  const time = clock(), records = new Map(), checks = [], completions = [];
  const store = {
    get: (_kind, _owner, key) => records.has(key) ? { data: records.get(key) } : undefined,
    save: (_kind, _owner, key, value) => records.set(key, value),
  };
  let active = 0, maxActive = 0, failNext = false;
  const desktop = {
    updateStatus: async () => ({ phase: "current" }),
    checkForUpdates: async () => {
      checks.push(time.now);
      maxActive = Math.max(maxActive, ++active);
      await new Promise((resolve) => time.setTimeout(resolve, latency));
      active--;
      completions.push(time.now);
      if (failNext) { failNext = false; throw new Error("offline"); }
      return { phase: "current" };
    },
  };
  const context = createContext({
    window: { branchDesktop: desktop }, sessionStorage: { getItem: () => "test-token" },
    setTimeout: time.setTimeout, setInterval: time.setInterval,
    clearTimeout: time.clear, clearInterval: time.clear,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      const now = new Date(time.now);
      if (body.checked) noteUpdateCheck(store, "local", now);
      const result = updatePlan(store, "local", { ...body, busyTasks: 0, now });
      return { ok: true, json: async () => result };
    },
  });
  runInContext(renderer, context);
  // apply() tells other modules the comfort values changed (#208's key hints listen for it).
  context.Event = class { constructor(type) { this.type = type; } };
  context.document = { getElementById: (id) => id === "workspace" ? { hidden: true } : null, dispatchEvent: () => true };
  const configure = async (settings) => {
    saveComfort(store, "local", "notify", settings);
    context.testValues = allComfort(store, "local");
    runInContext("view = { values: testValues }; apply();", context);
    await settle();
  };
  return { time, checks, completions, configure, get maxActive() { return maxActive; },
    failOnce() { failNext = true; }, manual: () => runInContext("autoUpdate()", context) };
}

for (const latency of [1, 45_000, 240_000, 360_000]) {
  test(`Beta schedules its next check five minutes after completion (${latency}ms response)`, async () => {
    const f = fixture(latency);
    await f.configure({ autoUpdate: "check", releaseChannel: "beta" });
    for (let index = 0; index < 3; index++) {
      assert.equal(f.checks.length, index + 1);
      await f.time.advance(latency);
      const completed = f.completions.at(-1);
      await f.time.advance(299_999);
      assert.equal(f.checks.length, index + 1, "no early/overlapping check");
      await f.time.advance(1);
      assert.equal(f.checks.at(-1), completed + 300_000, "no skipped five-minute wake");
    }
    assert.equal(f.maxActive, 1);
  });
}

test("refresh during a slow check cannot overlap checks or revive a disabled schedule", async () => {
  const f = fixture(45_000);
  await f.configure({ autoUpdate: "check", releaseChannel: "beta" });
  await f.time.advance(20_000);
  await f.configure({ releaseChannel: "stable" });
  await f.configure({ releaseChannel: "beta" });
  await f.manual();
  assert.equal(f.checks.length, 1);
  await f.configure({ autoUpdate: "off" });
  await f.time.advance(3_600_000);
  assert.equal(f.checks.length, 1);
  await f.configure({ autoUpdate: "check" });
  assert.equal(f.checks.length, 2);
  assert.equal(f.maxActive, 1);
});

test("a failed Beta check is retried after five minutes without overlapping", async () => {
  const f = fixture(45_000);
  f.failOnce();
  await f.configure({ autoUpdate: "check", releaseChannel: "beta" });
  await f.time.advance(345_000);
  assert.deepEqual(f.checks, [0, 345_000]);
  assert.equal(f.maxActive, 1);
});

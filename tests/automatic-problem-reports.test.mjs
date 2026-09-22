import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("automatic problem reports ship off and preview only the chosen redacted sections", async () => {
  const reports = await import("../dist/automatic-problem-reports.js").catch(() => ({}));
  assert.equal(typeof reports.AutomaticProblemReportSettingsSchema?.parse, "function",
    "the automatic-report settings contract does not exist yet");

  const defaults = reports.AutomaticProblemReportSettingsSchema.parse({});
  assert.equal(defaults.mode, "off");
  assert.equal(defaults.destination, null);

  const settings = reports.AutomaticProblemReportSettingsSchema.parse({
    mode: "on",
    destination: { kind: "channel", channel: "discord", chatId: "owner-room" },
    items: ["about", "updates"],
  });
  const preview = reports.problemReportPreview(settings, "update", "Install failed for alice@example.com", [
    { id: "about", title: "About", why: "Version", text: "Branch 0.19.0" },
    { id: "log", title: "Log", why: "Recent work", text: "private conversation" },
    { id: "updates", title: "Updates", why: "What happened", text: "token=abcdefghijklmnop" },
  ]);

  assert.deepEqual(preview.items, ["about", "updates"]);
  assert.equal(preview.destination, "discord:owner-room");
  assert.doesNotMatch(preview.body, /private conversation|alice@example\.com|abcdefghijklmnop/);
  assert.match(preview.body, /\[email removed\]|\[removed\]/);
});

test("an opted-in report sends its exact preview only to an already linked owner chat", async () => {
  const reports = await import("../dist/automatic-problem-reports.js");
  assert.equal(typeof reports.AutomaticProblemReports, "function",
    "the automatic-report delivery boundary does not exist yet");
  const delivered = [];
  const recorded = [];
  const settings = reports.AutomaticProblemReportSettingsSchema.parse({
    mode: "on",
    destination: { kind: "channel", channel: "discord", chatId: "owner-room" },
    items: ["about", "updates"],
  });
  const service = new reports.AutomaticProblemReports({
    settings: () => settings,
    linkedChannels: () => [{ channel: "discord", chatId: "owner-room" }],
    gather: async (chosen) => {
      assert.deepEqual(chosen, ["about", "updates"], "unselected report parts are never gathered");
      return [
        { id: "about", title: "About", why: "Version", text: "Branch 0.19.0" },
        { id: "updates", title: "Updates", why: "What happened", text: "update failed" },
      ];
    },
    deliverChannel: async (channel, chatId, text, key) => delivered.push({ channel, chatId, text, key }),
    createGitHubIssue: async () => assert.fail("GitHub was not chosen"),
    record: (entry) => recorded.push(entry),
  });

  const result = await service.report("update", "update failed");
  assert.equal(result.sent, true);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0], {
    channel: "discord", chatId: "owner-room", text: result.preview.body,
    key: result.key,
  });
  assert.equal(recorded.at(-1).outcome, "sent");
});

test("an unlinked chat can never receive an automatic problem report", async () => {
  const reports = await import("../dist/automatic-problem-reports.js");
  let delivered = 0;
  let gathered = 0;
  const service = new reports.AutomaticProblemReports({
    settings: () => reports.AutomaticProblemReportSettingsSchema.parse({
      mode: "on",
      destination: { kind: "channel", channel: "discord", chatId: "not-the-owner" },
    }),
    linkedChannels: () => [{ channel: "discord", chatId: "owner-room" }],
    gather: async () => { gathered += 1; return []; },
    deliverChannel: async () => { delivered += 1; },
    createGitHubIssue: async () => undefined,
    record: () => undefined,
  });

  const result = await service.report("crash", "boom");
  assert.equal(result.sent, false);
  assert.equal(result.retryable, false, "revoked consent is discarded rather than retried forever");
  assert.match(result.reason, /no longer linked/);
  assert.equal(gathered, 0, "nothing is gathered until the destination is allowed");
  assert.equal(delivered, 0);
});

test("automatic-report consent is stored separately, defaults off, and partial saves preserve its destination", async () => {
  const reports = await import("../dist/automatic-problem-reports.js");
  assert.equal(typeof reports.automaticProblemReportSettings, "function");
  assert.equal(typeof reports.saveAutomaticProblemReportSettings, "function");
  const rows = new Map();
  const store = {
    get: (_table, owner, key) => rows.get(`${owner}:${key}`),
    save: (_table, owner, key, data) => rows.set(`${owner}:${key}`, { data }),
  };

  assert.equal(reports.automaticProblemReportSettings(store, "me").mode, "off");
  reports.saveAutomaticProblemReportSettings(store, "me", {
    mode: "on",
    destination: { kind: "channel", channel: "discord", chatId: "owner-room" },
  });
  const changed = reports.saveAutomaticProblemReportSettings(store, "me", { items: ["about", "updates"] });
  assert.equal(changed.mode, "on");
  assert.deepEqual(changed.destination, { kind: "channel", channel: "discord", chatId: "owner-room" });
  assert.deepEqual(changed.items, ["about", "updates"]);
});

test("only real crashes and update errors become automatic problem incidents", async () => {
  const reports = await import("../dist/automatic-problem-reports.js");
  assert.equal(typeof reports.automaticProblemKind, "function");
  const line = (component, level, message) => ({ at: "2026-09-21T00:00:00Z", component, level, message, pid: 1 });

  assert.equal(reports.automaticProblemKind(line("updater", "error", "The update could not be installed")), "update");
  assert.equal(reports.automaticProblemKind(line("engine", "error", "Crashed: TypeError")), "crash");
  assert.equal(reports.automaticProblemKind(line("updater", "warn", "Checking for updates failed")), null,
    "a transient check failure is not reported as a broken update");
  assert.equal(reports.automaticProblemKind(line("tasks", "error", "a task failed")), null,
    "ordinary task errors do not become product problem reports");
});

test("a GitHub report sends exactly the preview and keeps it inside GitHub's issue limit", async () => {
  const reports = await import("../dist/automatic-problem-reports.js");
  let created;
  const settings = reports.AutomaticProblemReportSettingsSchema.parse({
    mode: "on",
    destination: { kind: "github", repository: "stabrea/Branch-Agent" },
    items: ["log"],
  });
  const service = new reports.AutomaticProblemReports({
    settings: () => settings,
    linkedChannels: () => [],
    gather: async () => [{ id: "log", title: "Log", why: "Recent work", text: "x".repeat(20_000) }],
    deliverChannel: async () => assert.fail("a channel was not chosen"),
    createGitHubIssue: async (repository, title, body, key) => { created = { repository, title, body, key }; },
    record: () => undefined,
  });

  const result = await service.report("crash", "engine stopped", "incident-1");
  assert.equal(result.sent, true);
  assert.equal(result.preview.body.length <= 8000, true);
  assert.equal(created.body, result.preview.body);
  assert.equal(created.repository, "stabrea/Branch-Agent");
});

test("a crash incident is durably queued before delivery and is retried once after restart", async (t) => {
  const reports = await import("../dist/automatic-problem-reports.js");
  assert.equal(typeof reports.AutomaticProblemOutbox, "function",
    "fatal incidents have no durable outbox yet");
  const dir = await mkdtemp(join(tmpdir(), "branch-problem-outbox-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = reports.AutomaticProblemReportSettingsSchema.parse({
    mode: "on",
    destination: { kind: "channel", channel: "discord", chatId: "owner-room" },
    events: ["crash"],
  });
  const first = new reports.AutomaticProblemOutbox(dir, () => settings);
  const line = { at: "2026-09-21T01:02:03.000Z", component: "engine", level: "error",
    message: "Crashed: failed for alice@example.com", pid: 1 };
  const queued = first.capture(line);
  assert.equal(first.pending().length, 1);
  assert.doesNotMatch(await readFile(first.file, "utf8"), /alice@example\.com/);

  const calls = [];
  const restarted = new reports.AutomaticProblemOutbox(dir, () => settings);
  const result = await restarted.flush({ report: async (...args) => {
    calls.push(args);
    return { sent: true, key: args[2], preview: { title: "", body: "", items: [], destination: "discord:owner-room" } };
  } });
  assert.deepEqual(calls, [["crash", queued.summary, queued.key]]);
  assert.deepEqual(result, { sent: 1, kept: 0, discarded: 0 });
  assert.deepEqual(restarted.pending(), []);
});

test("queued incidents never move to a destination the owner did not choose for them", async (t) => {
  const reports = await import("../dist/automatic-problem-reports.js");
  const dir = await mkdtemp(join(tmpdir(), "branch-problem-consent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let settings = reports.AutomaticProblemReportSettingsSchema.parse({
    mode: "on",
    destination: { kind: "channel", channel: "discord", chatId: "first-room" },
  });
  const outbox = new reports.AutomaticProblemOutbox(dir, () => settings);
  outbox.capture({ at: "2026-09-21T01:02:03.000Z", component: "updater", level: "error",
    message: "Update failed", pid: 1 });
  settings = reports.AutomaticProblemReportSettingsSchema.parse({
    mode: "on",
    destination: { kind: "channel", channel: "discord", chatId: "different-room" },
  });
  let delivered = 0;
  const result = await outbox.flush({ report: async () => { delivered += 1; return { sent: true }; } });
  assert.equal(delivered, 0);
  assert.deepEqual(result, { sent: 0, kept: 0, discarded: 1 });
  assert.deepEqual(outbox.pending(), []);
});

test("a queued incident is discarded when its linked owner destination has been revoked", async (t) => {
  const reports = await import("../dist/automatic-problem-reports.js");
  const dir = await mkdtemp(join(tmpdir(), "branch-problem-revoked-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = reports.AutomaticProblemReportSettingsSchema.parse({
    mode: "on",
    destination: { kind: "channel", channel: "discord", chatId: "owner-room" },
  });
  const outbox = new reports.AutomaticProblemOutbox(dir, () => settings);
  outbox.capture({ at: "2026-09-21T01:02:03.000Z", component: "updater", level: "error",
    message: "Update failed", pid: 1 });

  const result = await outbox.flush({ report: async () => ({ sent: false, retryable: false }) });
  assert.deepEqual(result, { sent: 0, kept: 0, discarded: 1 });
  assert.deepEqual(outbox.pending(), []);
});

test("the durable outbox stays bounded and ignores a torn final journal line", async (t) => {
  const reports = await import("../dist/automatic-problem-reports.js");
  const dir = await mkdtemp(join(tmpdir(), "branch-problem-bounded-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = reports.AutomaticProblemReportSettingsSchema.parse({
    mode: "on",
    destination: { kind: "channel", channel: "discord", chatId: "owner-room" },
  });
  const outbox = new reports.AutomaticProblemOutbox(dir, () => settings);
  for (let index = 0; index < 100; index++) outbox.capture({
    at: new Date(index).toISOString(), component: "updater", level: "error", pid: 1,
    message: `Update failed ${index} ${"x".repeat(900)}`,
  });
  await appendFile(outbox.file, '{"op":"put"');

  assert.equal(outbox.pending().length, 20);
  assert.equal((await readFile(outbox.file)).byteLength < 64 * 1024, true, "compaction replaces the large journal");
});

test("a report-gathering failure is kept for retry and recorded without escaping", async () => {
  const reports = await import("../dist/automatic-problem-reports.js");
  const recorded = [];
  const service = new reports.AutomaticProblemReports({
    settings: () => reports.AutomaticProblemReportSettingsSchema.parse({
      mode: "on", destination: { kind: "channel", channel: "discord", chatId: "owner-room" },
    }),
    linkedChannels: () => [{ channel: "discord", chatId: "owner-room" }],
    gather: async () => { throw new Error("failed for alice@example.com"); },
    deliverChannel: async () => assert.fail("nothing is delivered without a report"),
    createGitHubIssue: async () => assert.fail("GitHub was not chosen"),
    record: (entry) => recorded.push(entry),
  });
  const result = await service.report("crash", "engine stopped", "incident-gather");
  assert.equal(result.sent, false);
  assert.equal(result.retryable, true);
  assert.doesNotMatch(result.reason, /alice@example\.com/);
  assert.equal(recorded[0].outcome, "failed");
});

test("an uncertain GitHub response is not retried into a duplicate public issue", async () => {
  const reports = await import("../dist/automatic-problem-reports.js");
  let attempts = 0;
  const service = new reports.AutomaticProblemReports({
    settings: () => reports.AutomaticProblemReportSettingsSchema.parse({
      mode: "on", destination: { kind: "github", repository: "acme/branch-problems" },
    }),
    linkedChannels: () => [],
    gather: async () => [{ id: "about", title: "About", why: "Version", text: "Branch 0.19.0" }],
    deliverChannel: async () => assert.fail("a channel was not chosen"),
    createGitHubIssue: async () => { attempts += 1; throw new Error("the response was lost"); },
    record: () => undefined,
  });

  const result = await service.report("crash", "engine stopped", "incident-github-uncertain");
  assert.equal(attempts, 1);
  assert.equal(result.sent, false);
  assert.equal(result.retryable, false, "GitHub cannot deduplicate create-issue retries");
});

test("a local audit failure after delivery never causes the external report to be retried", async () => {
  const reports = await import("../dist/automatic-problem-reports.js");
  let delivered = 0;
  const service = new reports.AutomaticProblemReports({
    settings: () => reports.AutomaticProblemReportSettingsSchema.parse({
      mode: "on", destination: { kind: "channel", channel: "discord", chatId: "owner-room" },
    }),
    linkedChannels: () => [{ channel: "discord", chatId: "owner-room" }],
    gather: async () => [],
    deliverChannel: async () => { delivered += 1; },
    createGitHubIssue: async () => assert.fail("GitHub was not chosen"),
    record: () => { throw new Error("audit storage unavailable"); },
  });

  const result = await service.report("update", "install failed", "incident-audit-failure");
  assert.equal(delivered, 1);
  assert.equal(result.sent, true);
  assert.equal(result.retryable, false);
});

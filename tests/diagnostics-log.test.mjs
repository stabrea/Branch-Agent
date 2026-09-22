import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiagnosticLog, DiagnosticLogSettingsSchema, crashReporterOptions, makeRedactor, redactFields, watchProcessCrashes, componentOf, diagnose,
} from "../dist/diagnostic-log.js";
import { gatherReport, issueUrl, keptItems, reportZip } from "../dist/diagnostic-report.js";
import { diagnosticApi, handlesDiagnosticPath, startDiagnosticLog } from "../dist/diagnostic-api.js";
import { createBranch } from "../dist/index.js";
import { zipRead } from "../dist/skill-package.js";
import { offLimitsToHousehold, offLimitsToShortLivedKeys } from "../dist/server.js";

const home = "/Users/someone";
const clean = makeRedactor(home);
const settings = (over = {}) => () => DiagnosticLogSettingsSchema.parse({ mode: "on", ...over });
const folder = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "branch-diag-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

/* ---------------------------------------------------------------- 1. cleaning at write time */

test("D1 keys, tokens, bearer headers, emails and the home folder never survive the cleaner", () => {
  const dirty = [
    "key sk-proj-abcdefghijklmnopqrstuvwx1234", // not-a-real-secret
    "github ghp_abcdefghijklmnopqrstuvwxyz0123456789", // not-a-real-secret
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrstu.abcdefghijklmnopqrstuv",
    "mail me at jane.doe@example.com please",
    `opened ${home}/Projects/secret-plan/notes.md`,
    "slack xoxb-1234567890-abcdefghij", // not-a-real-secret
  ].join("\n");
  const out = clean(dirty);
  for (const leak of ["sk-proj-abcdefghijklmnop", "ghp_abcdefghij", "eyJhbGciOiJIUzI1NiJ9", "jane.doe@example.com", home, "xoxb-1234567890"]) // not-a-real-secret
    assert.ok(!out.includes(leak), `${leak} survived: ${out}`);
  assert.match(out, /~\/Projects\/secret-plan/, "a home path becomes ~, so the shape stays readable");
  assert.match(out, /\[email removed\]/);
});

test("D2 fields named like secrets are removed whole, however innocent the value", () => {
  const out = redactFields({ apiKey: "short", nested: { password: "x", note: `in ${home}/a` }, list: ["ok", "sk-abcdefghijklmnop1234"] }, clean); // not-a-real-secret
  assert.equal(out.apiKey, "[removed]");
  assert.equal(out.nested.password, "[removed]");
  assert.equal(out.nested.note, "in ~/a");
  assert.ok(!JSON.stringify(out).includes("sk-abcdefghijklmnop1234")); // not-a-real-secret
});

test("D3 what reaches the disk is already clean", async (t) => {
  const dir = await folder(t);
  const log = new DiagnosticLog({ dir, settings: settings(), clean });
  log.write({ level: "info", component: "channels", message: "sent to bob@example.org", fields: { token: "abc", path: `${home}/x` }, taskId: "run-1" });
  const text = await readFile(log.file, "utf8");
  assert.ok(!text.includes("bob@example.org") && !text.includes(home) && !text.includes("\"abc\""));
  const [line] = log.read();
  assert.equal(line.component, "channels");
  assert.equal(line.taskId, "run-1");
  assert.equal(line.level, "info");
});

/* ---------------------------------------------------------------- 2. modes, rotation, retention */

test("D4 off writes nothing; when needed writes only warnings and errors", async (t) => {
  const dir = await folder(t);
  let mode = "off";
  const log = new DiagnosticLog({ dir, settings: () => DiagnosticLogSettingsSchema.parse({ mode }), clean });
  log.write({ level: "error", component: "engine", message: "while off" });
  assert.deepEqual(await readdir(dir).catch(() => []), [], "the log is off by default and writes no file");
  assert.equal(DiagnosticLogSettingsSchema.parse({}).mode, "off", "it ships off");
  mode = "when-needed";
  log.write({ level: "info", component: "engine", message: "quiet" });
  log.write({ level: "warn", component: "engine", message: "loud" });
  assert.deepEqual(log.read().map((line) => line.message), ["loud"]);
  assert.equal(log.breadcrumbs().length, 3, "breadcrumbs are kept in memory whatever the mode");
});

test("D4a an opted-in reporter can observe the already-clean error even while the local log is off", async (t) => {
  const dir = await folder(t);
  const seen = [];
  const log = new DiagnosticLog({
    dir,
    settings: settings({ mode: "off" }),
    clean,
    onLine: (line) => seen.push(line),
  });
  log.write({ level: "error", component: "updater", message: "failed for alice@example.com" });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].component, "updater");
  assert.doesNotMatch(seen[0].message, /alice@example\.com/);
  assert.deepEqual(await readdir(dir).catch(() => []), [], "the independent activity-log switch remains off");
});

test("D5 the log rotates at its size cap and keeps at most five files", async (t) => {
  const dir = await folder(t);
  const log = new DiagnosticLog({ dir, settings: settings({ maxMegabytes: 1 }), clean });
  const filler = "x".repeat(900);
  for (let index = 0; index < 1600; index++) log.write({ level: "info", component: "engine", message: `${index} ${filler}` });
  const files = (await readdir(dir)).filter((name) => name.startsWith("branch"));
  assert.ok(files.length > 1 && files.length <= 5, `rotated into ${files.join(", ")}`);
  let total = 0;
  for (const name of files) total += (await stat(join(dir, name))).size;
  assert.ok(total <= 1.05 * 1024 * 1024, `the log stayed under its cap (${total} bytes)`);
  assert.match(log.read({ limit: 1 })[0].message, /^1599 /, "the newest line reads first");
});

test("D6 files older than the owner's number of days are removed", async (t) => {
  const dir = await folder(t);
  const log = new DiagnosticLog({ dir, settings: settings({ keepDays: 3 }), clean });
  log.write({ level: "info", component: "engine", message: "old" });
  const old = new Date(Date.now() - 5 * 86_400_000);
  utimesSync(log.file, old, old);
  assert.equal(log.prune(), 1);
  assert.deepEqual(log.read(), []);
});

/* ---------------------------------------------------------------- 3. crashes */

test("D7 a crash is written straight away with the breadcrumbs before it", async (t) => {
  const dir = await folder(t);
  // mac7/coding-next: crash notes are their own switch now, off by default; this one has it on.
  const log = new DiagnosticLog({ dir, settings: settings({ mode: "off", crashCapture: "on" }), clean });
  log.write({ level: "info", component: "tasks", message: "step one" });
  const stop = watchProcessCrashes(log, "engine");
  t.after(stop);
  process.emit("uncaughtExceptionMonitor", new Error(`boom in ${home}/app`), "uncaughtException");
  const [crash] = log.crashes();
  assert.equal(crash.component, "engine");
  assert.match(crash.message, /boom in ~\/app/);
  assert.deepEqual(crash.breadcrumbs.map((line) => line.message), ["step one"]);
  assert.equal(log.read().length, 0, "with the log off, only the crash note is written");
});

test("D8 Electron's crash reporter keeps crash files on this computer", () => {
  const options = crashReporterOptions();
  assert.equal(options.uploadToServer, false);
  assert.equal(options.submitURL, "");
});

/* ---------------------------------------------------------------- 4. the report */

const sources = (log, over = {}) => ({
  version: "9.9.9", dataDir: tmpdir(), installType: "from source", log, logMode: "on",
  health: async () => ({ ok: true, items: [{ name: "db", detail: `at ${homedir()}/data`, token: "t" }] }),
  settings: () => ({ "diagnostic-log": { mode: "on" } }),
  services: () => ({ engine: { pid: 1 }, channels: [{ kind: "telegram" }] }),
  events: () => ({ events: [{ kind: "run.failed", data: { error: "Bearer abcdefghijklmnopqrstuvwxyz" } }] }),
  resolve: null, ...over,
});

test("D9 the report holds every must-have, cleaned, and nothing is looked up under Lockdown", async (t) => {
  const dir = await folder(t);
  const log = new DiagnosticLog({ dir, settings: settings(), clean });
  log.write({ level: "warn", component: "mcp", message: "could not reach server" });
  const items = await gatherReport(sources(log));
  assert.deepEqual(items.map((item) => item.id),
    ["about", "health", "services", "settings", "log", "crashes", "updates", "tasks", "disk", "network"]);
  const all = JSON.stringify(items);
  assert.ok(!all.includes("abcdefghijklmnopqrstuvwxyz"), "a bearer value in a task event is removed");
  assert.ok(!all.includes(`${homedir()}/data`), "the real home folder is removed");
  assert.match(items.find((item) => item.id === "network").text, /Lockdown/);
  assert.match(items.find((item) => item.id === "log").text, /could not reach server/);
  const about = JSON.parse(items[0].text);
  for (const field of ["branch", "installType", "os", "arch", "node"]) assert.ok(about[field], `about has ${field}`);
});

test("D10 the owner's removals are honoured in the zip", async (t) => {
  const dir = await folder(t);
  const items = keptItems(await gatherReport(sources(new DiagnosticLog({ dir, settings: settings(), clean }))), ["log", "tasks"]);
  const files = zipRead(reportZip(items));
  assert.ok(files.has("README.txt") && files.has("about.txt") && files.has("health.txt"));
  assert.ok(!files.has("log.txt") && !files.has("tasks.txt"), "removed items are not in the zip");
});

test("D11 the issue link is GitHub's own form with a title and a short body, never the log", async (t) => {
  const dir = await folder(t);
  const log = new DiagnosticLog({ dir, settings: settings(), clean });
  log.write({ level: "error", component: "engine", message: "LOG-ONLY-LINE" });
  const url = new URL(issueUrl(await gatherReport(sources(log)), "It froze for alice@example.com"));
  assert.equal(url.origin + url.pathname, "https://github.com/stabrea/Branch-Agent/issues/new");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["body", "title"]);
  assert.ok(url.searchParams.get("body").length <= 6000);
  assert.ok(!url.href.includes("LOG-ONLY-LINE"), "the log goes in the zip the owner attaches, not in the link");
  assert.ok(!decodeURIComponent(url.href).includes("alice@example.com"));
});

test("D12 nothing in the new code sends anything by itself", async () => {
  const root = join(import.meta.dirname, "..", "src");
  for (const name of ["diagnostic-log.ts", "diagnostic-report.ts", "diagnostic-api.ts", "diagnostic-cli.ts"]) {
    const text = await readFile(join(root, name), "utf8");
    assert.doesNotMatch(text, /\bfetch\(|https?\.request|net\.connect|uploadToServer:\s*true/, `${name} reaches out`);
  }
  let looked = 0;
  await gatherReport(sources(null, { resolve: async () => { looked += 1; } }));
  assert.equal(looked, 3, "only a name look-up, and only when a report is gathered on the owner's click");
});

/* ---------------------------------------------------------------- 5. who may use it */

test("D13 short-lived keys and household profiles are refused, reading included", () => {
  for (const path of ["/api/diagnostics/log", "/api/diagnostics/report", "/api/diagnostics/log/settings",
    "/api/diagnostics/report/automatic", "/api/diagnostics/report/automatic/preview"]) {
    assert.match(offLimitsToShortLivedKeys("GET", path) ?? "", /short-lived key/);
    assert.match(offLimitsToShortLivedKeys("POST", path) ?? "", /short-lived key/);
    assert.match(offLimitsToHousehold("GET", path) ?? "", /belongs to the owner/);
  }
  assert.equal(handlesDiagnosticPath("/api/diagnostics/bundle"), false, "the older folder keeps its own route");
});

const fakeApp = ({ owner = true, lockdown = false } = {}) => ({
  version: "9.9.9",
  runtime: { owner: "me" },
  store: {
    profiles: { requireOwner: (what) => { if (!owner) throw new Error(`${what} belongs to the owner.`); } },
    get: (_table, _owner, key) => key === "lockdown" && lockdown ? { data: { on: true } } : undefined,
    save: () => undefined,
  },
});

test("D14 somebody else's profile is refused; Lockdown does not stop the owner reading their log", async (t) => {
  const dataDir = await folder(t);
  const url = new URL("http://local/api/diagnostics/log");
  await assert.rejects(diagnosticApi({ app: fakeApp({ owner: false }), dataDir, installType: "x", startedAt: 0 }, "GET", "/api/diagnostics/log", url, async () => ({})),
    /belongs to the owner/);
  const read = await diagnosticApi({ app: fakeApp({ lockdown: true }), dataDir, installType: "x", startedAt: 0 }, "GET", "/api/diagnostics/log", url, async () => ({}));
  assert.deepEqual(read.lines, []);
  assert.equal(read.settings.mode, "off");
});

test("D15 each stored event lands under the part of Branch it came from", () => {
  assert.equal(componentOf("channel.message"), "channels");
  assert.equal(componentOf("mcp.tried"), "mcp");
  assert.equal(componentOf("run.failed"), "tasks");
});

/* ---------------------------------------------------------------- integration review: wider cleaning */

test("D16 every provider's key, cookies, sign-in headers, credential addresses, other homes and shares are removed", () => {
  const win = makeRedactor("C:\\Users\\Taofik");
  // Built from pieces so the repository's secret scanning does not take these made-up keys for real ones.
  const fake = (...parts) => parts.join("");
  const cases = [
    [fake("AIza", "SyA1234567890abcdefghijklmnopqrstu"), "AIzaSyA1234567890"],
    [fake("gsk_", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ"), "gsk_abcdefghij"],
    [fake("xai-", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ"), "xai-abcdefghij"],
    [fake("hf_", "abcdefghijklmnopqrstuvwxyzABCDEFGH"), "hf_abcdefghij"],
    [fake("mistral key: 3kX9aB2cD4eF", "6gH8iJ0kL2mN4oP6qR8s"), "3kX9aB2cD4eF"],
    [fake("secret wJalrXUtnFEMI", "/K7MDENG/bPxRfiCYEXAMPLEKEY"), "wJalrXUtnFEMI"],
    [fake("bot token 123456789:", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"), "AAHdqTcvCH1v"],
    [fake("https://api.telegram.org/bot123456789:", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage"), "AAHdqTcvCH1v"],
    [fake("MTE4NzY1NDMyMTA5ODc2NTQzMg", ".GaBcDe.abcdefghijklmnopqrstuvwxyz0123456789AB"), "MTE4NzY1NDMy"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc", "eyJzdWIiOiIxIn0"],
    ["Cookie: session=abc123; other=def456", "def456"],
    ["Set-Cookie: sid=s%3Aabcdef123456; Path=/; HttpOnly", "abcdef123456"],
    ['{"cookie":"sid=abcdef123"}', "abcdef123"],
    ["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["x-goog-api-key: abcdef", "abcdef"],
    ["https://generativelanguage.googleapis.com/v1/models?key=sometokenvalue123", "sometokenvalue123"],
    ["https://b.s3.amazonaws.com/f?X-Amz-Signature=deadbeefcafe&X-Amz-Credential=AKIAXX", "deadbeefcafe"],
    ["https://app.example.com/cb#access_token=fragtoken123", "fragtoken123"],
    ["Failed to open C:\\Users\\bob\\Documents\\x.txt", "bob"],
    [JSON.stringify("C:\\Users\\Taofik\\x"), "Taofik"],
    ["c:/users/taofik/x", "taofik"],
    ["\\\\FILESERVER\\private\\Taofik\\plan.docx", "FILESERVER"],
    ["/Users/alice/x and /home/carol/y", "alice"],
    ["/home/carol/y", "carol"],
    ["taofik%40gmail.com", "gmail.com"],
  ];
  for (const [dirty, leak] of cases) {
    const out = win(dirty);
    assert.ok(!out.includes(leak), `${leak} survived in ${out}`);
  }
  // Ordinary lines keep their meaning.
  for (const fine of ["GET /api/tasks/3f2b1c9a-1234-4bcd-9abc-0123456789ab failed (400)", "Checked for updates 0.18.1",
    "connect ECONNREFUSED 127.0.0.1:3000", "run.completed tokens 12345", "model claude-sonnet-4-5-20250929"])
    assert.equal(win(fine), fine);
  const fields = redactFields({ auth: "Basic abc", session: "s", sid: "abc", privateKey: "x", url: "https://a?token=zz" }, win);
  assert.ok(!JSON.stringify(fields).match(/abc|"s"|"x"|zz/), JSON.stringify(fields));
});

test("D17 a crash note never quotes the text a failure choked on", async (t) => {
  const dir = await folder(t);
  const log = new DiagnosticLog({ dir, settings: settings({ mode: "off", crashCapture: "on" }), clean });
  let parseError;
  try { JSON.parse("my private message to the doctor about the results"); } catch (e) { parseError = e; }
  log.crash("engine", parseError);
  const text = await readFile(log.crashFile, "utf8");
  assert.ok(!text.includes("private message") && !text.includes("my priva"), text);
  assert.match(text, /SyntaxError/);
});

/* ---------------------------------------------------------------- integration review 2: the switch holds for the window too */

test("D18 a script error in the window is a log line: nothing reaches the disk while the log is off", async (t) => {
  const dataDir = await folder(t);
  const post = (app, message) => diagnosticApi({ app, dataDir, installType: "x", startedAt: 0 }, "POST", "/api/diagnostics/window-error",
    new URL("http://local/api/diagnostics/window-error"), async () => ({ message, stack: `at ${home}/x.js`, where: "app.js:1" }));
  const off = await post(fakeApp(), "TypeError: boom");
  assert.equal(off.recorded, false);
  assert.deepEqual(await readdir(join(dataDir, "logs")).catch(() => []), [], "off writes no file, not even a crash note");
  const on = fakeApp();
  on.store.get = (_table, _owner, key) => key === "diagnostic-log" ? { data: { mode: "on" } } : undefined;
  const written = await post(on, `SyntaxError: Unexpected token 'h', "hello, my private note" is not valid JSON`);
  assert.equal(written.recorded, true);
  const text = await readFile(join(dataDir, "logs", "branch.jsonl"), "utf8");
  assert.match(text, /"component":"window"/);
  assert.ok(!text.includes("private note") && !text.includes("hello, my"), text);
  await assert.rejects(readFile(join(dataDir, "logs", "crashes.jsonl"), "utf8"), "a window error is not written as a crash");
});

test("D19 the issue link is still made when the returned about item is not JSON", () => {
  const url = new URL(issueUrl([{ id: "about", title: "About", why: "", text: "edited by hand" }], "It froze"));
  assert.match(url.searchParams.get("title"), /Branch \?\)$/);
});

test("D20 a crash after the database has closed is still written, and the handler never throws", async (t) => {
  const dir = await folder(t);
  const closed = () => { throw new Error("database is not open"); };
  const log = new DiagnosticLog({ dir, settings: closed, clean });
  assert.doesNotThrow(() => log.write({ level: "error", component: "engine", message: "late line" }));
  // mac7/coding-next: crash notes are a switch now (off as shipped). With the database closed, the
  // switch file beside the log answers for it: absent, no note; on, the note is still written.
  assert.doesNotThrow(() => log.crash("engine", new Error("boom while closing")));
  assert.equal(log.crashes(5).length, 0, "crash capture never switched on: no note");
  writeFileSync(join(dir, "crash-capture.json"), JSON.stringify({ crashCapture: "on" }));
  assert.doesNotThrow(() => log.crash("engine", new Error("boom while closing")));
  assert.equal(log.crashes(5).length, 1, "switched on: the note is written without the database");
  assert.equal(log.read().length, 0, "with no readable settings the log behaves as shipped: off");
  assert.doesNotThrow(() => log.prune());
});

test("D21 automatic problem reports can be enabled only for an owner destination that is still linked", async (t) => {
  const dataDir = await folder(t);
  const app = fakeApp();
  const rows = new Map();
  app.store.get = (_table, owner, key) => rows.get(`${owner}:${key}`);
  app.store.save = (_table, owner, key, data) => rows.set(`${owner}:${key}`, { data });
  app.channels = { summary: () => ({ chats: [{ channel: "discord", chatId: "owner-room", title: "Problems" }] }) };
  app.registry = { names: () => [] };
  const call = (method, input) => diagnosticApi(
    { app, dataDir, installType: "x", startedAt: 0 }, method, "/api/diagnostics/report/automatic",
    new URL("http://local/api/diagnostics/report/automatic"), async () => input,
  );

  await assert.rejects(call("POST", { mode: "on", destination: { kind: "channel", channel: "discord", chatId: "stranger" } }),
    /no longer linked/);
  assert.equal(rows.size, 0, "an unlinked destination is refused before consent is stored");
  const saved = await call("POST", { mode: "on", destination: { kind: "channel", channel: "discord", chatId: "owner-room" } });
  assert.equal(saved.settings.mode, "on");
  assert.equal(saved.settings.destination.chatId, "owner-room");
  const read = await call("GET", {});
  assert.deepEqual(read.settings, saved.settings);
  assert.deepEqual(read.destinations.channels, [{ channel: "discord", chatId: "owner-room", title: "Problems" }]);
});

test("D22 an opted-in update problem reaches the linked owner chat redacted and leaves a receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-diag-report-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  const sent = [];
  const adapter = {
    id: "problem-reports", kind: "problem-reports", botName: () => "Branch",
    async start() {}, async stop() {},
    async send(chatId, text) { sent.push({ chatId, text }); return "sent-1"; },
  };
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  const sessionId = app.store.createSession(app.runtime.owner);
  app.channels.link(app.runtime.owner, { channel: adapter.id, chatId: "owner-room", sessionId });
  app.store.save("settings", app.runtime.owner, "automatic-problem-reports", {
    mode: "on",
    destination: { kind: "channel", channel: adapter.id, chatId: "owner-room" },
    events: ["update"],
    items: ["about"],
  });
  const stop = startDiagnosticLog(app, dataDir, "package", Date.now());
  t.after(async () => { stop(); await app.close(); await rm(root, { recursive: true, force: true }); });

  diagnose("updater", "error", "Update failed for alice@example.com");
  for (let tries = 0; tries < 100 && sent.length === 0; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "owner-room");
  assert.match(sent[0].text, /Branch Agent noticed an update problem/);
  assert.doesNotMatch(sent[0].text, /alice@example\.com/);
  const [receipt] = app.store.audit.list(app.runtime.owner, { action: "data.exported" })
    .filter((entry) => entry.actor === "automatic problem reports");
  assert.equal(receipt?.outcome, "sent");
  assert.match(receipt?.subject ?? "", /problem-reports:owner-room/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiagnosticLog, DiagnosticLogSettingsSchema, crashReporterOptions, makeRedactor, redactFields, watchProcessCrashes, componentOf,
} from "../dist/diagnostic-log.js";
import { gatherReport, issueUrl, keptItems, reportZip } from "../dist/diagnostic-report.js";
import { diagnosticApi, handlesDiagnosticPath } from "../dist/diagnostic-api.js";
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
    "key sk-proj-abcdefghijklmnopqrstuvwx1234",
    "github ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrstu.abcdefghijklmnopqrstuv",
    "mail me at jane.doe@example.com please",
    `opened ${home}/Projects/secret-plan/notes.md`,
    "slack xoxb-1234567890-abcdefghij",
  ].join("\n");
  const out = clean(dirty);
  for (const leak of ["sk-proj-abcdefghijklmnop", "ghp_abcdefghij", "eyJhbGciOiJIUzI1NiJ9", "jane.doe@example.com", home, "xoxb-1234567890"])
    assert.ok(!out.includes(leak), `${leak} survived: ${out}`);
  assert.match(out, /~\/Projects\/secret-plan/, "a home path becomes ~, so the shape stays readable");
  assert.match(out, /\[email removed\]/);
});

test("D2 fields named like secrets are removed whole, however innocent the value", () => {
  const out = redactFields({ apiKey: "short", nested: { password: "x", note: `in ${home}/a` }, list: ["ok", "sk-abcdefghijklmnop1234"] }, clean);
  assert.equal(out.apiKey, "[removed]");
  assert.equal(out.nested.password, "[removed]");
  assert.equal(out.nested.note, "in ~/a");
  assert.ok(!JSON.stringify(out).includes("sk-abcdefghijklmnop1234"));
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
  const log = new DiagnosticLog({ dir, settings: settings({ mode: "off" }), clean });
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
  for (const path of ["/api/diagnostics/log", "/api/diagnostics/report", "/api/diagnostics/log/settings"]) {
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

/**
 * R17-S-C: comfort. Shortcuts, the status line, notifications and updates, voice keys, the
 * browser's care, the proxy and certificates, ignore files, the tool servers' start-up time, and the
 * terminal's real controls. Nothing here plays a sound, shows a notification, installs an update or
 * changes this computer: the proxy and certificates go through fakes unless a test puts them back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, allComfort, readComfort, saveComfort, ComfortKeysSchema, proxyProblem, checkCertificate,
  validateNetwork, OutboundNetwork, processNetworkHooks, withBrowserConfirmation, ignoreRulesFor,
  statusLineText, updatePlan, noteUpdateCheck, evaluatePolicy, NetworkPolicy, Budget, ToolRegistry,
} from "../dist/index.js";
import { WorkspaceFiles } from "../dist/files.js";
import { startServer } from "../dist/server.js";
import { WorkspaceSearch } from "../dist/code-search.js";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { openMcp } from "../dist/integrations/mcp.js";
import { comfortRows, switchComfort } from "../dist/comfort/terminal.js";
import { settingsRows } from "../dist/terminal-settings.js";
import { loadWords } from "../dist/terminal-words.js";
import { Tui } from "../dist/terminal-tui.js";
import { renderScreen } from "../dist/terminal-screen.js";

const PEMS = (await readFile(new URL("./fixtures/comfort-certificates.pem", import.meta.url), "utf8"))
  .match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
const [CA, LEAF] = PEMS;
const english = loadWords("en");

async function app(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-comfort-"));
  const branch = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...options });
  t.after(async () => { await branch.close(); await discardTemp(root); });
  return { root, app: branch };
}
const memoryStore = (records = {}) => ({ get: (_kind, _owner, key) => (key in records ? { data: records[key] } : undefined) });

test("every comfort setting ships as Branch has always behaved", () => {
  const values = allComfort(memoryStore(), "local");
  assert.deepEqual(values, {
    keys: { palette: "Ctrl+K", newConversation: "Ctrl+N", appearance: "Ctrl+,", sidePane: "Ctrl+Shift+K", vim: false },
    display: { statusLine: null, timestamps: false },
    notify: { method: "system", sound: "off", autoUpdate: "off" },
    voice: { pushToTalkKey: "", maxRecordingSeconds: null },
    browser: { confirmSensitive: false, blockUploads: false, dialogs: "dismiss" },
    network: { proxy: null, noProxy: [], caCertificates: [] },
    files: { respectGitignore: true, extraIgnoreFiles: [] },
    mcp: { startupTimeoutSeconds: 10 },
  });
  // A record written wrongly reads as the defaults rather than stopping anything.
  assert.equal(readComfort(memoryStore({ "comfort-keys": { vim: "yes" } }), "local", "keys").vim, false);
  assert.throws(() => ComfortKeysSchema.parse({ palette: "Ctrl+J", newConversation: "ctrl+j" }), /same keys/);
  assert.throws(() => ComfortKeysSchema.parse({ palette: "K" }), /Ctrl\+K/);
  assert.equal(ComfortKeysSchema.parse({ palette: "", sidePane: "F8" }).palette, "");
});

test("R17-S20: a proxy is plain http(s) with no password, and a certificate must be a current authority", () => {
  assert.equal(proxyProblem("http://proxy.example.com:8080"), null);
  assert.equal(proxyProblem("https://10.0.0.2:3128/"), null);
  assert.match(proxyProblem("http://sam:secret@proxy.example.com:8080"), /user name or password/);
  assert.match(proxyProblem("socks5://proxy.example.com:1080"), /Only http and https/);
  assert.match(proxyProblem("http://proxy.example.com:8080/path"), /nothing after/);
  assert.match(proxyProblem("just some words"), /http:\/\/host:port/);
  assert.match(checkCertificate(CA), /Branch Test CA/);
  assert.throws(() => checkCertificate(LEAF), /not a certificate authority/);
  assert.throws(() => checkCertificate(`${CA}\n${LEAF}`), /exactly one/);
  assert.throws(() => checkCertificate(CA, new Date("2099-01-01")), /expired/);
  assert.throws(() => checkCertificate(`${CA}\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----`), /private key/);
  assert.throws(() => validateNetwork({ proxy: null, noProxy: [], caCertificates: [{ name: "a", pem: CA }, { name: "a", pem: CA }] }), /Two certificates/);
});

test("R17-S20: certificates are added to the computer's own list and never replace it; the proxy is handed over and taken back", () => {
  const calls = [];
  let undone = 0;
  const hooks = {
    setProxy: (env) => { calls.push(["proxy", env]); return () => { undone += 1; }; },
    defaultCertificates: () => ["SYSTEM-1", "SYSTEM-2"],
    setCertificates: (list) => calls.push(["certificates", list]),
  };
  const outbound = new OutboundNetwork(hooks);
  assert.deepEqual(outbound.apply({ proxy: null, noProxy: [], caCertificates: [] }), { proxy: "none", certificates: 0 });
  assert.deepEqual(calls, [], "with nothing set, nothing in the program is touched");
  const state = outbound.apply({ proxy: "http://proxy.example.com:8080", noProxy: ["intranet.example.com"], caCertificates: [{ name: "Office", pem: CA }, { name: "Leaf", pem: LEAF }] });
  assert.deepEqual(state, { proxy: "in use", certificates: 1 });
  assert.deepEqual(calls[0], ["certificates", ["SYSTEM-1", "SYSTEM-2", CA.trim()]], "only the authority is added, after the computer's own");
  assert.deepEqual(calls[1], ["proxy", { HTTP_PROXY: "http://proxy.example.com:8080", HTTPS_PROXY: "http://proxy.example.com:8080", NO_PROXY: "localhost,127.0.0.1,::1,intranet.example.com" }], "local model servers on this computer never go through the proxy");
  outbound.apply({ proxy: null, noProxy: [], caCertificates: [] });
  assert.equal(undone, 1, "turning the proxy off takes it back");
  assert.deepEqual(calls.at(-1), ["certificates", ["SYSTEM-1", "SYSTEM-2"]], "removing the last certificate puts the computer's list back");
  outbound.reset();
  const old = new OutboundNetwork({ ...hooks, setProxy: undefined });
  assert.equal(old.apply({ proxy: "http://proxy.example.com:8080", noProxy: [], caCertificates: [] }).proxy, "needs a newer Node");
});

test("R17-S20: with a proxy set, a call the network rules allowed goes through the proxy", { skip: typeof (await import("node:http")).setGlobalProxyFromEnv !== "function" }, async (t) => {
  const seen = [];
  const proxy = createServer((request, response) => { seen.push(request.url); response.end("through the proxy"); });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const outbound = new OutboundNetwork(processNetworkHooks());
  t.after(() => { outbound.reset(); proxy.close(); });
  const policy = new NetworkPolicy({}, async () => ["93.184.216.34"]);
  outbound.apply({ proxy: `http://127.0.0.1:${proxy.address().port}`, noProxy: [], caCertificates: [] });
  const guarded = policy.guard(globalThis.fetch);
  assert.equal(await (await guarded("http://branch-comfort.example/hello")).text(), "through the proxy");
  assert.deepEqual(seen, ["http://branch-comfort.example/hello"]);
  await assert.rejects(guarded("http://localhost/"), /this computer or a private network/, "the rules still come first");
  outbound.reset();
  await assert.rejects(guarded("http://branch-comfort.example/hello"), "without the proxy the made-up name goes nowhere");
});

test("R17-S20: the settings route checks the proxy and certificates before keeping them, and only the owner may change them", async (t) => {
  const { root, app: branch } = await app(t);
  const server = await startServer(branch, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = (method, path, body, key = server.token) => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  const shown = await call("GET", "/api/comfort");
  assert.equal(shown.status, 200);
  assert.equal(shown.body.values.mcp.startupTimeoutSeconds, 10);
  const refused = await call("POST", "/api/comfort", { card: "network", values: { proxy: "http://a:b@proxy.example.com:1" } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /user name or password/);
  const leaf = await call("POST", "/api/comfort", { card: "network", values: { caCertificates: [{ name: "Leaf", pem: LEAF }] } });
  assert.equal(leaf.status, 400);
  assert.deepEqual(readComfort(branch.store, "local", "network").caCertificates, [], "nothing refused was kept");
  const saved = await call("POST", "/api/comfort", { card: "network", values: { caCertificates: [{ name: "Office", pem: CA }] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.match(saved.body.certificates[0].subject, /Branch Test CA/);
  assert.equal(saved.body.network.certificates, 1, "the certificate is in force at once");
  assert.equal((await call("POST", "/api/comfort", { card: "network", reset: true })).body.network.certificates, 0);

  const key = branch.sessionTokens.create("local", { name: "script", scope: "run", minutes: 5 }).token;
  for (const card of ["keys", "browser", "network"]) {
    const answer = await call("POST", "/api/comfort", { card, values: {} }, key);
    assert.equal(answer.status, 401, card);
    assert.match(answer.body.error, /short-lived key cannot change shortcuts/);
  }
  assert.equal((await call("GET", "/api/comfort", undefined, key)).status, 200, "a short-lived key may look");
  const person = branch.store.profiles.create({ name: "Sam", pin: "4321" });
  branch.store.profiles.switch({ profileId: person.id, pin: "4321" });
  const household = await call("POST", "/api/comfort", { card: "browser", values: { blockUploads: true } });
  assert.equal(household.status, 403);
  branch.store.profiles.switch({ profileId: null });
  assert.equal((await call("POST", "/api/comfort", { card: "browser", values: { blockUploads: true } })).status, 200);
});

test("R17-S19: confirming sensitive browser steps asks every time, before any standing yes, and never loosens a refusal", async (t) => {
  const store = (on) => memoryStore({ "comfort-browser": { confirmSensitive: on } });
  const policy = { preset: "custom", unmatchedCommands: "ask", limits: {}, rules: [
    { tool: "browser.*", match: "*", applies: "any", decision: "allow", remember: "always" },
    { tool: "browser.upload", match: "*", applies: "any", decision: "allow", remember: "always", resource: { kind: "host", pattern: "files.example.com" } },
    { tool: "browser.click", match: "*", applies: "any", decision: "deny", remember: "always", resource: { kind: "host", pattern: "bank.example.com" } },
  ] };
  const decide = (on, tool, host) => evaluatePolicy(withBrowserConfirmation(policy, store(on), "local"),
    { tool, target: host, readOnly: false, resource: host ? { kind: "host", value: host } : null }).decision;
  assert.equal(withBrowserConfirmation(policy, store(false), "local"), policy, "off changes nothing");
  assert.equal(decide(false, "browser.click", "shop.example.com"), "allow");
  assert.equal(decide(true, "browser.click", "shop.example.com"), "ask");
  assert.equal(decide(true, "browser.upload", "files.example.com"), "ask", "a yes for one website does not skip the question");
  assert.equal(decide(true, "browser.fill", ""), "ask", "a step before any page is open is asked about too");
  assert.equal(decide(true, "browser.click", "bank.example.com"), "deny", "a refusal still decides first");
  assert.equal(decide(true, "browser.snapshot", "shop.example.com"), "allow", "reading a page is not a sensitive step");
  const refusing = { ...policy, rules: [{ tool: "browser.*", match: "*", applies: "any", decision: "deny", remember: "always" }, ...policy.rules] };
  for (const host of ["shop.example.com", "files.example.com", ""])
    assert.equal(evaluatePolicy(withBrowserConfirmation(refusing, store(true), "local"),
      { tool: "browser.upload", target: host, readOnly: false, resource: host ? { kind: "host", value: host } : null }).decision,
    evaluatePolicy(refusing, { tool: "browser.upload", target: host, readOnly: false, resource: host ? { kind: "host", value: host } : null }).decision === "deny" ? "deny" : "ask",
    `a broad refusal is never turned into a question (${host || "no page"})`);
  const empty = { ...policy, rules: [] };
  assert.equal(evaluatePolicy(withBrowserConfirmation(empty, store(true), "local"), { tool: "browser.act", target: "", readOnly: false, resource: null }).decision, "ask");

  const { root, app: branch } = await app(t);
  const context = branch.runtime.context({ runId: "comfort-policy" });
  branch.runtime.approvals.remember(context.runId, "browser.click", "", "allow", {});
  assert.equal(branch.runtime.approvals.answer(context.runId, "browser.click", ""), "allow");
  const server = await startServer(branch, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const saved = await fetch(`${server.url}/api/comfort`, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ card: "browser", values: { confirmSensitive: true } }) });
  assert.equal(saved.status, 200);
  assert.equal(branch.runtime.approvals.answer(context.runId, "browser.click", ""), undefined, "turning it on ends the yeses already given");
  const check = branch.runtime.checkPolicy("browser.click", { role: "button", name: "Buy" }, context);
  assert.equal(check.decision, "ask", "a yes given before the switch was turned on no longer skips the question");
  assert.equal(check.remember, "never", "the question is put again next time");
});

const page = (body) => `<!doctype html><meta charset="utf-8"><title>start</title>${body}`;
async function browserHarness(t, records) {
  const root = await mkdtemp(join(tmpdir(), "branch-comfort-browser-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page(`<button onclick="document.querySelector('p').textContent = confirm('Go on?') ? 'Box accepted' : 'Box dismissed'">Ask</button><p>Waiting</p>`));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  browser.store = memoryStore(records);
  browser.files = new WorkspaceFiles(root);
  const registry = new ToolRegistry();
  registerBrowser(registry, browser);
  t.after(async () => { await browser.close(); server.close(); await discardTemp(root); });
  const context = (runId) => ({ owner: "local", workspace: root, runId, signal: new AbortController().signal, budget: new Budget(),
    permissions: new Set(["browser.read", "browser.interact"]), depth: 0 });
  return { root, origin, registry, context };
}

test("R17-S19: uploads can be refused outright, and a website's message box is dismissed or accepted as chosen", async (t) => {
  const blocked = await browserHarness(t, { "comfort-browser": { blockUploads: true, dialogs: "accept" } });
  await writeFile(join(blocked.root, "notes.txt"), "hello");
  await assert.rejects(blocked.registry.execute("browser.upload", { selector: "input", path: "notes.txt" }, blocked.context("up")),
    /Sending files to websites is switched off/);
  const run = blocked.context("accept");
  await blocked.registry.execute("browser.navigate", { url: `${blocked.origin}/` }, run);
  const clicked = await blocked.registry.execute("browser.click", { role: "button", name: "Ask" }, run);
  assert.equal(clicked.messageBoxes[0].kind, "confirm");
  assert.match(JSON.stringify(await blocked.registry.execute("browser.snapshot", {}, run)), /Box accepted/);
  await blocked.registry.finishRun(run);

  const usual = await browserHarness(t, {});
  const second = usual.context("dismiss");
  await usual.registry.execute("browser.navigate", { url: `${usual.origin}/` }, second);
  await usual.registry.execute("browser.click", { role: "button", name: "Ask" }, second);
  assert.match(JSON.stringify(await usual.registry.execute("browser.snapshot", {}, second)), /Box dismissed/, "as always, Cancel is pressed");
  await usual.registry.finishRun(second);
});

test("R17-S20: .branchignore still wins over .gitignore; .gitignore can be left out, and more ignore files added", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-comfort-ignore-"));
  t.after(() => discardTemp(root));
  await mkdir(join(root, "build"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "build/\n");
  await writeFile(join(root, ".aiignore"), "drafts.md\n");
  await writeFile(join(root, "build", "out.js"), "1");
  await writeFile(join(root, "drafts.md"), "2");
  await writeFile(join(root, "keep.md"), "3");
  const search = new WorkspaceSearch(new WorkspaceFiles(root));
  const listed = async () => (await search.walk()).entries.map((entry) => entry.path).filter((path) => !path.startsWith(".")).sort();
  assert.deepEqual(await listed(), ["drafts.md", "keep.md"], "as always, .gitignore is used when there is no .branchignore");
  search.ignoreChoice = () => ({ respectGitignore: false, extraIgnoreFiles: [".aiignore", "../escape"] });
  assert.deepEqual(await listed(), ["build/out.js", "keep.md"]);
  await writeFile(join(root, ".branchignore"), "keep.md\n");
  search.ignoreChoice = undefined;
  assert.deepEqual(await listed(), ["build/out.js", "drafts.md"], ".branchignore replaces .gitignore, as it always has");
  const rules = await ignoreRulesFor(root, { respectGitignore: true, extraIgnoreFiles: [".aiignore"] });
  assert.equal(rules("drafts.md"), true);
  assert.equal(rules("keep.md"), true);
});

test("R17-S20: a tool server that does not answer is given up on after the owner's start-up time", async () => {
  const silent = { id: "silent", transport: "stdio", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], tools: ["echo"], expectedVersion: "1.0.0" };
  const started = Date.now();
  await assert.rejects(openMcp(silent, process.env, undefined, undefined, 400), /MCP connection failed/);
  assert.ok(Date.now() - started < 5000, `it waited ${Date.now() - started} ms, not the ten seconds it used to`);
});

test("R17-S17: automatic updates are off as shipped, look once a day, and only install when nothing is working", () => {
  const records = {};
  const store = { get: (_k, _o, key) => (key in records ? { data: records[key] } : undefined), save: (_k, _o, key, data) => { records[key] = data; } };
  const now = new Date("2026-09-17T12:00:00Z");
  assert.equal(updatePlan(store, "local", { busyTasks: 0, updaterPhase: "available", now }).step, "nothing", "off never checks or installs");
  records["comfort-notify"] = { autoUpdate: "check" };
  assert.equal(updatePlan(store, "local", { busyTasks: 0, now }).step, "check");
  noteUpdateCheck(store, "local", now);
  assert.equal(updatePlan(store, "local", { busyTasks: 0, now: new Date("2026-09-17T20:00:00Z") }).step, "nothing", "once a day");
  assert.equal(updatePlan(store, "local", { busyTasks: 0, updaterPhase: "available", now }).step, "nothing", "check only tells");
  assert.equal(updatePlan(store, "local", { busyTasks: 0, now: new Date("2026-09-18T12:00:01Z") }).step, "check");
  records["comfort-notify"] = { autoUpdate: "install" };
  assert.equal(updatePlan(store, "local", { busyTasks: 1, updaterPhase: "available", now }).step, "nothing", "never while a task works");
  assert.equal(updatePlan(store, "local", { busyTasks: 0, updaterPhase: "available", now }).step, "install");
});

test("R17-S16: the status line says the pieces picked, in order, or nothing when kept as always", () => {
  const facts = { model: "Demo", used: 32000, room: 128000, folder: "/Users/sam/work/garden", cost: "$0.0100", now: new Date(2026, 8, 17, 9, 5) };
  assert.equal(statusLineText(null, facts), null);
  assert.equal(statusLineText(["folder", "model", "context", "cost", "time"], facts), "garden · Demo · 25% of the room used · $0.0100 · 09:05");
  assert.equal(statusLineText(["context"], facts, loadWords("fr")), "25 % de la place utilisée");
});

test("R17-S21: the terminal's Settings pages carry real controls, /switch changes them, and /model opens a picker", async (t) => {
  const { app: branch, root } = await app(t);
  const rows = comfortRows(branch.store, "local", english, "notifications");
  assert.deepEqual(rows.map((row) => row.command), ["/switch notify", "/switch sound"]);
  assert.match(rows[1].title, /Sound: off/);
  const state = { look: {}, mode: "dark", themeName: "Forest", switches: {} };
  for (const page of ["general", "notifications", "voice", "computer", "advanced", "about"])
    assert.ok(settingsRows(branch, english, page, "", state).some((row) => row.command?.startsWith("/switch ")), `${page} has a control`);
  assert.equal(switchComfort(branch.store, "local", "sound", "", english), "Sound: chime");
  assert.equal(switchComfort(branch.store, "local", "mcpTimeout", "45", english), "Seconds a server may take to start: 45");
  assert.equal(switchComfort(branch.store, "local", "statusLine", "model,cost", english), "Status line: Model, Cost so far");
  assert.throws(() => switchComfort(branch.store, "local", "proxy", "http://a:b@proxy.example.com:1", english), /user name or password/);
  assert.equal(switchComfort(branch.store, "local", "mouse", "on", english), null, "the terminal's own switches are left to it");

  const input = new PassThrough(), output = new PassThrough();
  const tui = new Tui(branch.runtime, { input, output, signals: new EventEmitter(), app: branch, pollIntervalMs: 5,
    env: { TERM: "xterm-256color", COLUMNS: "100", LINES: "30", LANG: "en_GB.UTF-8" } });
  const done = tui.start();
  t.after(async () => { input.write("\x04"); await done; });
  for (let i = 0; i < 20 && !tui.palette; i++) await delay(10);
  assert.equal(tui.model().status, "Offline demonstration · no price on file", "the owner's status line (model, cost) is in the foot");
  switchComfort(branch.store, "local", "statusLine", "default", english);
  assert.match(tui.model().status, / in \/ .* out · /, "as always, the line that was there");
  await tui.command("/switch vim on");
  assert.equal(readComfort(branch.store, "local", "keys").vim, true);
  await tui.command("/model");
  assert.equal(tui.overlay?.kind, "picker");
  assert.ok(tui.overlay.items.every((item) => item.run.startsWith("/model ")));
  input.write("\r");
  await delay(50);
  assert.ok(branch.runtime.models.presets.has(tui.conversation.model), "choosing a row sets this conversation's model");
  const frame = renderScreen(tui.model(), tui.size(), tui.palette, "none").plain.join("\n");
  assert.ok(frame.length > 0);
  void root;
});

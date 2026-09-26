// Local models, one click (flows/localpick.js), in setup's "Which models should answer?" and in the composer's model menu.
// It starts its OWN fresh engine in this process, because the stand-ins have to be handed to it: a stand-in Ollama (a local
// HTTP server that streams a small download with progress and answers "hello"), a stand-in installer (the publisher's
// checksum list and a tiny archive, served from memory) and a launcher whose programs are pretend. Nothing is installed,
// started or downloaded for real: every other address the engine tries is refused and logged, so a mistake fails here
// instead of fetching gigabytes.
//   npx tsc -p . && node scripts/copy-fonts.mjs && node scripts/copy-suites.mjs && node scripts/copy-data.mjs
//   node design/redesign/tools/verify-local-oneclick.cjs            (PORT=<port> to choose the engine's port)
// Screenshots go to SHOTS (default C:/Users/bishi/AppData/Local/Temp/claude-session-files/local-oneclick).
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const GiB = 1024 ** 3;
const SHOTS = process.env.SHOTS || "C:/Users/bishi/AppData/Local/Temp/claude-session-files/local-oneclick";
const ROOT = path.resolve(__dirname, "../../..");
const results = [];
const check = (what, ok, detail = "") => { results.push([ok ? "PASS" : "FAIL", what, detail]); if (!ok) process.exitCode = 1; };
const refused = [];

/* ---------- the stand-in Ollama ---------- */
const TOTAL = 3 * 1024 * 1024, STEPS = 40, STEP_MS = 150;
const ollama = { up: false, installed: false, models: [], pulls: [], chats: 0, unknown: [] };
function reply(res, status, body) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
function pull(res, model) {
  ollama.pulls.push(model);
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
  let step = 0, closed = false;
  res.on("close", () => { closed = true; }); // the engine's Cancel aborts the request, which closes this
  const tick = () => {
    if (closed) return;
    step++;
    res.write(JSON.stringify({ status: "downloading", total: TOTAL, completed: Math.round((TOTAL * step) / STEPS) }) + "\n");
    if (step < STEPS) return void setTimeout(tick, STEP_MS);
    ollama.models.push({ name: model, size: TOTAL, details: { family: model.split(":")[0] }, capabilities: ["completion", "tools"] });
    res.end(JSON.stringify({ status: "success" }) + "\n");
  };
  setTimeout(tick, STEP_MS);
}
function ollamaRoute(req, res, body) {
  if (!ollama.up) return reply(res, 503, { error: "not running" });
  const url = new URL(req.url, "http://x");
  switch (url.pathname) {
    case "/api/version": return reply(res, 200, { version: "stand-in" });
    case "/api/tags": return reply(res, 200, { models: ollama.models });
    case "/api/pull": return pull(res, body.model);
    case "/api/create": ollama.models.push({ name: body.model, size: TOTAL }); return reply(res, 200, { status: "success" });
    case "/api/generate": return reply(res, 200, { done: true });
    case "/api/ps": return reply(res, 200, { models: [] });
    case "/api/show": return reply(res, 200, { details: {}, model_info: {} });
    case "/api/chat":
      ollama.chats++;
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      return res.end(JSON.stringify({ message: { role: "assistant", content: "Hello from the stand-in runtime" }, done: true, prompt_eval_count: 3, eval_count: 5 }) + "\n");
  }
  ollama.unknown.push(url.pathname);
  return reply(res, 404, { error: "unknown" });
}
function startStub() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => { let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; } ollamaRoute(req, res, body); });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/* ---------- the stand-in installer (the publisher's checksum list and archive) ---------- */
const archive = Buffer.from("stand-in archive: nothing real is unpacked");
const asset = `ollama-windows-${process.arch === "arm64" ? "arm64" : "amd64"}.zip`;
const installer = { asked: [] };
async function library(input) {
  const url = new URL(typeof input === "string" ? input : input.url ?? input.href);
  installer.asked.push(url.href);
  if (url.hostname === "github.com" && url.pathname.endsWith("/sha256sum.txt")) {
    const sha = crypto.createHash("sha256").update(archive).digest("hex");
    return new Response(`${sha}  ./${asset}\n`, { status: 200 });
  }
  if (url.hostname === "github.com" && url.pathname.endsWith(`/${asset}`))
    return new Response(archive, { status: 200, headers: { "content-length": String(archive.length) } });
  refused.push(url.href);
  throw new TypeError("fetch failed (the verify script refuses every other address)");
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const stub = await startStub();
  const stubPort = stub.address().port;
  /* Fail closed, before the engine is loaded (each part keeps the fetch it was given when it is built). */
  const realFetch = globalThis.fetch;
  let enginePort = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url ?? input.href);
    if ((url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port === "11434")
      return realFetch(`http://127.0.0.1:${stubPort}${url.pathname}${url.search}`, init);
    if (url.hostname === "127.0.0.1" && enginePort && url.port === String(enginePort)) return realFetch(input, init);
    refused.push(url.href);
    throw new TypeError("fetch failed (the verify script refuses every other address)");
  };
  /* A 16 GB computer with a stand-in graphics card, so the large size warns the same way on every machine. */
  os.totalmem = () => 16 * GiB;
  require("node:module").syncBuiltinESMExports();
  const dist = (file) => import(pathToFileURL(path.join(ROOT, "dist", file)).href);
  const { useGraphicsReader } = await dist("local-hardware.js");
  useGraphicsReader(async () => ({ name: "Stand-in graphics", memoryBytes: 8 * GiB, sharedMemory: false }));
  const { createBranch } = await dist("index.js");
  const { startServer } = await dist("server.js");
  const { localKitFor } = await dist("local-kit.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "branch-verify-local-oneclick-"));
  const app = await createBranch({ workspace: path.join(root, "workspace"), dataDir: path.join(root, "data") });
  const kit = localKitFor(app.store);
  const program = "C:/stand-in/Ollama/ollama.exe";
  const ran = [];
  kit.launcher.find = async (id) => (id === "ollama" && ollama.installed ? program : null);
  kit.launcher.isOwn = async () => false;
  kit.launcher.start = async (id) => { if (id === "ollama") ollama.up = true; return { started: true, message: "stand-in started" }; };
  kit.launcher.exists = async () => false;
  kit.launcher.run = async (file, args) => { ran.push([file, ...args]); if (/tar(\.exe)?$/i.test(file)) ollama.installed = true; return { stdout: "" }; };
  kit.oneClick.deps.library = library;
  const server = await startServer(app, { dataDir: path.join(root, "data"), port: Number(process.env.PORT || 0) });
  enginePort = new URL(server.url).port;
  const BASE = server.url.replace(/\/$/, "");
  const call = async (p, body) => {
    const r = await realFetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, origin: BASE, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return r.json();
  };

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let signedIn = false;
  page.on("console", (m) => { if (signedIn && m.type() === "error") errors.push(m.text()); });
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  try {
    /* Nothing starts by itself: a fresh engine has the switches off, no setup and no download. */
    const fresh = await call("local-models");
    check("fresh engine: models on this computer are off, installing is off, no setup, nothing pulled",
      fresh.mode === "off" && fresh.installMode === "off" && (fresh.oneClick?.setups ?? []).length === 0 && ollama.pulls.length === 0 && !fresh.ollama.installed,
      `mode ${fresh.mode}, installMode ${fresh.installMode}, setups ${(fresh.oneClick?.setups ?? []).length}, pulls ${ollama.pulls.length}`);

    await page.goto(BASE + "/");
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator(".ob9").waitFor({ timeout: 30000 });
    signedIn = true;
    await setupRun(page, call, fresh, shot);
    await menuRun(page, call, shot);
    await otherHosts(page, shot);
    const after = await call("local-models");
    check("installing is off again once the install is done", after.installMode === "off", after.installMode);
  } catch (error) {
    check("the run finished", false, error.stack?.split("\n").slice(0, 3).join(" | "));
    await shot("zz-failure").catch(() => undefined);
  } finally {
    check("zero page errors", errors.length === 0, errors.slice(0, 5).join(" | "));
    // Refused as if absent: LM Studio (not running here) and Ollama's size lookup (the engine then treats the size as unknown).
    check("the engine reached no address but the stand-ins", refused.filter((u) => !/^http:\/\/127\.0\.0\.1:1234\/|^https:\/\/(registry\.)?ollama\.(ai|com)\//.test(u)).length === 0, [...new Set(refused)].slice(0, 6).join(" "));
    check("the stand-in Ollama was asked nothing it does not know", ollama.unknown.length === 0, ollama.unknown.join(", "));
    await browser.close();
    await server.close();
    await app.close();
    stub.close();
    for (const [verdict, what, detail] of results) console.log(`${verdict}  ${what}${detail ? `  (${detail})` : ""}`);
    console.log(`${results.filter((r) => r[0] === "PASS").length}/${results.length} passed; the install ran: ${ran.map((c) => path.basename(c[0])).join(", ") || "nothing"}; installer asked ${installer.asked.length} address(es)`);
    process.exit(process.exitCode ?? 0);
  }
})();

/* Reads the bar while a download runs, until the picker shows its done or error panel. */
async function watchProgress(page, scope, midShot = null) {
  const seen = [];
  let shotTaken = false;
  for (let i = 0; i < 400; i++) {
    await dismissCelebration(page);
    const now = await page.evaluate((s) => {
      const bar = document.querySelector(`${s} .lp .progress[aria-valuenow]`);
      const status = document.querySelector(`${s} .lp .status b`);
      return { pct: bar ? Number(bar.getAttribute("aria-valuenow")) : null, amount: document.querySelector(`${s} .lp .lp-amount`)?.textContent ?? "", done: status?.textContent ?? "" };
    }, scope);
    if (now.pct !== null && seen[seen.length - 1]?.pct !== now.pct) seen.push(now);
    if (midShot && !shotTaken && now.pct > 25 && now.pct < 75) { shotTaken = true; await midShot(); }
    if (now.done) return { seen, done: now.done };
    await page.waitForTimeout(120);
  }
  return { seen, done: "" };
}

/* The window's own achievement card can pop up over everything (its first switch changed, for example); it is closed so
   the screenshots show the picker. */
async function dismissCelebration(page) {
  const nice = page.locator('[data-act="ach-close"]');
  if (await nice.count()) await nice.first().click().catch(() => undefined);
}

async function waitForBar(page, scope, above) {
  await page.waitForFunction(([s, a]) => Number(document.querySelector(`${s} .lp .progress[aria-valuenow]`)?.getAttribute("aria-valuenow") ?? -1) > a, [scope, above], { timeout: 20000 });
}

async function helloShown(page, scope) {
  await page.waitForFunction((s) => /It answered in/.test(document.querySelector(`${s} .lp .status p`)?.textContent ?? ""), scope, { timeout: 20000 });
  return page.locator(`${scope} .lp .status p`).textContent();
}

async function cancelRun(page, call, scope, model, label, shot) {
  await page.locator(`${scope} [data-act="lp-pick"][data-v="${model}"]`).click();
  await waitForBar(page, scope, 0);
  await shot(`${label}-downloading`);
  await page.locator(`${scope} [data-act="lp-cancel"]`).click();
  await page.locator(`${scope} .lp .status .sdot.bad`).waitFor({ timeout: 15000 });
  const job = (await call("local-models")).oneClick.setups.find((j) => j.label === model);
  const said = await page.locator(`${scope} .lp .status b`).textContent();
  check(`${label}: Cancel stops the engine's download, and the picker says so in the engine's words`, job?.stage === "stopped" && said === job.message, `${job?.stage}: "${said}"`);
  await shot(`${label}-cancelled`);
  await page.locator(`${scope} .lp [data-act="lp-back"]`).click();
}

async function setupRun(page, call, fresh, shot) {
  await page.locator(".ob-agree").click();
  await page.locator('.ob9 [data-act="ob-next"]').click();
  await page.locator('.ob9 [data-act="ob-next"]').click();
  await page.locator(".ob9 .lp .lp-hero").waitFor({ timeout: 15000 });
  const none = await page.locator(".ob9 .lp-none").textContent().catch(() => "");
  const heading = await page.locator('.ob9 .ob-body p:text-is("Found on this computer:")').count();
  const rows = await page.locator(".ob9 .ob-body > .rows .prow").count();
  check("setup: nothing found is said plainly in one line, never an empty heading",
    none === "No local models found on this computer yet." && (heading === 0 || rows > 0), `"${none}", heading ${heading}, account rows ${rows}`);
  const heroModel = await page.locator(".ob9 .lp-hero .lp-model").textContent();
  const heroText = await page.locator(".ob9 .lp-hero").innerText();
  const best = fresh.recommendations.find((r) => r.model === fresh.suggested);
  check("setup: Choose for me is the engine's suggested model, first and recommended, with its expectation and download size",
    heroModel === fresh.suggested && /Recommended/.test(heroText) && heroText.includes(best.expectation) && /Choose for me/.test(heroText), `${heroModel} / ${fresh.suggested}`);
  const pickRows = await page.locator('.ob9 .lp [data-act="lp-pick"]').count();
  const warned = await page.locator(".ob9 .lp .lp-row.lp-warn").count();
  const tooBig = fresh.recommendations.filter((r) => !r.fits);
  check("setup: Pick one yourself lists the three sizes, and warns about the one that does not fit",
    pickRows === fresh.recommendations.length && warned === tooBig.length && tooBig.length > 0, `${pickRows} rows, ${warned} warned (${tooBig.map((r) => r.model).join(", ")})`);
  await shot("setup-1-nothing-found");

  await page.locator('.ob9 [data-act="lp-auto"]').click();
  await page.locator(".ob9 .lp .lp-plan").waitFor({ timeout: 15000 });
  const planned = await call("local-models");
  check("setup: with Ollama missing, the engine's install plan is shown and nothing is installed or downloaded yet",
    planned.installMode === "off" && !ollama.installed && ollama.pulls.length === 0 && planned.mode === "when-needed", `installMode ${planned.installMode}, installed ${ollama.installed}, pulls ${ollama.pulls.length}, mode ${planned.mode}`);
  await shot("setup-2-install-plan");

  await page.locator('.ob9 [data-act="lp-install"]').click();
  const { seen, done } = await watchProgress(page, ".ob9", () => shot("setup-3-downloading"));
  const data = await call("local-models");
  const job = data.oneClick.setups.find((j) => j.label === fresh.suggested);
  const middle = seen.filter((s) => s.pct > 0 && s.pct < 100);
  check("setup: one click installed Ollama through the engine (stand-in) and downloaded the picked model", ollama.installed && ollama.pulls[0] === fresh.suggested, `installed ${ollama.installed}, pulled ${ollama.pulls.join(", ")}`);
  check("setup: the bar follows the engine's bytes and percent from 0 to 100", middle.length >= 3 && job?.percent === 100 && /of .* · \d+%/.test(middle[0]?.amount ?? ""),
    `${seen.map((s) => s.pct).join(" → ")} then engine ${job?.percent}% ("${middle[0]?.amount}")`);
  const state = await call("state");
  check("setup: the finished model is connected and selected for answering", Boolean(job?.connectionId) && state.activeModel?.presetId === job.connectionId && /is set up and answering/.test(done),
    `${job?.connectionId} / ${state.activeModel?.presetId}: "${done}"`);
  const hello = await helloShown(page, ".ob9");
  check("setup: a hello is answered by the stand-in runtime", /Hello from the stand-in runtime/.test(hello) && ollama.chats >= 2, `"${hello}", ${ollama.chats} chats`);
  await shot("setup-4-answering");

  await page.locator('.ob9 .lp [data-act="lp-back"]').click();
  const answering = await page.locator(".ob9 .lp .lp-found .pill.work").count();
  check("setup: the model now shows as found on this computer, and answering", answering === 1, `${answering}`);
  const small = fresh.recommendations.find((r) => r.size === "small").model;
  await cancelRun(page, call, ".ob9", small, "setup", shot);
}

async function menuRun(page, call, shot) {
  await call("onboarding", { done: true });
  await page.reload();
  await page.locator('[data-act="modelmenu2"]').waitFor({ timeout: 30000 });
  await page.locator('[data-act="modelmenu2"]').click();
  await page.locator('.pop [data-act="lp-open"]').click();
  await page.locator(".dlg .lp .lp-hero").waitFor({ timeout: 15000 });
  const data = await call("local-models");
  await dismissCelebration(page);
  const found = await page.locator(".dlg .lp .lp-found").filter({ has: page.locator(".pill") }).count();
  check("menu: the picker opens from the model menu and lists what is really on this computer", found >= 1 && (await page.locator(".dlg .lp-none").count()) === 0, `${found} set up`);
  await shot("menu-1-picker");
  const large = data.recommendations.find((r) => r.size === "large").model;
  await cancelRun(page, call, ".dlg", large, "menu", shot);
  const small = data.recommendations.find((r) => r.size === "small").model;
  const before = ollama.pulls.length;
  await page.locator(`.dlg [data-act="lp-pick"][data-v="${small}"]`).click();
  const { seen, done } = await watchProgress(page, ".dlg", () => shot("menu-2-downloading"));
  const after = await call("local-models");
  const job = after.oneClick.setups.find((j) => j.label === small && j.stage === "done");
  const state = await call("state");
  check("menu: Pick one downloads with a real bar from 0 to 100", ollama.pulls.length === before + 1 && seen.filter((s) => s.pct > 0 && s.pct < 100).length >= 3 && job?.percent === 100, `${seen.map((s) => s.pct).join(" → ")}`);
  check("menu: it is connected and selected, and the chip shows it", state.activeModel?.presetId === job?.connectionId && /is set up and answering/.test(done), `${state.activeModel?.presetId}`);
  const hello = await helloShown(page, ".dlg");
  check("menu: a hello is answered by the stand-in runtime", /Hello from the stand-in runtime/.test(hello), hello);
  await shot("menu-3-answering");
  await page.locator('.dlg [data-act="dlg-close"]').click();
  await page.waitForFunction((m) => (document.querySelector('[data-act="modelmenu2"]')?.textContent ?? "").includes(m.split(":")[0]), small, { timeout: 10000 });
  check("menu: the composer's chip names the model now answering", true);
  await shot("menu-4-chip");
}

/* The same picker in Settings › Models › On this computer and the Add an account wizard's "On this computer" tab. */
async function otherHosts(page, shot) {
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setpage"][data-v="models"]').click();
  await page.locator('[data-act="mtab"][data-v="local"]').click();
  await page.locator("#main .lp .lp-hero").waitFor({ timeout: 15000 });
  check("Settings › Models › On this computer draws the same picker", (await page.locator('#main .lp [data-act="lp-pick"]').count()) === 3);
  await shot("settings-models-local");
  await page.locator('[data-act="mtab"][data-v="connections"]').click();
  await page.locator('#main .btn.pri[data-act="addacct"]').click();
  await page.locator('.dlg [data-act="aa-grp"][data-v="local"]').waitFor({ timeout: 15000 }).catch(() => undefined);
  const wizard = await page.locator('.dlg [data-act="aa-grp"][data-v="local"]').count();
  if (wizard) {
    await page.locator('.dlg [data-act="aa-grp"][data-v="local"]').click();
    await page.locator(".dlg .lp .lp-hero").waitFor({ timeout: 15000 });
    check("Add an account › On this computer draws the same picker", (await page.locator('.dlg .lp [data-act="lp-pick"]').count()) === 3);
    await shot("account-wizard-local");
  } else check("Add an account › On this computer draws the same picker", false, "the wizard did not open");
}

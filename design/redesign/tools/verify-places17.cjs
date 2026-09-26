// Verifies pass 17's features whose home is a place (Inbox, Automations, Library, Customize) against a real engine:
// clicks every control this area made live and checks, through the engine's own GET routes, that the change really
// happened. Records every page error, and checks that the controls left greyed are greyed.
//
// Some features need a model (a task that hands a step over, a specialist's evaluation), so this script starts a small
// OpenAI-shaped model on this computer (MODEL_PORT, default 43393) and the engine is started pointing at it, with a fresh
// workspace this script fills (WORKSPACE):
//
//   BRANCH_DATA_DIR=<fresh folder> BRANCH_WORKSPACE=<fresh folder> BRANCH_PORT=<port> \
//   BRANCH_PROVIDER=openai BRANCH_ENDPOINT=http://127.0.0.1:43393/v1 BRANCH_MODEL=verify BRANCH_API_KEY=verify \
//   node dist/cli.js start
//   PORT=<port> TOKEN=<hex> WORKSPACE=<that workspace folder> node design/redesign/tools/verify-places17.cjs
//
// The model answers a message with "HANDOVER" in it by calling the engine's user.task tool once; a specialist's
// evaluation prompt by writing the file its check expects; anything else with "Done.".
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = process.env.PORT || "3393";
const TOKEN = process.env.TOKEN || "";
const WORKSPACE = process.env.WORKSPACE || "";
const MODEL_PORT = Number(process.env.MODEL_PORT || 43393);
const BASE = `http://127.0.0.1:${PORT}`;

/* ---------- the model on this computer ---------- */
let asked = 0;
const toolNamed = (body, starts) => (body.tools ?? []).find((t) => String(t.function?.description ?? "").startsWith(starts))?.function?.name;
function answer(body) {
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1] ?? {};
  const text = messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  if (last.role === "tool") return { content: "Done." };
  if (/HANDOVER/.test(text)) {
    const name = toolNamed(body, "Hand something to the person");
    if (name) return { tool: { name, arguments: JSON.stringify({ description: "Sign the renewal form by hand" }) } };
  }
  const write = /EVALUATE-WRITE (\S+) (\S+)/.exec(text);
  if (write) {
    fs.mkdirSync(path.dirname(path.join(WORKSPACE, write[1])), { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE, write[1]), write[2]);
  }
  return { content: "Done." };
}
function reply(res, body) {
  const said = answer(body);
  const usage = { prompt_tokens: 10, completion_tokens: 5 };
  const message = said.tool
    ? { role: "assistant", content: null, tool_calls: [{ id: `call_${asked}`, type: "function", function: said.tool }] }
    : { role: "assistant", content: said.content };
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = said.tool ? { tool_calls: [{ index: 0, id: `call_${asked}`, type: "function", function: said.tool }] } : { content: said.content };
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: said.tool ? "tool_calls" : "stop" }], usage })}\n\n`);
    res.end("data: [DONE]\n\n");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message, finish_reason: said.tool ? "tool_calls" : "stop" }], usage }));
}
function startModel() {
  return new Promise((ready, fail) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); return; }
        if (!req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end("{}"); return; }
        asked += 1;
        reply(res, body);
      });
    });
    server.on("error", fail);
    server.listen(MODEL_PORT, "127.0.0.1", () => ready(server));
  });
}

/* ---------- the engine ---------- */
async function call(method, route, body) {
  const r = await fetch(`${BASE}/api/${route}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`${method} ${route}: ${r.status} ${text.slice(0, 300)}`), { body: text, status: r.status });
  try { return JSON.parse(text); } catch { return text; }
}
const get = (route) => call("GET", route);
const post = (route, body = {}) => call("POST", route, body);
const refusal = (method, route, body) => call(method, route, body).then(() => null, (e) => { try { return JSON.parse(e.body).error; } catch { return e.message; } });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
async function until(what, test, ms = 20000) {
  for (let t = 0; t < ms; t += 400) { const value = await test(); if (value) return value; await sleep(400); }
  throw new Error(`timed out waiting for ${what}`);
}
/* Moves between views the way the window routes a click (not for the controls under test). */
async function act(page, name, data = {}) {
  await page.evaluate(([n, d]) => {
    const b = document.createElement("button");
    b.dataset.act = n;
    Object.assign(b.dataset, d);
    document.getElementById("app").appendChild(b);
    b.click();
    b.remove();
  }, [name, data]);
  await sleep(700);
}
/* The window's level (Regular, Advanced, Technical), set the way Settings sets it. */
const setLevel = (page, level) => act(page, "setlevel", { v: level });
const toastText = (page) => page.locator(".toast span").last().textContent({ timeout: 5000 }).catch(() => "");
const greyed = async (page, selector) => (await page.locator(selector).count()) > 0 && (await page.locator(selector).evaluateAll((els) => els.every((e) => e.getAttribute("aria-disabled") === "true" || e.disabled)));

async function signIn(page) {
  await page.goto(BASE + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#main", { timeout: 15000 });
  await sleep(1500);
}

/* ---------- engine-side setup, all through the engine's routes ---------- */
async function setup() {
  await post("onboarding", { done: true }); // a fresh engine opens on setup until onboarding is done
  await post("safety-extras/switch", { part: "activity-chain", mode: "on" });
  await post("commands/settings", { mode: "on" });
  for (const part of ["orders", "loops"]) await post("autonomy/switch", { part, mode: "when-needed" });
  const handed = await post("run", { prompt: "HANDOVER the signature to me" });
  if (!asked) throw new Error(`The engine did not ask the model on port ${MODEL_PORT}. Start it with BRANCH_PROVIDER=openai BRANCH_ENDPOINT=http://127.0.0.1:${MODEL_PORT}/v1 BRANCH_MODEL=verify BRANCH_API_KEY=verify, then run this again.`);
  await post("adapt/switch", { mode: "when-needed" });
  const stop = await post("adapt/stopped", { runId: handed.id, sessionId: handed.sessionId, what: "The September expense report", done: ["Read the statement"], nextStep: "Match the charges", said: "Models on this computer are switched off" });
  const order = (await post("autonomy/orders", { name: "Receipts in by the 3rd", authority: "Chase missing receipts", start: { kind: "manual" }, escalation: ["A receipt over 200"] })).order;
  await post("commands/run", { surface: "window", line: "/loop every 10m check the build", sessionId: handed.sessionId });
  return { handed, stop, order };
}

/* ---------- Inbox ---------- */
async function inbox(page, s) {
  await act(page, "view", { v: "inbox" });
  await act(page, "ptab", { place: "inbox", v: "needs" });
  const card = `.adapt-b17 [data-act="adaptb17"][data-id="${s.stop.id}"]`;
  await page.waitForSelector(card, { timeout: 10000 });
  check("adapt card: the stop the engine has waiting (GET /api/adapt)", (await page.locator(".adapt-b17 b").first().textContent()) === s.stop.what);
  const plan = await post("adapt/plan", { stopId: s.stop.id });
  await page.click(card);
  await page.waitForSelector(".dlg .lead-b17", { timeout: 8000, state: "attached" });
  check("adaptb17 (What it needs): the engine's own sentence (POST /api/adapt/plan)", (await page.locator(".dlg .lead-b17").textContent()) === plan.message, plan.message);
  check("adaptgob17 and adaptpickb17 stay greyed (a yes installs and starts work: security review)", await greyed(page, '.dlg [data-act="adaptgob17"]') && await greyed(page, '.dlg [data-act="adaptpickb17"]'));
  await page.click('.dlg [data-act="adaptnob17"]');
  await until("the card to go", async () => (await page.locator(card).count()) === 0, 8000);
  check("adaptnob17 (Leave it stopped): no longer waiting (GET /api/adapt)", !(await get("adapt")).stops.some((x) => x.id === s.stop.id));

  const waiting = await until("the handed-over step", async () => (await get("deferred?waiting=1")).deferred[0]);
  await act(page, "ptab", { place: "inbox", v: "later" });
  const done = `.later-b17 [data-act="laterb17"][data-id="${waiting.id}"]`;
  await page.waitForSelector(done, { timeout: 8000 });
  check("Later tab: the job the task handed over, in its own words (GET /api/deferred)", (await page.locator(".later-b17 b").first().textContent()) === waiting.description.split("\n")[0]);
  check("Later tab: the count is the engine's waiting jobs", (await page.locator('[data-act="ptab"][data-v="later"] .n').textContent()) === String((await get("deferred?waiting=1")).deferred.length));
  await page.click(done);
  const settled = await until("the job settled", async () => (await get("deferred")).deferred.find((d) => d.id === waiting.id && d.settledAt));
  check("laterb17 (Done): answered (GET /api/deferred settledAt)", settled && settled.outcome === "Done.");
  await page.waitForSelector(".later-b17 .pill.done", { timeout: 8000 });

  await act(page, "ptab", { place: "inbox", v: "history" });
  await page.click('[data-act="chainb17"]');
  await page.waitForSelector(".dlg .chain-b17", { timeout: 8000 });
  const entries = (await get("safety-extras/activity?limit=50")).entries;
  const shown = await page.locator(".dlg .chain-b17 li").count();
  check("chainb17 (See the chain): one entry per link of the engine's chain (GET /api/safety-extras/activity)", shown === entries.length && shown > 0, `${shown} entries`);
  const withRun = entries.find((e) => e.runId);
  if (withRun) {
    await page.locator(`.dlg [data-act="rcptb17"][data-id="${withRun.runId}"]`).first().click();
    const receipts = await get(`runs/${withRun.runId}/receipts`);
    const bad = ["forged", "modified", "unsigned"].some((k) => (receipts.counts?.[k] ?? 0) > 0);
    await page.waitForSelector(".dlg .chain-b17 .pill", { timeout: 8000 });
    check("rcptb17 (Check this run): the run's receipts as the engine read them (GET /api/runs/{id}/receipts)", (await page.locator(".dlg .chain-b17 .pill").first().textContent()).includes(bad ? "" : "Signed · matches"));
  } else check("rcptb17: a chain entry with a run to check", false, "no entry had a runId");
  check("chaintamperb17 stays greyed (it would draw made-up entries)", await greyed(page, '.dlg [data-act="chaintamperb17"]'));
  await act(page, "dlg-close");
}

/* ---------- Automations ---------- */
async function automations(page, s) {
  await act(page, "view", { v: "automations" });
  await act(page, "ptab", { place: "automations", v: "scheduled" });
  const pause = `[data-act="orderb17"][data-id="${s.order.id}"]`;
  await page.waitForSelector(pause, { timeout: 10000 });
  await page.click(pause);
  await until("the order paused", async () => (await get("autonomy/orders")).orders.find((o) => o.id === s.order.id).status === "paused");
  check("orderb17 (Pause): paused (GET /api/autonomy/orders)", true);
  await page.waitForSelector(`${pause}[data-v="resume"]`, { timeout: 8000 });
  await page.click(pause);
  await until("the order kept again", async () => (await get("autonomy/orders")).orders.find((o) => o.id === s.order.id).status === "active");
  check("orderb17 (Resume): kept again (GET /api/autonomy/orders)", true);
  await page.click('[data-act="ordersb17"]');
  await page.waitForSelector(".dlg #order-in-b17", { timeout: 8000 });
  check("ordersb17 (How they work): lists the engine's orders; Add it stays greyed", (await page.locator(".dlg .prow b").first().textContent()) === s.order.order.name && await greyed(page, '.dlg [data-act="orderaddb17"]'));
  await act(page, "dlg-close");
  const stopLoop = `[data-act="loopb17"][data-id="${s.handed.sessionId}"]`;
  await page.waitForSelector(stopLoop, { timeout: 8000 });
  await page.click(stopLoop);
  await until("the loop stopped", async () => ["done", undefined].includes((await get("autonomy/loops")).loops.find((l) => l.sessionId === s.handed.sessionId)?.status));
  check("loopb17 (Stop): stopped (GET /api/autonomy/loops)", true);

  await setLevel(page, "advanced");
  await act(page, "ptab", { place: "automations", v: "scheduled" });
  await page.waitForSelector('[data-act="pauseallb17"]', { timeout: 8000 });
  const said = await refusal("POST", "dashboard/automations", { paused: true });
  await page.click('[data-act="pauseallb17"]');
  check("pauseallb17 with the dashboard off: the engine's refusal as it said it", said && (await toastText(page)) === said, said);
  await post("dashboard/settings", { mode: "on" }).catch(() => null);
  await act(page, "ptab", { place: "automations", v: "scheduled" });
  await sleep(1000);
  await page.click('[data-act="pauseallb17"][data-v="pause"]');
  await until("paused", async () => (await get("dashboard")).paused);
  check("pauseallb17 (Pause all): paused (GET /api/dashboard paused)", true);
  await page.waitForSelector('[data-act="pauseallb17"][data-v="resume"]', { timeout: 8000 });
  await page.click('[data-act="pauseallb17"][data-v="resume"]');
  await until("resumed", async () => !(await get("dashboard")).paused);
  check("pauseallb17 (Resume all): resumed (GET /api/dashboard paused)", true);

  const demos = [["readiness", "autonomy/readiness", "skills"], ["holidays", "calendar", null], ["watches", "monitors", "monitors"], ["leads", "asks/leads", "top"], ["forecast", "asks/forecasts", "open"]];
  for (const [k, route, key] of demos) {
    await page.click(`[data-act="demob17"][data-k="${k}"]`);
    await page.waitForSelector(".dlg .demo-b17", { timeout: 8000, state: "attached" });
    const engine = await get(route);
    const n = key ? engine[key].length : engine.settings.daysOff.length;
    check(`demob17 ${k}: one row per engine item (GET /api/${route})`, (await page.locator(".dlg .demo-b17 .prow").count()) === n, `${n} rows`);
    await act(page, "dlg-close");
  }
  await page.click('[data-act="demob17"][data-k="readiness"]');
  await page.waitForSelector('.dlg [data-act="demodob17"]', { timeout: 8000 });
  await page.click('.dlg [data-act="demodob17"]');
  await page.waitForSelector('.dlg .lead-b17', { timeout: 8000 });
  const ledger = (await get("autonomy/ledger?status=all")).entries.length;
  check("demodob17 readiness (Open the ledger): the engine's ledger (GET /api/autonomy/ledger)", (await page.locator(".dlg .demo-b17 .prow").count()) === ledger, `${ledger} entries`);
  await act(page, "dlg-close");

  await act(page, "ptab", { place: "automations", v: "triggers" });
  for (const [k, route, key] of [["outhook", "webhooks", "webhooks"], ["hooks", "hooks", "hooks"]]) {
    await page.click(`[data-act="demob17"][data-k="${k}"]`);
    await page.waitForSelector(".dlg .demo-b17", { timeout: 8000, state: "attached" });
    check(`demob17 ${k}: one row per engine item (GET /api/${route}); its primary stays greyed`, (await page.locator(".dlg .demo-b17 .prow").count()) === (await get(route))[key].length && await greyed(page, '.dlg [data-act^="demodob17"]'));
    await act(page, "dlg-close");
  }
  await setLevel(page, "regular");
}

const STEPS = [inbox, automations];

async function run() {
  const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");
  const model = await startModel();
  const s = await setup();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await signIn(page);
    for (const step of STEPS) {
      await page.keyboard.press("Escape").catch(() => null);
      try { await step(page, s); } catch (error) { check(`step ${step.name} ran`, false, error.message.split("\n")[0]); }
    }
  } finally {
    check("zero page errors", errors.length === 0, errors.join(" | "));
    await browser.close();
    model.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

if (require.main === module) run().catch((e) => { console.error(e); process.exit(1); });

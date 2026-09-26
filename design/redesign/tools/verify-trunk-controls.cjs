// Pause a Trunk and pause all, a room's answering rule and its own way of working together, and the owner's default way
// Trunks work together: each control made live here is clicked and its change read back through the engine's GET route.
// Run against a fresh engine: PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-trunk-controls.cjs
// Setup through the API (not window controls): onboarding done, Trunks and rooms switched on, two Trunks and a room made.
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("PORT and TOKEN are required"); process.exit(2); }
const base = `http://127.0.0.1:${PORT}`;
const api = async (path, body) => {
  const r = await fetch(`${base}/api/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${r.status} ${data.error}`);
  return data;
};
const RUN = Date.now().toString(36).slice(-5);
const N = { a: `Pause A ${RUN}`, b: `Pause B ${RUN}`, room: `Rules room ${RUN}`, made: `Led room ${RUN}` };
let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await new Promise((r) => setTimeout(r, 200)); } return null; };
const trunk = async (name) => (await api("trunks")).trunks.find((t) => t.name === name);
const roomNamed = async (name) => (await api("trunks")).rooms.find((r) => r.name === name);
const greyed = async (loc) => (await loc.getAttribute("aria-disabled")) === "true";

async function setup() {
  await api("onboarding", { done: true });
  await api("trunks/switch", { part: "trunks", mode: "on" });
  await api("trunks/switch", { part: "rooms", mode: "on" });
  const a = (await api("trunks", { name: N.a })).trunk, b = (await api("trunks", { name: N.b })).trunk;
  await api("trunks/rooms", { name: N.room, members: [a.id, b.id] });
  return { a, b };
}

async function signIn(page) {
  await page.goto(base + "/");
  await page.getByLabel("Session token").fill(TOKEN);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForSelector("#side .machine");
  await page.waitForTimeout(1200);
}

async function customizeTrunks(page, a) {
  await page.locator('[data-act="view"][data-v="customize"]').click();
  await page.locator('#main [data-act="ptab"][data-v="trunks"]').click();
  const button = page.locator(`#main [data-act="pausetrunk"][data-id="${a.id}"]`);
  check("pausetrunk is live in Customize › Trunks", !(await greyed(button)));
  await button.click();
  check("pausetrunk: GET /api/trunks says it is paused", !!(await until(async () => (await trunk(N.a)).paused === true)));
  check("the row reads paused, and its button Resume", await until(async () => (await button.innerText()) === "Resume" && /· paused/.test(await page.locator("#main .prow", { hasText: N.a }).innerText())));
  check("its face is drawn paused", (await page.locator("#main .prow", { hasText: N.a }).locator(".av.paused").count()) === 1);
  await button.click();
  check("resume: GET /api/trunks says it is not paused", !!(await until(async () => !(await trunk(N.a)).paused)));
}

async function railAndChat(page, a) {
  await api(`trunks/${a.id}/pause`, {});
  await page.reload();
  await page.waitForSelector("#side .machine");
  const row = page.locator(`#side .row[data-id="${a.chatSessionId}"]`);
  check("the rail row wears the paused pill, and its face is drawn paused", !!(await until(async () => (await row.locator("b .paused").innerText()) === "paused" && (await row.locator(".av.paused").count()) === 1)));
  await row.click();
  check("the conversation header says it won't start anything new", !!(await until(async () => /Paused · won’t start anything new/.test(await page.locator(".head .who small").innerText()))));
  await page.locator('[data-act="chatmenu"]').first().click();
  const item = page.locator('.pop [data-act="pausetrunk"]');
  check("the conversation menu offers Resume", (await item.innerText()).trim() === "Resume");
  await item.click();
  check("resume from the menu: GET /api/trunks says it is not paused", !!(await until(async () => !(await trunk(N.a)).paused)));
  await page.click(`#side .row[data-id="${a.chatSessionId}"]`, { button: "right" });
  await page.locator('.pop [data-act="pausetrunk"]').click();
  check("Pause from the row's own menu: GET /api/trunks says it is paused", !!(await until(async () => (await trunk(N.a)).paused === true)));
  await api(`trunks/${a.id}/resume`, {});
}

async function overview(page) {
  await page.locator('[data-act="view"][data-v="overview"]').first().click();
  const button = page.locator('#main [data-act="pauseall"]');
  check("pauseall is live on the overview", !(await greyed(button)));
  await button.click();
  check("pauseall: GET /api/trunks says every Trunk is paused", !!(await until(async () => (await api("trunks")).trunks.every((t) => t.paused))));
  check("the button now reads Resume all Trunks", !!(await until(async () => (await button.innerText()) === "Resume all Trunks")));
  await button.click();
  check("resume all: GET /api/trunks says no Trunk is paused", !!(await until(async () => (await api("trunks")).trunks.every((t) => !t.paused))));
  const log = await api("audit");
  const entries = (log.entries ?? log).filter((e) => e.action === "trunk.paused");
  check("each pause and resume is in the activity log (GET /api/audit)", entries.some((e) => e.subject === "All Trunks" && e.outcome === "paused") && entries.some((e) => e.subject === "All Trunks" && e.outcome === "resumed"), `${entries.length} entries`);
}

async function newRoomRule(page, a, b) {
  await page.locator('[data-act="view"][data-v="customize"]').click();
  await page.locator('#main [data-act="ptab"][data-v="trunks"]').click();
  await page.locator('#main [data-act="grp-new"]').click();
  const dlg = page.locator(".dlg");
  await dlg.locator("#grp-name").fill(N.made);
  await dlg.locator(`[data-act="grp-pick"][data-v="${a.id}"]`).click();
  await dlg.locator(`[data-act="grp-pick"][data-v="${b.id}"]`).click();
  check("grp-rule starts on the engine's default, mentions only", (await dlg.locator('[data-act="grp-rule"][data-v="mention"]').getAttribute("aria-pressed")) === "true");
  await dlg.locator('[data-act="grp-rule"][data-v="lead"]').click();
  check("grp-rule: A lead Trunk decides is pressed", (await dlg.locator('[data-act="grp-rule"][data-v="lead"]').getAttribute("aria-pressed")) === "true");
  await dlg.locator('[data-act="grp-make"]').click();
  const made = await until(() => roomNamed(N.made));
  check("grp-make with grp-rule: GET /api/trunks has the room with rule lead", made?.rule === "lead", JSON.stringify(made && { rule: made.rule }));
}

async function roomRules(page) {
  const r = await roomNamed(N.room);
  await page.click(`#side .row[data-id="${r.sessionId}"]`);
  await page.waitForTimeout(500);
  await page.locator('[data-act="chatmenu"]').first().click();
  await page.locator('.pop [data-act="room-rules"]').click();
  const dlg = page.locator(".dlg");
  await dlg.locator('[data-act="room-rule"][data-v="all"]').click();
  check("room-rule: GET /api/trunks has the room's rule everyone", !!(await until(async () => (await roomNamed(N.room)).rule === "all")));
  await dlg.locator('[data-act="room-pat"][data-v="swarm"]').click();
  check("room-pat: GET /api/trunks has the room's own way, swarm", !!(await until(async () => (await roomNamed(N.room)).pattern === "swarm")));
  check("the dialog shows swarm pressed", !!(await until(async () => (await dlg.locator('[data-act="room-pat"][data-v="swarm"]').getAttribute("aria-pressed")) === "true")));
  check("Teams stays greyed in the room's rules", await greyed(dlg.locator('[data-act="room-pat-teams"]')));
  await dlg.locator('[data-act="room-pat"][data-v="swarm"]').click();
  check("choosing it again follows the owner's default (pattern null)", !!(await until(async () => (await roomNamed(N.room)).pattern === null)));
  check("and none is pressed", !!(await until(async () => (await dlg.locator('[data-act="room-pat"][aria-pressed="true"]').count()) === 0)));
  await page.waitForTimeout(300);
  await dlg.locator('.dlg-f [data-act="dlg-close"]').click();
}

async function patterns(page) {
  await page.locator('[data-act="view"][data-v="customize"]').click();
  await page.locator('#main [data-act="ptab"][data-v="specialists"]').click();
  const cards = page.locator('#main .pat15[aria-checked="true"]');
  check("pat15: Branch picks by default, so no card is checked (GET /api/orchestration auto)", (await cards.count()) === 0 && (await api("orchestration")).pattern === "auto");
  const swarm = page.locator('#main [data-act="pat15"][data-v="swarm"]');
  check("pat15 is live", !(await greyed(swarm)));
  check("Teams stays greyed", await greyed(page.locator('#main [data-v="teams"].pat15')));
  await swarm.click();
  check("pat15: GET /api/orchestration says swarm", !!(await until(async () => (await api("orchestration")).pattern === "swarm")));
  check("the Swarm card is checked", !!(await until(async () => (await swarm.getAttribute("aria-checked")) === "true")));
  await swarm.click();
  check("choosing it again gives it back to Branch (auto)", !!(await until(async () => (await api("orchestration")).pattern === "auto")));
}

(async () => {
  const { a, b } = await setup();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await signIn(page);
    await customizeTrunks(page, a);
    await railAndChat(page, a);
    await overview(page);
    await newRoomRule(page, a, b);
    await roomRules(page);
    await patterns(page);
    check("no page errors", errors.length === 0, errors.join("; "));
  } catch (error) {
    check("the run finished", false, error.message);
  } finally {
    await browser.close();
  }
  console.log(failed ? `${failed} failed` : "all checks passed");
  process.exit(failed ? 1 : 0);
})();

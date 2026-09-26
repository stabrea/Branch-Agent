/* Clicks every control the settings-b area (Permissions, Computer & browser, Saved sign-ins, Data & usage, Gateway,
   Branch itself, Updates & about, Achievements, Advanced, Developer) made live, against a running engine, and confirms
   each change through the engine's own GET route. Each switch is flipped and then flipped back, so the engine ends as
   it began. Run it only against a throwaway engine:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-settings-b.cjs
   It starts no stand-in servers. */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}

const settle = (page, ms = 700) => page.waitForTimeout(ms);
async function openPage(page, id) {
  if (!(await page.locator(".settings").count())) { await page.keyboard.press("Control+,"); await page.locator(".settings").waitFor(); }
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).first().click();
  await settle(page, 1500);
}

const onMode = (m) => Boolean(m) && m !== "off";
const f15 = (t) => "f15-" + t.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
const coding = (part) => async () => onMode((await api("coding")).modes[part]);
const interop = (part) => async () => onMode((await api("interop")).parts.find((p) => p.part === part)?.mode);

/* [page, switch id, what the engine says now] */
const SWITCHES = [
  ["achievements", "ach-q", async () => (await api("delight")).settings.achievements.quiet === true],
  ["computer", f15("Page notes and “Send to Branch”"), async () => onMode((await api("browser/notes/settings")).settings.mode)],
  ["computer", f15("Try ideas on a branch"), coding("worktrees")],
  ["computer", f15("Check and format files after editing"), coding("format-on-edit")],
  ["computer", f15("Draft a pull request from a task"), async () => onMode((await api("developer/pull-requests")).mode)],
  ["computer", f15("Remember the shell"), coding("shell-snapshot")],
  ["computer", f15("Read a file before editing it"), coding("read-first")],
  ["computer", f15("Keep large tool outputs"), coding("large-output")],
  ["computer", f15("Read Jupyter notebooks"), coding("notebooks")],
  ["computer", f15("Review checks and a checklist per task"), async () => { const m = (await api("coding")).modes; return onMode(m["review-checks"]) && onMode(m.checklist); }],
  ["developer", "dv-ls", async () => (await api("developer/language-servers")).enabled === true],
  ["developer", "dv-dbg", async () => (await api("developer/debug-adapters")).enabled === true],
  ["developer", f15("Flow search"), interop("flow-search")],
  ["developer", f15("Send metrics with OpenTelemetry"), async () => onMode((await api("usage/counters")).counters.mode)],
  ["developer", f15("Is Branch keeping up"), async () => onMode((await api("event-loop")).settings.mode)],
];

async function flip(page, pageId, id, engine) {
  const box = page.locator(`#${id}`);
  await box.waitFor({ state: "attached", timeout: 10000 });
  if ((await box.getAttribute("aria-disabled")) === "true" || (await box.isDisabled())) { check(`${pageId} › ${id} is live`, false, "greyed"); return; }
  const before = await engine();
  check(`${pageId} › ${id} shows the engine's value`, (await box.isChecked()) === before, String(before));
  for (const want of [!before, before]) {
    await page.locator(`#${id}`).click();
    await settle(page, 1200);
    const now = await engine();
    check(`${pageId} › ${id} → ${want ? "on" : "off"} in the engine`, now === want, String(now));
    check(`${pageId} › ${id} redraws as the engine says`, (await page.locator(`#${id}`).isChecked()) === now);
  }
}

async function copyAddress(page) {
  await openPage(page, "developer");
  await page.locator('[data-act="dv-copy"]').click();
  await settle(page);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check("dv-copy copies the address this window talks to", copied === `127.0.0.1:${PORT}`, copied);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(BASE + "/");
    await page.getByLabel("Session token").fill(TOKEN);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.locator("#main").waitFor();
    await settle(page, 1500);
    let current = null;
    for (const [pageId, id, engine] of SWITCHES) {
      if (pageId !== current) { await openPage(page, pageId); current = pageId; }
      await flip(page, pageId, id, engine);
    }
    await copyAddress(page);
  } catch (e) { check("script finished", false, e.message); }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();

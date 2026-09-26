/* rw4-i18n: the window's words that went through no translation now go through t() (public/i18n.js, public/locales).
   Proves it in the real window against a FRESH engine (onboarding not done), once in French and once in English:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-i18n.cjs
   The language is the saved choice public/i18n.js reads (localStorage "branch-language"); the window's Language select
   is not live yet. Each pass: the setup dialog's name, Find's "No matches", Inbox › History › Verify (its answer read
   back from POST /api/safety-extras/activity/verify, the route the window calls), and a bad theme code's message.
   The English pass also checks no raw key ("window.…") is on screen. Page errors must be zero. Nothing is saved. */
const { chromium } = require("C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright");

const PORT = process.env.PORT, TOKEN = process.env.TOKEN;
if (!PORT || !TOKEN) { console.error("Set PORT and TOKEN."); process.exit(2); }
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

async function api(p, body) {
  const r = await fetch(`${BASE}/api/${p}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${data?.error ?? r.status}`);
  return data;
}
async function words(lang) { return (await fetch(`${BASE}/locales/${lang}.json`)).json(); }

async function open(browser, lang) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript((l) => { try { localStorage.setItem("branch-language", l); } catch { /* checked below */ } }, lang);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/");
  await page.getByLabel("Session token", { exact: true }).fill(TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  return { context, page, errors };
}

async function pass(browser, lang, W) {
  const { context, page, errors } = await open(browser, lang);
  check(`${lang}: <html lang> is ${lang}`, (await page.evaluate(() => document.documentElement.lang)) === lang);

  // Setup opens on a fresh engine (GET /api/state onboarding.done is false); its dialog is named in the language.
  const state = await api("state");
  const setup = page.locator(".ob9[role=dialog]");
  await setup.waitFor({ timeout: 30000 });
  check(`${lang}: engine says onboarding is not done`, state.onboarding?.done !== true);
  check(`${lang}: setup dialog is named "${W["window.setup.label"]}"`, (await setup.getAttribute("aria-label")) === W["window.setup.label"]);
  await page.locator('[data-act="ob-close"]').first().click();
  await page.locator("#prompt").waitFor({ timeout: 30000 });

  // Find in this conversation: words that are nowhere give "No matches".
  await page.locator('[data-act="find-open"]').first().click();
  await page.locator("#find9-q").fill("zqxjvkwq");
  await page.waitForTimeout(400);
  const none = (await page.locator("#find9-n").textContent())?.trim();
  check(`${lang}: Find shows "${W["window.find.none"]}"`, none === W["window.find.none"], none);
  await page.locator("#find9-q").press("Escape");

  // Inbox › History › Verify: the window's answer matches the engine's own verify result.
  await page.locator('#side [data-act="view"][data-v="inbox"]').first().click();
  await page.locator('[data-act="ptab"][data-place="inbox"][data-v="history"]').first().click();
  await page.locator('[data-act="verify15"]').first().click();
  const engine = (await api("safety-extras/activity/verify", {})).check;
  const want = engine.ok ? W["window.inbox.intact"] : engine.reason;
  await page.locator("#ver-t15").filter({ hasText: /\S/ }).waitFor({ timeout: 10000 });
  const said = (await page.locator("#ver-t15").textContent())?.trim();
  check(`${lang}: Verify says "${want}" (engine check.ok=${engine.ok})`, said === want, said);
  await page.locator('.dlg [data-act="dlg-close"], [data-act="dlg-close"]').first().click();
  if (engine.ok) {
    const chip = (await page.locator('[data-act="verify15"] span').first().textContent())?.trim();
    check(`${lang}: History's Verify button reads "${want}" after the check`, chip === want, chip);
  }

  // Settings › Appearance › Browse themes › Paste a theme code: a code that is not one is refused in the language.
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setpage"][data-v="appearance"]').first().click();
  await page.locator('[data-act="skins"]').first().click();
  await page.locator('[data-act="my-paste"]').first().click();
  await page.locator("#paste6").fill("not a theme code");
  await page.locator('[data-act="my-paste-go"]').click();
  const why = (await page.locator("#paste6-why").textContent())?.trim();
  check(`${lang}: a bad theme code says "${W["window.themes.not-a-code"]}"`, why === W["window.themes.not-a-code"], why);

  if (lang === "en") {
    const raw = await page.evaluate(() => {
      const labels = [...document.querySelectorAll("[aria-label]")].map((n) => n.getAttribute("aria-label")).join("\n");
      return (document.body.innerText + "\n" + labels).match(/\bwindow\.[a-z]+\.[a-z-]+/g) || [];
    });
    check("en: no raw key (window.…) on screen", raw.length === 0, raw.join(", "));
  }
  check(`${lang}: zero page errors`, errors.length === 0, errors.join(" | "));
  await context.close();
}

(async () => {
  const [fr, en] = await Promise.all([words("fr"), words("en")]);
  check("French words differ from English for the keys checked", ["window.setup.label", "window.find.none", "window.inbox.intact", "window.themes.not-a-code"].every((k) => fr[k] && fr[k] !== en[k]));
  const browser = await chromium.launch({ headless: true });
  try {
    await pass(browser, "fr", fr);
    await pass(browser, "en", en);
  } finally { await browser.close(); }
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });

/* rw4-i18n: the window's words that went through no translation now go through t() (public/i18n.js, public/locales).
   Proves it in the real window against a FRESH engine (onboarding not done), once in French and once in English:
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> BRANCH_PORT=<port> node dist/cli.js start
     PORT=<port> TOKEN=<hex> node design/redesign/tools/verify-i18n.cjs
   The language is the saved choice public/i18n.js reads (localStorage "branch-language"); the engine's own language
   (GET /api/look) is put back to "auto" first so it does not override that. Each pass: the setup dialog's name, Find's
   "No matches", Inbox › History › Verify (its answer read back from POST /api/safety-extras/activity/verify, the route
   the window calls), and a bad theme code's message. The English pass also checks no raw key ("window.…") is on screen.
   rw4-language: the locale files are cached (an ETag, 304 when unchanged, no-cache so a new build comes fresh), and
   Settings › Appearance › Language is live: picking Français saves it to the engine (GET /api/look says fr) and to this
   browser, and the window redraws in French; after a reload, and in a new browser with nothing saved, it is still
   French and the select shows Français; Español cannot be picked; English again says "English." (the prototype's toast).
   Page errors must be zero. The engine's language is left at "auto" at the end. */
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

/* lang null: nothing is put in the browser's storage; the window's own choice (and the engine's) decide. */
async function open(browser, lang) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  if (lang) await context.addInitScript((l) => { try { localStorage.setItem("branch-language", l); } catch { /* checked below */ } }, lang);
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

/* rw4-language: the words are kept by the browser and asked about again: an unchanged file answers 304 with no body. */
async function caching() {
  const first = await fetch(`${BASE}/locales/en.json`);
  const etag = first.headers.get("etag"), cc = first.headers.get("cache-control");
  await first.arrayBuffer();
  check("en.json answers 200 with an ETag", first.status === 200 && /^"[\w-]+"$/.test(etag ?? ""), etag);
  check("en.json may be kept but is checked each time (no-cache, not no-store)", cc === "no-cache", cc);
  const again = await fetch(`${BASE}/locales/en.json`, { headers: { "if-none-match": etag } });
  const body = await again.arrayBuffer();
  check("asked again with that ETag: 304 and no body", again.status === 304 && body.byteLength === 0, `${again.status}, ${body.byteLength} bytes`);
  const stale = await fetch(`${BASE}/locales/en.json`, { headers: { "if-none-match": '"not-this-build"' } });
  check("another build's ETag gets the words again (200)", stale.status === 200 && (await stale.arrayBuffer()).byteLength > 0, String(stale.status));
  const fr = await fetch(`${BASE}/locales/fr.json`);
  await fr.arrayBuffer();
  check("fr.json has its own ETag", fr.headers.get("etag") && fr.headers.get("etag") !== etag);
  const other = await fetch(`${BASE}/app/main.js`);
  await other.arrayBuffer();
  check("other files are still no-store", other.headers.get("cache-control") === "no-store", other.headers.get("cache-control"));
}

const lang = (page) => page.evaluate(() => document.documentElement.lang);
const saved = (page) => page.evaluate(() => { try { return localStorage.getItem("branch-language"); } catch { return "unreadable"; } });
const shown = (page) => page.locator("#lang").evaluate((s) => ({ value: s.value, text: s.selectedOptions[0]?.textContent ?? "", disabled: s.disabled }));
async function closeSetup(page) {
  const setup = page.locator(".ob9[role=dialog]");
  await setup.waitFor({ timeout: 30000 }).catch(() => null);
  if (await setup.isVisible()) await page.locator('[data-act="ob-close"]').first().click();
  await page.locator("#prompt").waitFor({ timeout: 30000 });
}
async function openAppearance(page) {
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setpage"][data-v="appearance"]').first().click();
  await page.locator("#lang").waitFor();
}

async function languageSelect(browser, W, E) {
  const { context, page, errors } = await open(browser, null);
  await closeSetup(page);
  await openAppearance(page);
  const before = await shown(page);
  check("select: shows the language in force (English), live", before.value === "en" && before.text === "English" && !before.disabled, JSON.stringify(before));
  const options = await page.locator("#lang option").evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent, off: o.disabled, tip: o.dataset.tip ?? "" })));
  check("select: the prototype's five, in its words", options.map((o) => o.t).join("|") === "English|Français|Español|Deutsch|Yorùbá", options.map((o) => o.t).join("|"));
  check("select: English and Français can be picked", options.filter((o) => ["en", "fr"].includes(o.v)).every((o) => !o.off));
  check("select: Español, Deutsch, Yorùbá are greyed with Coming soon", options.filter((o) => !["en", "fr"].includes(o.v)).every((o) => o.off && o.tip === "Coming soon"), JSON.stringify(options));

  await page.locator("#lang").selectOption("fr");
  await page.waitForFunction(() => document.documentElement.lang === "fr", null, { timeout: 15000 });
  check("Français: the engine keeps it (GET /api/look language = fr)", (await api("look")).language === "fr");
  check("Français: this browser keeps it (localStorage)", (await saved(page)) === "fr");
  let now = await shown(page);
  check("Français: the select, drawn again, shows Français", now.value === "fr" && now.text === "Français", JSON.stringify(now));
  await page.locator('[data-act="skins"]').first().click();
  await page.locator('[data-act="my-paste"]').first().click();
  await page.locator("#paste6").fill("not a theme code");
  await page.locator('[data-act="my-paste-go"]').click();
  const why = (await page.locator("#paste6-why").textContent())?.trim();
  check("Français: words drawn after the change are French (a bad theme code)", why === W["window.themes.not-a-code"], why);
  await page.keyboard.press("Escape");
  await page.locator("#paste6").waitFor({ state: "detached", timeout: 5000 }).catch(() => null);

  let refused = false;
  try { await page.locator("#lang").selectOption("es", { timeout: 2000 }); } catch { refused = true; }
  now = await shown(page);
  check("Español: cannot be picked", refused && now.value === "fr", `refused=${refused}, value=${now.value}`);
  check("Español: the engine still says fr", (await api("look")).language === "fr");

  await page.reload();
  await page.waitForFunction(() => document.documentElement.lang === "fr", null, { timeout: 30000 });
  await closeSetup(page);
  await openAppearance(page);
  now = await shown(page);
  check("after a reload: still French, the select shows Français", (await lang(page)) === "fr" && now.value === "fr" && now.text === "Français", JSON.stringify(now));
  check("zero page errors (first browser)", errors.length === 0, errors.join(" | "));
  await context.close();

  // A new browser: nothing saved in it, so the first words are English until the engine's choice is read.
  const fresh = await open(browser, null);
  await fresh.page.waitForFunction(() => document.documentElement.lang === "fr", null, { timeout: 30000 }).catch(() => null);
  await closeSetup(fresh.page);
  await openAppearance(fresh.page);
  now = await shown(fresh.page);
  check("new browser: French from the engine, the select shows Français", (await lang(fresh.page)) === "fr" && now.value === "fr" && now.text === "Français", JSON.stringify(now));

  await fresh.page.locator("#lang").selectOption("en");
  await fresh.page.waitForFunction(() => document.documentElement.lang === "en", null, { timeout: 15000 });
  const said = (await fresh.page.locator(".toast").first().textContent().catch(() => ""))?.trim();
  check('English again: the prototype\'s toast "English."', said === "English.", said);
  check("English again: the engine says en", (await api("look")).language === "en");
  now = await shown(fresh.page);
  check("English again: the select shows English", now.value === "en" && now.text === "English", JSON.stringify(now));
  check("English again: a word drawn by t() is English", (await fresh.page.evaluate(async () => (await import("/i18n.js")).t("window.find.none"))) === E["window.find.none"]);
  check("zero page errors (new browser)", fresh.errors.length === 0, fresh.errors.join(" | "));
  await fresh.context.close();
}

(async () => {
  const [fr, en] = await Promise.all([words("fr"), words("en")]);
  check("French words differ from English for the keys checked", ["window.setup.label", "window.find.none", "window.inbox.intact", "window.themes.not-a-code"].every((k) => fr[k] && fr[k] !== en[k]));
  await api("look", { language: "auto" }); // the engine's choice would override the passes' saved one
  await caching();
  const browser = await chromium.launch({ headless: true });
  try {
    await pass(browser, "fr", fr);
    await pass(browser, "en", en);
    await languageSelect(browser, fr, en);
  } finally {
    await browser.close();
    await api("look", { language: "auto" }).catch((error) => console.error(error.message));
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });

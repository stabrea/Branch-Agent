/* Opening a page the way a person does in the redesigned window (public/layout.js): a place in the
   sidebar, then its tab, or the gear, then a Settings page. Every step is a real click on a visible
   control, so a test that uses these still proves the way in works. */

/* The names pages had before the redesign, and the place and tab that hold them now. */
const TABS = {
  runs: { place: "inbox", tab: "history", oldView: "runs" },
  memory: { place: "library", tab: "memory", oldView: "memory" },
  documents: { place: "library", tab: "documents", oldView: "documents" },
  skills: { place: "customize", tab: "skills", oldView: "skills" },
  specialists: { place: "customize", tab: "specialists", oldView: "specialists" },
  procedures: { place: "automations", tab: "procedures", oldView: "procedures" },
  schedules: { place: "automations", tab: "scheduled", oldView: "schedules" },
};

/** The window is rebuilt by the last script on the page, which can still be loading when the workspace appears
    (for well over thirty seconds on a busy shared build machine). */
const ready = (page) => page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });

/** On a narrow window the sidebar is folded away, so it is slid open before anything in it is used. */
async function railControl(page, selector) {
  const control = page.locator(selector);
  if (!(await control.isVisible())) await page.locator("#rail-toggle").click();
  return control;
}

/* The calm window (the default since 0.18.1) keeps the places in the More menu and Settings in one
   row at the foot of the rail; the full window ("Show everything") keeps them in the rail and the gear. */
const calm = (page) => page.evaluate(() => document.documentElement.dataset.everything !== "on");
async function openPlaceLink(page, place) {
  if (!(await calm(page))) return (await railControl(page, `.lx-place-link[data-place="${place}"]`)).click();
  await page.locator("#lx-more").click();
  await page.locator(`#lx-more-menu .lx-more-item[data-kind="view"][data-target="${place}"]`).click();
}
const settingsEntry = async (page) => (await calm(page) ? railControl(page, "#lx-settings-row") : railControl(page, ".lx-gear"));

/** A tab is open only when both its control and its panel report the same selected place. */
const placeTabIsOpen = (page, place, tab) => page.evaluate(({ place, tab }) => {
  const trigger = document.querySelector(`.lx-tab[data-place="${place}"][data-tab="${tab}"]`);
  const panel = document.querySelector(`.lx-panel[data-place="${place}"][data-tab="${tab}"]`);
  return trigger?.getAttribute("aria-selected") === "true" && panel?.hidden === false;
}, { place, tab });

const placeTabBecameOpen = (page, place, tab) => page.waitForFunction(({ place, tab }) => {
  const trigger = document.querySelector(`.lx-tab[data-place="${place}"][data-tab="${tab}"]`);
  const panel = document.querySelector(`.lx-panel[data-place="${place}"][data-tab="${tab}"]`);
  return trigger?.getAttribute("aria-selected") === "true" && panel?.hidden === false;
}, { place, tab }, { timeout: 20000 }).then(() => true, () => false);

/**
 * Opens a page by its old name ("memory", "runs", "settings", "usage", "chat") or its new one
 * ("customize:plugins", "settings:models"). Can also pass tab as a separate argument.
 * If place is given without a tab, defaults to opening the place's first tab.
 */
export async function openPlace(page, view, tabArg) {
  await ready(page);
  if (view === "chat") {
    await closeSettings(page);
    const back = page.locator(".lx-back");
    if (await back.isVisible()) await back.click();
    return;
  }
  if (view === "settings") return openSettings(page);
  if (view === "usage") return openSettings(page, "data");
  if (view.startsWith("settings:")) return openSettings(page, view.slice("settings:".length));
  const oldTab = TABS[view];
  let place, tab;
  if (tabArg) {
    place = view;
    tab = tabArg;
  } else if (view.includes(":")) {
    [place, tab] = view.split(":");
  } else if (oldTab) {
    [place, tab] = [oldTab.place, oldTab.tab];
  } else {
    // No tab specified and not an old tab name - use the place as-is and open its first visible tab
    place = view;
    // Let the browser find the first tab for this place
    tab = null;
  }
  await closeSettings(page);
  await openPlaceLink(page, place);
  if (!tab) {
    // Find and click the first tab for this place
    const firstTab = page.locator(`.lx-tab[data-place="${place}"]`).first();
    const tabName = await firstTab.getAttribute("data-tab");
    tab = tabName;
  }
  const trigger = oldTab ? `.lx-tab[data-view="${oldTab.oldView}"]` : `.lx-tab[data-place="${place}"][data-tab="${tab}"]`;
  if (await placeTabIsOpen(page, place, tab)) return;
  await pressUntil(page.locator(trigger),
    () => placeTabBecameOpen(page, place, tab),
    `${place} ${tab} tab to open`);
}

/**
 * Activates one control and waits for its effect. Some shared runners have left Playwright's mouse
 * dispatch waiting even though the control is visible, enabled and stable. Repeating the same click
 * hid that transport failure. We now report it, check whether the first click landed, then use the
 * control's keyboard activation once. That still exercises the browser's real button semantics and
 * cannot double-toggle a click whose effect already appeared.
 */
export async function pressUntil(target, happened, what = "the press to take") {
  let mouseFailure = "the mouse click completed but its effect did not appear";
  try {
    await target.click({ timeout: 20000 });
  } catch (error) {
    mouseFailure = `the mouse click failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (await happened()) return;
  console.warn(`[ui-test] ${mouseFailure}; trying Enter for ${what}`);
  let keyboardFailure = "Enter completed but its effect did not appear";
  try {
    await target.focus({ timeout: 10000 });
    await target.press("Enter", { timeout: 10000 });
  } catch (error) {
    keyboardFailure = `Enter failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (await happened()) return;
  throw new Error(`Waited for ${what}: ${mouseFailure}; ${keyboardFailure}`);
}

/** Waits up to 20 s for something on the page to become true, and says whether it did. */
export const became = (page, isSo) =>
  page.waitForFunction(isSo, null, { timeout: 20000 }).then(() => true, () => false);

/** Finishes the optional first-run screen without depending on one mouse packet reaching Chromium. */
export async function finishFirstRun(page) {
  const panel = page.locator("#first-run");
  if (!(await panel.isVisible())) return;
  await pressUntil(page.getByRole("button", { name: /Try it without an account/ }),
    () => panel.waitFor({ state: "hidden", timeout: 20000 }).then(() => true, () => false),
    "first run to finish");
}

/** Presses the gear until the Settings window is really open. */
async function pressUntilOpen(page) {
  const settings = page.locator("#settings-window");
  await pressUntil(await settingsEntry(page),
    () => settings.waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false),
    "the Settings window to open");
}

/** Opens the Settings window, on a page when one is named. */
export async function openSettings(page, name) {
  await ready(page);
  if (!(await page.locator("#settings-window").isVisible())) await pressUntilOpen(page);
  if (name) {
    /* phase2/settings: on a narrow window the pages are one choice under the search box. */
    const link = page.locator(`.lx-settings-link[data-page="${name}"]`);
    if (await link.isVisible()) await link.click();
    else await page.locator("#sg-page-pick").selectOption(name);
  }
  await showEveryCard(page);
}

/**
 * phase2/settings: Settings shows the cards of the chosen level (Regular by default). A test that is about
 * one card shows every card of the open page, the way "Go there" and a link to a setting do, without
 * changing the level (which would also change the calm window).
 */
export async function showEveryCard(page) {
  await page.evaluate(() => globalThis.branchSettingsLevel.peekPage());
}

export async function closeSettings(page) {
  if (await page.locator("#settings-window").isVisible()) await page.locator(".lx-settings-close").click();
}

/** Opens whichever Settings page (and Models tab) holds this element, by clicking through to it. */
export async function openSettingFor(page, selector) {
  await ready(page);
  const where = await page.evaluate((css) => {
    const node = document.querySelector(css);
    return { page: node?.closest(".lx-page")?.dataset.page, sub: node?.closest(".lx-subpanel")?.dataset.sub };
  }, selector);
  if (!where.page) throw new Error(`${selector} is not on any Settings page`);
  await openSettings(page, where.page);
  if (where.sub) await page.locator(`#lx-page-models .lx-subtab[data-sub="${where.sub}"]`).click();
}

/**
 * Switches on "Show everything" (0.18.1) for a test that exercises the full window's own controls —
 * the tabs, meter, switches and icons the calm default keeps behind More. It is saved the way the
 * Settings switch saves it, then shown at once. The calm default has its own tests (calm-ui.test.mjs).
 */
export async function showEverything(page, patch = { showEverything: true }) {
  await ready(page);
  await page.evaluate(async (changes) => {
    const { applyAppearance, currentAppearance } = await import("/appearance.js");
    const value = { ...currentAppearance(), ...changes };
    const response = await fetch("/api/preferences", {
      method: "POST",
      headers: { authorization: "Bearer " + sessionStorage.getItem("branch-token"), "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    if (!response.ok) throw new Error("the preference was refused");
    applyAppearance(value);
  }, patch);
  if (patch.showEverything) await page.waitForFunction(() => document.documentElement.dataset.everything === "on");
}

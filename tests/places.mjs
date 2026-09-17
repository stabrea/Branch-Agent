/* Opening a page the way a person does in the redesigned window (public/layout.js): a place in the
   sidebar, then its tab, or the gear, then a Settings page. Every step is a real click on a visible
   control, so a test that uses these still proves the way in works. */

/* The names pages had before the redesign, and the place and tab that hold them now. */
const TABS = {
  runs: ["inbox", "runs"],
  memory: ["library", "memory"],
  documents: ["library", "documents"],
  skills: ["customize", "skills"],
  specialists: ["customize", "specialists"],
  procedures: ["automations", "procedures"],
  schedules: ["automations", "schedules"],
};

/** The window is rebuilt by the last script on the page, which can still be loading when the workspace appears. */
const ready = (page) => page.locator("body.lx-ready").waitFor({ state: "attached" });

/** On a narrow window the sidebar is folded away, so it is slid open before anything in it is used. */
async function railControl(page, selector) {
  const control = page.locator(selector);
  if (!(await control.isVisible())) await page.locator("#rail-toggle").click();
  return control;
}

/**
 * Opens a page by its old name ("memory", "runs", "settings", "usage", "chat") or its new one
 * ("customize:plugins", "settings:models").
 */
export async function openPlace(page, view) {
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
  const [place, tab] = TABS[view] ?? view.split(":");
  await closeSettings(page);
  await (await railControl(page, `.lx-place-link[data-place="${place}"]`)).click();
  const trigger = TABS[view] ? `.lx-tab[data-view="${tab}"]` : `.lx-tab[data-place="${place}"][data-tab="${tab}"]`;
  await page.locator(trigger).click();
}

/** Opens the Settings window, on a page when one is named. */
export async function openSettings(page, name) {
  await ready(page);
  if (!(await page.locator("#settings-window").isVisible())) await (await railControl(page, ".lx-gear")).click();
  if (name) await page.locator(`.lx-settings-link[data-page="${name}"]`).click();
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

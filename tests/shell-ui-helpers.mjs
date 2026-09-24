import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";
import { openPlace, showEverything } from "./places.mjs";

/* Wave 9 redesign: four places in the sidebar, and Settings behind the gear (public/layout.js). */
export const PLACES = ["Inbox", "Automations", "Library", "Customize"];

export async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-shell-ui-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  /* Redesign phase 1: a conversation begun in the window starts on Ask first. These tests are about
     something else, so their conversations follow the setting as before (tests/conversation-mode.test.mjs
     covers Ask first). */
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  /* These tests are about the full shell: every rail row, icon, tab and meter. Since 0.18.1 that is
     "Show everything"; the calm default has its own tests in calm-ui.test.mjs. */
  await showEverything(page);
  return { page, server, errors };
}

export const look = (page) => page.evaluate(() => ({ ...document.documentElement.dataset }));

export const SIZES = [
  { width: 1280, height: 800 },
  { width: 1024, height: 700 },
  { width: 400, height: 800 },
];

/** True when two boxes share any pixel. */
export const boxesHit = (page, one, two) =>
  page.evaluate(
    ([a, b]) => {
      const first = document.querySelector(a).getBoundingClientRect();
      const second = document.querySelector(b).getBoundingClientRect();
      return !(first.bottom <= second.top || second.bottom <= first.top);
    },
    [one, two],
  );

/** Walks Tab and reports where the focus landed each time. */
export async function tabStops(page, count) {
  const stops = [];
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press("Tab");
    stops.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName));
  }
  return stops;
}

/** Every screen the owner can open, as [how it is opened, the element that holds it]. */
export const SETTINGS_PAGES = ["general", "assistant", "instructions", "appearance", "notifications", "models", "accounts", "voice", "permissions",
  "computer", "secrets", "data", "advanced", "about", "trunks", "channels", "connections", "skills", "memory", "automations"];

export const SCREENS = [
  ["chat", "chat"], ["runs", "runs"], ["memory", "memory"], ["skills", "skills"], ["specialists", "specialists"],
  ["procedures", "procedures"], ["schedules", "schedules"], ["documents", "documents"],
  ["inbox:needs", "lx-slot-inbox-needs"], ["inbox:finished", "lx-slot-inbox-finished"],
  ["automations:triggers", "lx-slot-automations-triggers"], ["library:made", "lx-slot-library-made"],
  ["customize:plugins", "lx-slot-customize-plugins"], ["customize:connections", "lx-slot-customize-connections"],
  ["customize:channels", "lx-slot-customize-channels"],
  ...SETTINGS_PAGES.map((page) => [`settings:${page}`, `lx-page-${page}`]),
];

/** Opens a screen, letting the rail slide over first on a narrow window. */
export async function openScreen(page, view) {
  await openPlace(page, view);
  await page.evaluate(() => document.body.classList.remove("rail-open"));
  await page.waitForTimeout(350);
}

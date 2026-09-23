/* DG-017: every three-way switch reads Off · When needed · On, in that order, as the approved sample draws each
   one (design/Branch-Grown-Up.html, the live `invControlHTML`: `["off", "needed", "on"]` through `TRI_WORD`, for
   every three-way setting in its inventory, the saved sign-in's included). The saved values do not change, so
   nothing migrates. The list below is the sample's own inventory of three-way settings (its `INV` entries of type
   "three-way", file SHA-256 65d28f8b…78ee3), plus the four the app has that the sample's inventory predates, so a
   switch that is never drawn fails instead of passing unseen. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings, showEverything } from "./places.mjs";

const SAMPLE_THREE_WAYS = [
  "flows-switch-install-requests", "recordings-mode", "heartbeat-mode", "quiet-switch-scripts",
  "autonomy-switch-suggestions", "flows-switch-kanban", "flows-switch-waiting-line", "autonomy-switch-orders",
  "context-switch-heartbeat", "autonomy-switch-loops", "autonomy-switch-session-commands",
  "flows-switch-time-travel", "flows-switch-recipe-checks", "prompts-mode", "context-switch-sop",
  "autonomy-switch-procedures", "personal-switch-tunnel", "learning-core-mode", "asks-switch-hindsight",
  "lmore-switch-blocks", "lmore-switch-journey", "lmore-switch-meaning-search", "lmore-switch-lessons",
  "lmore-switch-session-lessons", "lmore-switch-expiry", "lmore-switch-readback", "lmore-switch-providers",
  "context-switch-memory", "asks-switch-source-sync", "reach-switch-notes", "asks-switch-answer-engine",
  "asks-switch-answer-pages", "asks-switch-article-writer", "asks-switch-live-surfaces", "flows-switch-widgets",
  "asks-switch-intent-pipeline", "reach-switch-agent-git", "reach-switch-skill-bundles", "lmore-switch-curator",
  "skill-installs-mode", "context-switch-tools", "new-skills-switch", "autonomy-switch-readiness",
  "trunks-switch-trunks", "reach-switch-remote-trunks", "addons-packages", "addons-lists", "addons-filters",
  "addons-pipelines", "addons-drafts", "addons-search", "addons-export", "personal-switch-google",
  "personal-switch-microsoft", "personal-switch-spotify", "personal-switch-x-search",
  "personal-switch-home-control", "asks-switch-app-blocks", "asks-switch-app-server",
  "interop-switch-agent-protocol", "interop-switch-client-tools", "interop-switch-modes",
  "interop-switch-project-routing", "interop-switch-fleet", "interop-switch-handoff", "interop-switch-flow-search",
  "interop-switch-agent-market", "telegram-setup-mode", "channel-setup-mode", "channels-more-irc",
  "channels-more-twitch", "channels-more-gotify", "channels-more-imessage", "channels-more-msteams-bot",
  "channels-more-webex", "channels-more-synology-chat", "channels-more-zalo", "channels-more-flock",
  "channels-more-pumble", "channels-more-mastodon", "channels-more-bluesky", "channels-more-reddit",
  "channels-more-discourse", "channels-more-x-dm", "channels-more-twist", "channels-more-nextcloud-talk",
  "channels-more-sms", "channels-more-ntfy", "channels-more-pushover", "channels-more-threema",
  "channels-more-homeassistant", "channels-more-xmpp", "channels-more-mqtt", "channels-more-keybase",
  "channels-more-simplex", "channels-more-deltachat", "channels-more-nostr", "channels-more-vk",
  "channels-more-qq-bot", "channels-more-guilded", "channels-more-revolt", "channels-more-mumble",
  "channels-more-kook", "channels-more-wechat-mp", "channels-more-wecom-app", "chat-live-status",
  "chat-live-commands", "chat-live-steering", "chat-live-splitting", "devices-mode", "personal-switch-chat-files",
  "personal-switch-mail-search", "reach-switch-relay", "reach-switch-send", "reach-switch-platform-pause",
  "dashboard-mode", "never-break-mode", "commands-mode", "asks-switch-project-board", "people-admin-mode",
  "context-switch-agents", "context-switch-soul", "context-switch-identity", "context-switch-user",
  "autonomy-switch-instructions", "flows-switch-focus", "quiet-switch-news", "accounts-mode",
  "asks-switch-runtimes", "savings-difficulty-mode", "local-models-mode", "reach-switch-arena",
  "video-programs-mode", "reach-switch-video", "wake-word-mode", "dictation-mode", "system-voice-card-mode",
  "personal-switch-spoken-brief", "personal-switch-voice-approvals", "speech-engines-mode",
  "approval-reviewer-mode", "folder-trust-mode", "loop-guard-mode", "safety-switch-tool-scripts",
  "safety-switch-wasm-add-ons", "safety-switch-code-approvals", "safety-switch-command-scan",
  "safety-switch-progress-judge", "safety-switch-activity-chain", "safety-switch-history-repair",
  "security-audit-mode", "security-malware-mode", "os-sandbox-mode", "screen-switch-card-mode", "asks-switch-nodes",
  "reach-switch-machines", "reach-switch-background-screen", "reach-switch-usb", "keychain-card-mode",
  "vault-autofill-mode", "goal-undo-goal", "goal-undo-snapshots", "move-in-mode", "usage-report-mode",
  "asks-switch-analytics", "wsedit-mode", "pull-requests-mode", "adapt-mode", "sdk-kit-mode", "counters-mode",
  "event-loop-mode", "coding-switch-format-on-edit", "coding-switch-shell-snapshot", "coding-switch-mentions",
  "coding-switch-worktrees", "coding-switch-init", "coding-switch-ci", "coding-switch-checklist",
  "coding-switch-path-rules", "coding-switch-large-output", "coding-switch-notebooks",
  "coding-switch-review-checks", "trunks-switch-rooms", "trunks-switch-messages", "trunks-switch-routines",
  "trunks-switch-teach", "local-install-mode"
];
const APP_ONLY = ["activity-log-mode", "coding-switch-fewer-rounds", "coding-switch-read-first", "jev-mode"];
/* Drawn only once one-click model setup is switched on and a program is found, which a test machine cannot
   promise; its positions are checked in its source below. */
const DRAWN_LATER = { "local-install-mode": "only once setting up a model with one click is on" };
const WORDS = { en: ["Off", "When needed", "On"], fr: ["Désactivé", "Au besoin", "Activé"] };

async function everySwitch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-three-way-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  /* Everything drawn: the full window, the highest level, and every page opened once so its cards arrive. */
  await showEverything(page);
  await openSettings(page);
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical"));
  const pages = await page.evaluate(() => [...document.querySelectorAll(".lx-settings-link[data-page]")].map((link) => link.dataset.page));
  for (const name of pages) await openSettings(page, name);
  /* Two draw only when asked: the stopped-task card when it comes into view, the Trunks parts once Trunks are on. */
  await openSettings(page, "advanced");
  await page.evaluate(() => document.getElementById("adapt-card").scrollIntoView());
  await page.evaluate(() => {
    const trunks = document.getElementById("trunks-switch-trunks");
    trunks.value = "on";
    trunks.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const ids = [...SAMPLE_THREE_WAYS, ...APP_ONLY].filter((id) => !(id in DRAWN_LATER));
  await page.waitForFunction((list) => list.every((id) => document.getElementById(id)), ids, { timeout: 20000 }).catch(() => undefined);
  return { page, errors, ids };
}

/** Each switch as a person meets it: the words in the order shown, and the value each one saves. */
const read = (page, ids) => page.evaluate((list) => list.map((id) => {
  const node = document.getElementById(id);
  if (!node) return { id, drawn: false };
  const group = node.closest(".segmented-control");
  const shown = group ? [...group.querySelectorAll(".segmented-option")] : [...node.options];
  return { id, drawn: true, words: shown.map((one) => one.textContent.trim()), values: shown.map((one) => one.dataset.v ?? one.value) };
}), ids);

test("DG-017 every three-way reads Off · When needed · On in that order, saving the same values, in English and French", async (t) => {
  const { page, errors, ids } = await everySwitch(t);
  for (const language of ["en", "fr"]) {
    if (language !== "en") await page.evaluate(async (code) => (await import("/i18n.js")).setLanguage(code), language);
    const seen = await read(page, ids);
    assert.deepEqual(seen.filter((one) => !one.drawn).map((one) => one.id), [], "every three-way the sample has is drawn");
    const wrong = seen.filter((one) => one.words.join(" · ") !== WORDS[language].join(" · ") || one.values.join(" ") !== "off when-needed on");
    assert.deepEqual(wrong, [], `${language}: ${wrong.length} of ${seen.length} switches read otherwise`);
  }
  assert.deepEqual(errors, []);
});

test("DG-017 the switch drawn only later is built from the same three positions, in the same order", async () => {
  const script = await readFile(new URL("../public/local-oneclick.js", import.meta.url), "utf8");
  assert.match(script, /select\.id = "local-install-mode";[\s\S]*?for \(const \[value, key\] of positions\)/, "local-install-mode draws the shared positions");
  const declared = script.match(/const positions = (\[\[.*?\]\]);/s);
  assert.deepEqual(JSON.parse(declared[1]), [["off", "field.switch-off"], ["when-needed", "field.switch-when-needed"], ["on", "field.switch-on"]]);
});

test("DG-017 no words a person reads still name a position the switches no longer have", async () => {
  const old = /Only when it is needed|Only when needed|Only when unsure|Only when I ask for it|When I press Send|After tasks finish|Seulement si nécessaire|Seulement en cas de besoin|Seulement si besoin|Seulement en cas de doute|Seulement quand je le demande/;
  for (const file of ["en", "fr"]) {
    const words = JSON.parse(await readFile(new URL(`../public/locales/${file}.json`, import.meta.url), "utf8"));
    assert.deepEqual(Object.entries(words).filter(([, value]) => old.test(value)).map(([key]) => key), [], file);
  }
});

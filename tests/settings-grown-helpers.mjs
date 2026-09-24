import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

export const ROOT = join(import.meta.dirname, "..");
export const INVENTORY = JSON.parse(await readFile(join(ROOT, "tests", "fixtures", "settings-inventory.json"), "utf8")).settings;
export const { SETTINGS_INDEX } = await import("../public/settings-index.js");
export const { BUCKETS } = await import("../public/settings-buckets.js");
export const INDEX = new Map(SETTINGS_INDEX.map((row) => [row[0], row]));

/* Switches that act on this computer the moment they are on (start at sign-in, keep running, install a
   model runner, use the screen, a USB watcher, other machines). The walk leaves them alone; what sits
   behind them is found through its card instead. */
export const LEAVE_OFF = ["never-break-card", "deployment-card", "local-models-card", "os-sandbox-card", "screen-switch-card", "wake-word-form",
  "reach-usb-card", "reach-background-card", "desktop-card", "reach-machines-card", "asks-nodes-card", "remote-card"];

export async function fixture(t, { width = 1440, height = 950, preferences } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-grown-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  if (preferences) app.store.save("settings", app.runtime.owner, "preferences", preferences);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [], refused = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) refused.push(message.text()); });
  await page.addInitScript(() => {
    globalThis.__refused = [];
    document.addEventListener("securitypolicyviolation", (event) => globalThis.__refused.push(`${event.violatedDirective} ${event.sourceFile}:${event.lineNumber}`));
  });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  return { page, call, errors, refused, app, url: server.url, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } };
}

/** The cog at the right end of the icon line over the account row (DG-094): the calm window's, or the full window's. */
export const cog = (page) => page.locator(".lx-foot-line > .sg-gear:visible");

export async function openSettings(page, name) {
  if (!(await page.locator("#settings-window").isVisible())) {
    /* On a phone the rail, with the account row and the cog at its foot, opens from the title bar. */
    if (!(await cog(page).count())) await page.locator("#rail-toggle").click();
    await cog(page).click();
  }
  if (!name) return;
  /* DG-013: on a phone the pages are a strip of tabs; a click scrolls the tab into view first. */
  await page.locator(`.lx-settings-link[data-page="${name}"]`).click();
}

/** Every place, every Settings page and every Models tab, so every module has drawn its cards. */
export async function visitEverything(page) {
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    for (const home of globalThis.branchLayout.homes()) if (!home.startsWith("settings")) { globalThis.branchLayout.go(home); await wait(150); }
  });
  await openSettings(page);
  const pages = await page.evaluate(() => [...document.querySelectorAll(".lx-settings-link")].map((link) => link.dataset.page));
  for (const name of [...pages, "models"]) { await openSettings(page, name); await page.waitForTimeout(150); }
  for (const tab of await page.locator("#lx-page-models .lx-subtab").all()) { await tab.click(); await page.waitForTimeout(150); }
}

/** Turns on every feature switch that only changes a record, so what sits behind a switch is drawn too. */
export async function switchEverythingOn(page) {
  for (let round = 0; round < 3; round++) {
    await page.evaluate((leave) => {
      for (const select of document.querySelectorAll("select")) {
        const values = [...select.options].map((option) => option.value);
        if (!values.includes("on") || !values.includes("off") || select.value === "on") continue;
        if (leave.some((id) => select.closest(`#${id}`))) continue;
        select.value = "on";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, LEAVE_OFF);
    await page.waitForTimeout(2500);
  }
}

/** Where each setting's control is: settings:<page>[:<tab>], <place>:<tab>, or null when there is none. */
export function whereEach(page) {
  return page.evaluate((rows) => Object.fromEntries(rows.map(([id, , card, , , selector]) => {
    const node = document.getElementById(id) ?? (selector ? document.querySelector(selector) : null);
    if (!node) return [id, null];
    const settingsPage = node.closest(".lx-page"), sub = node.closest(".lx-subpanel"), panel = node.closest(".lx-panel");
    if (settingsPage) return [id, `settings:${settingsPage.dataset.page}${sub ? ":" + sub.dataset.sub : ""}`];
    if (panel) return [id, `${panel.dataset.place}:${panel.dataset.tab}`];
    return [id, "elsewhere"];
  })), [...INDEX.values()]);
}

/** Runs in the page: sideways overflow of the window or the page, and chips, pills and badges outside their card. */
export function sweep() {
  const out = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) out.push(`the window scrolls sideways by ${doc.scrollWidth - doc.clientWidth}px`);
  const body = document.getElementById("lx-settings-body");
  if (body.scrollWidth > body.clientWidth + 1) out.push(`the page scrolls sideways by ${body.scrollWidth - body.clientWidth}px`);
  const chips = document.querySelectorAll("#lx-settings-body :is(.chip, .pill, .badge, .status-pill, .lx-count, [class*='chip'], [class*='pill'], [class*='badge'], .sg-more, .kit-scope)");
  for (const chip of chips) {
    if (!chip.checkVisibility()) continue;
    // A visually hidden chip is 1px and clipped: it is read aloud, never drawn, and cannot
    // overflow anything a person sees. `checkVisibility()` still calls it visible.
    if (chip.classList.contains("sr-only")) continue;
    const card = chip.closest(".lx-page > *, .lx-subpanel > *");
    if (!card) continue;
    const a = chip.getBoundingClientRect(), b = card.getBoundingClientRect();
    if (a.width === 0) continue;
    if (a.right > b.right + 1 || a.left < b.left - 1) out.push(`${chip.className || chip.tagName} "${chip.textContent.trim().slice(0, 30)}" leaves ${card.id || card.className}`);
    if (chip.scrollWidth > chip.clientWidth + 1 && getComputedStyle(chip).textOverflow !== "ellipsis") out.push(`${chip.className} "${chip.textContent.trim().slice(0, 30)}" is cut off`);
  }
  return out;
}

export async function cardState(page, id) {
  return page.evaluate((cardId) => {
    const card = document.getElementById(cardId);
    return card ? { level: card.dataset.level ?? "none", hidden: card.hidden, visible: card.checkVisibility(), peeked: "sgPeek" in card.dataset } : null;
  }, id);
}

export const SETTINGS_DIRECTORIES = {
  connections: [["connections", "customize", "connections"]],
  skills: [["skills", "customize", "skills"], ["specialists", "customize", "specialists"], ["plugins", "customize", "plugins"]],
  memory: [["memory", "library", "memory"], ["documents", "library", "documents"], ["made", "library", "made"]],
  automations: [["scheduled", "automations", "scheduled"], ["procedures", "automations", "procedures"],
    ["triggers", "automations", "triggers"], ["needs", "inbox", "needs"], ["history", "inbox", "history"]],
};

export const NOT_IN_SEARCH = {
  /* Written by Branch itself (when something last happened, which run holds the browser), never by a person. */
  writtenByBranch: [
    "AnalyticsSettings.decidedAt", "AnalyticsSettings.lastSentAt", "BriefSettings.nextAt", "BriefSettings.lastSentAt",
    "AttachSettings.runId", "AttachSettings.grantedAt", "ConsolidationSettings.lastRunAt", "RelaySettings.machineId",
  ],
  /* Switches beside the message box (the More menu), not on a Settings page. */
  besideTheMessageBox: [
    "AskFirstSettings.askFirst", "PlanActSettings.planMode",
  ],
  /* Read from the launch configuration (the integrations file and the keep-running gateway's file), not saved from the window. */
  launchConfiguration: [
    "GitConfig.github", "GitConfig.githubApp", "GitConfig.gitlab", "IssuesConfig.github", "IssuesConfig.linear",
    "IssuesConfig.gitlab", "IssuesConfig.jira", "BrowserConfig.allowedOrigins", "BrowserConfig.maxRuns",
    "BrowserConfig.maxOriginsPerRun", "BrowserConfig.maxDownloadBytes", "BrowserConfig.downloadTypes",
    "GitHubAppConfig.appId", "GitHubAppConfig.privateKeySecret", "GitHubAppConfig.installationId",
    "GitHubConfig.apiBase", "GitHubConfig.tokenSecret", "GitHubConfig.timeoutMs", "GitHubConfig.maxBytes",
    "GitLabConfig.apiBase", "GitLabConfig.tokenSecret", "GitLabConfig.timeoutMs", "GitLabConfig.maxBytes",
    "JiraConfig.site", "JiraConfig.emailSecret", "JiraConfig.tokenSecret", "JiraConfig.timeoutMs",
    "JiraConfig.maxBytes", "LinearConfig.apiBase", "LinearConfig.tokenSecret", "LinearConfig.timeoutMs",
    "LinearConfig.maxBytes", "ShellConfig.executables", "ShellConfig.inheritEnv", "ShellConfig.env",
    "ShellConfig.timeoutMs", "ShellConfig.maxMemoryMb", "ShellConfig.maxCpuSeconds", "ShellConfig.maxOutputBytes",
    "ShellConfig.netless", "ShellConfig.useJobObject", "GatewayConfig.startSeconds", "GatewayConfig.holdSeconds",
    "GatewayConfig.maxQuickCrashes", "GatewayConfig.gapSeconds", "GatewayConfig.watchSeconds",
    "GatewayConfig.workerEnv",
  ],
  /* Found by the 2026-09-19 sweep with no Settings search entry. Each still needs a look: a control to index, or a
     reason it has none (many are set through the assistant, a command or the API). Listed in docs/agents/STATUS-p2-settings.md.
     Only ever take names off this list. */
  notYetReviewed: [
    "AccountsSettings.poolingRule", "AccountsSettings.poolingNotices", "AskFirstSettings.maxQuestions",
    "AnalyticsSettings.consent", "HindsightSettings.budget", "BatchSettings.minQuestions", "BatchSettings.maxWaitMs",
    "BatchSettings.pollMs", "BatchSettings.discount", "BriefSettings.dailyAt", "BriefSettings.deliverTo",
    "BriefSettings.template", "BriefSettings.sections", "WebhookAddressSettings.acceptOldAddresses",
    "WebhookAddressSettings.oldAddressesEndOn", "CodeRunSettings.python", "CodeRunSettings.timeoutMs",
    "CodeRunSettings.maxMemoryMb", "CodeRunSettings.maxCpuSeconds", "CodeRunSettings.maxOutputBytes",
    "FormatSettings.formatters", "FormatSettings.diagnostics", "FormatSettings.waitMs", "FormatSettings.timeoutMs",
    "RepositoryContextSettings.repositoryContextFiles", "RepositoryContextSettings.repositoryOutlineTokens",
    "CredentialSettings.services", "CredentialSettings.bitwardenCommand", "CredentialSettings.onePasswordCommand",
    "CredentialSettings.timeoutMs", "DebugSettings.maxMemoryMb", "DebugSettings.maxCpuSeconds",
    "DebugSettings.timeoutMs", "DocumentSettings.embeddingModel", "LiveScoringSettings.scorers",
    "EventLoopSettings.stallMs", "HeartbeatSettings.deliverTo", "KnowledgeSettings.maxIndexTokens",
    "KnowledgeSettings.compareAtMost", "LanguageServerSettings.maxMemoryMb", "LanguageServerSettings.maxCpuSeconds",
    "LanguageServerSettings.timeoutMs", "LearnSettings.steps", "ListenSettings.where", "RoutingSettings.localPreset",
    "RoutingSettings.cloudPreset", "MediaSettings.imagePrices", "ConsolidationSettings.everyHours",
    "MemoryRetrievalSettings.embeddingModel", "OrchestrationSettings.autoPlan", "OrchestrationSettings.planApproval",
    "OrchestrationSettings.verify", "OrchestrationSettings.milestoneRounds", "OrchestrationSettings.stuckAction",
    "PeopleSettings.extra", "HomeSettings.tokenName", "HomeSettings.domains", "SignInSettings.clientSecretName",
    "SignInSettings.tenant", "SpokenBriefSettings.calendar", "SpokenBriefSettings.morningBrief",
    "SpokenBriefSettings.maxCharacters", "PullRequestHookSettings.base", "BackgroundSettings.maxRunning",
    "BackgroundSettings.maxMinutes", "BackgroundSettings.maxMemoryMb", "BackgroundSettings.maxCpuSeconds",
    "BackgroundSettings.bufferBytes", "PlatformSettings.paused", "VideoSettings.pricePerSecond",
    "CacheSettings.ttlMinutes", "CacheSettings.maxEntries", "RetrievalPipelineSettings.byCollection",
    "RerankSettings.candidates", "RecordingSettings.keepPictures", "GovernanceSettings.excludeAfterFailures",
    "GovernanceSettings.windowMinutes", "GovernanceSettings.recoveryAfterMinutes",
    "GovernanceSettings.demoteAfterFailures", "StudySettings.benchmarksFolder", "SuggestionsSettings.updates",
    "TraceExportSettings.destination", "TraceExportSettings.headers", "TraceExportSettings.batchSize",
    "TraceExportSettings.retries", "TraceExportSettings.serviceName", "TraceExportSettings.includeErrors",
    "TroubleshootSettings.maxTries", "VaultAutofillSettings.timeoutMs", "SecretCommandSettings.timeoutMs",
    "KeychainSettings.timeoutMs", "WakeWordSettings.windowSeconds", "VoiceSettings.sttModel",
    "VoiceSettings.ttsModel", "VoiceSettings.localSpeechKind", "VoiceSettings.localSpeechStream",
  ],
};

export const SAFETY = {
  permissions: ["policy-card", "safety-stop-card", "approval-reviewer-card"],
  computer: ["desktop-card", "reach-background-card"],
  general: ["deployment-card"],
  about: ["updates-card", "comfort-updates-card"],
};

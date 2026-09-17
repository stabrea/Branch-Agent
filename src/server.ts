import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { quietJobsApi } from "./scheduler.js";
import { finishChatGPTSignIn, syncChatGPTPresets } from "./chatgpt-presets.js";
import { embedSettings, widgetOrigin } from "./embeds.js";
import { RunInputSchema, errorText } from "./contracts.js";
import { CompletionCheckSchema } from "./reliability.js";
import { liveActivity } from "./activity.js";
import { PlanStepSchema, orchestrationSettings, saveOrchestrationSettings } from "./orchestration.js";
import {
  PlanActSettingsSchema, autonomyWords, planModeWords, projectPlanAct, saveProjectPlanAct,
  saveSessionPlanAct, sessionPlanAct, clearSessionPlanAct,
} from "./plan-act.js";
import { secondOpinionSettings, saveSecondOpinionSettings } from "./second-opinion.js";
import { classifyToolEvent } from "./receipts.js";
import { SkillScanPolicySchema } from "./skill-scan.js";
import { PackageInstallSchema } from "./skill-packages.js";
import { browserSkillList, browserSkillPackage } from "./browser-skills.js";
import { readAttachSettings, saveAttachSettings } from "./integrations/browser-attach.js";
import { refusedHosts } from "./integrations/desktop-config.js";
import { draftFromRuns, testSkill } from "./skill-authoring.js";
import { suggestSkills } from "./skill-suggest.js";
import { healthReport } from "./health.js";
import { maximumBackupBytes } from "./backup.js";
import { chatCompletion, modelsList } from "./openai-compat.js";
import { AnthropicProvider, GeminiProvider, OpenAIProvider } from "./providers.js";
import { allPresets, findPreset } from "./providers/presets.js";
import { connectFromPreset, forgetConnection } from "./connections-preset.js";
import { catalogEntries, providerCatalog } from "./provider-catalog.js";
import { localModelsApi } from "./local-models-api.js";
import { localRuntimes } from "./local-runtimes.js";
import { streamOwnerEvents, streamRunEvents } from "./streams.js";
// Web app (wave 6): "Look inside" a task, and "Try a tool" in the developer playground.
import { inspectRun } from "./inspect.js";
import { buildTrajectory, trajectoryLines } from "./trajectory.js";
import { replayRun } from "./replay.js";
import { meteringFolder, meteringSettings, saveMeteringSettings, writeMeteringFile } from "./metering.js";
import { TryToolSchema, toolForms, tryTool } from "./playground.js";
import { exportTemplate, importTemplate } from "./templates.js";
import { serveRunSocket, tokenFromProtocol } from "./ws.js";
import { liveHooks } from "./realtime-socket.js";
import { readBodyWithRaw } from "./triggers.js";
import { knowledgeApi } from "./knowledge-tools.js";
import { knowledgeExtrasApi } from "./knowledge-more.js";
import { WhatsAppAdapter } from "./channels/whatsapp.js";
import { WebhookChatAdapter } from "./channels/webhook-chat.js";
// Batch 20 (wave 8): the unguessable word on the end of every inbound webhook address.
import { rotateWebhookSecret, saveWebhookAddressSettings, webhookAddress, webhookAddressRefusal,
  webhookAddressSettings, webhookSecret } from "./channels/webhook-address.js";
import { channelEntries } from "./channels/catalog.js";
import { MetaMessagingAdapter } from "./channels/meta-graph.js";
import { standardSuite } from "./evaluation.js";
import { allSuites, saveSuite, removeSuite, suiteFromRun } from "./evaluation-suites.js";
// Wave 7 (a coder's toolbox): the two Developer switches.
import { languageServerSettings, saveLanguageServerSettings } from "./language-server.js";
import { debugSettings, saveDebugSettings } from "./debug-adapter.js";
// Wave 7 (benchmarks and experiments).
import { scorerKinds } from "./evaluation-scorers.js";
import { benchmarkAdapters } from "./benchmark-adapters.js";
import { notIntegratedBenchmarks } from "./benchmarks.js";
import { compareStudies, comparisonTable, studyTable, type StudyRunResult } from "./study.js";
import { runToolChecksSafely } from "./tool-evaluations.js";

import { McpSharingSchema, shareableTools, type McpServer } from "./mcp-server.js";
// Wave 7: Branch as a first-class MCP citizen — streaming, preflight, records of what a client was
// shown, connection lifecycle, the "try a server" bench, and small pages an outside server sends.
import { hiddenToolsText } from "./mcp-policy.js";
import { listSnapshots } from "./mcp-snapshots.js";
import { readLifecycleSettings, saveLifecycleSettings } from "./mcp-lifecycle.js";
import { tryServer } from "./mcp-workbench.js";
import { signIn as mcpSignIn } from "./integrations/mcp-oauth.js";
import { AppResourceSchema, appHeaders, appPage, type AppResource } from "./mcp-apps.js";
// Wave 8: artifacts out of a reply, shown in the same locked-down frame an MCP app gets.
import { ArtifactPageSchema, ArtifactSaveSchema, artifactPageRoute, holdArtifactPage } from "./artifact-pages.js";
import { readServingSettings, saveServingSettings } from "./mcp-server.js";
import { meaningSearchExplanation, meaningSearchOn, meaningSearchSetting } from "./tool-loading.js";
import { handleA2a, remoteAgentsApi } from "./a2a-routes.js";
import type { createBranch } from "./index.js";
import { PreferencesSchema, preferences } from "./preferences.js";
import { lookApi } from "./terminal-theme.js";
// Wave mac3: the owner's control dashboard, a page of its own at /dashboard.
import {
  DashboardApiError, dashboardAccess, dashboardApi, dashboardSettings, handlesDashboardPath, isDashboardFile,
} from "./dashboard-api.js";
import { PolicyRememberSchema, policyPresets, readPolicy, savePolicy } from "./policy.js";
import { maximumArchiveBytes } from "./session-library.js";
import { maximumMemoryArchiveBytes } from "./memory.js";
import { conversationMarkdown, maximumImportBytes } from "./memory-export.js";
import { assistantIdentity, saveAssistantIdentity } from "./identity.js";
import { contextFileStatus, saveContextFileSettings, contextFileSettings } from "./context-files.js";
import { voiceSettings, saveVoiceSettings } from "./voice.js";
import { voiceApi } from "./voice-api.js";
import { parseModelCommand } from "./model-switch.js";
import { pricingSettings, savePricingSettings, pricingTableInUse, estimateCost, formatCost } from "./pricing.js";
import { builtInImagePrices, imagePricedAt, mediaSettings, saveMediaSettings } from "./media-settings.js";
import { buildTraceDocument, traceSettings, saveTraceSettings } from "./trace.js";
import { writeDiagnosticsBundle } from "./diagnostics.js";
import { toolCatalogReport } from "./tool-report.js";
// Wave 5 (deployment): installing, background running and reaching Branch from a phone.
import { RemoteAccess } from "./remote/remote-access.js";
import { cliAgentRows, registerCliAgent } from "./providers/cli-agent.js";
import { GatewayAuth } from "./remote/gateway-auth.js";
import { deploymentApi, type DeploymentContext } from "./deployment-api.js";
import { clearRunning, writeRunning } from "./install/running.js";
import { readFirstStart, recordFirstStart } from "./install/update-backup.js";
import { readDesktopSettings, saveDesktopSettings } from "./integrations/desktop-config.js";
import { readCredentialSettings, saveCredentialSettings } from "./credential-cli.js";
import { keychainApi, keychainSettingsPath, permissionsContext } from "./keychain-api.js";
import { optionalFields } from "./feature-switches.js";
import { auditCsvResponse, handlesMiscPath, miscApi, MiscApiError } from "./misc-api.js";
// Batch 19 (wave 7): spans, sending traces somewhere, the counters page and the rule sentences.
import { handlesTracingPath, logsResponse, metricsResponse, tracingApi, TracingApiError } from "./tracing-api.js";
// Batch 26 (wave 8): where scripts run, what may reach the internet, how much one person may ask
// for, the owner's other computers, marks, and how long conversations are kept.
import { handlesSandboxRemotePath, sandboxRemoteApi, SandboxRemoteApiError } from "./sandbox-remote-api.js";
// Wave mac2 (move-in): bringing chats and memory over from another assistant.
import { contextFileSinkFor, defaultMoveInOptions, handlesMoveInPath, moveInApi, MoveInApiError } from "./migrate-api.js";
// Wave mac2 (guards): which workspace folders are trusted, and the loop guard switch.
import { guardsApi, handlesGuardsPath } from "./run-guards.js";
// Wave mac3 (tool-safety): the second look before an approval.
import { reviewerView, saveReviewerSettings } from "./approval-reviewer.js";
import { helpApi } from "./help.js";
import { AuthLimiter, noteAuthFailure, requestSource } from "./auth-limits.js";
import { handlesOrchestrationPath, orchestrationApi, OrchestrationApiError } from "./orchestration-api.js";
// Batch 21 (wave 8): the app's own OpenAPI description, Lockdown, kept answers, whole sets of
// questions at once, and what each project has cost.
import { handlesOtherPath, otherApi, OtherApiError } from "./other-api.js";
import { audit, csvCell } from "./audit.js";
import { askFirstSettings } from "./ask-first.js";
import { decisionsFromRules } from "./tool-categories.js";
// Wave 6 (collaboration and workflows): sharing pages and links, labels and notes, workflows,
// the waiting line for tasks, days off and quiet hours, and the household's profiles.
import { collabApi, collabState, notCollab, runForCurrentPerson } from "./collab-server.js";
import { shareHtml, RedactionSchema } from "./conversation-share.js";

type Branch = Awaited<ReturnType<typeof createBranch>>;
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const actionSchema = z
  .object({
    tool: z.string().min(1).max(100),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();
/**
 * The owner's answer to a plan waiting for them: yes, yes with the wording of a step changed, or
 * no with the reason. A body with nothing but steps in it is a yes, which is what it always was.
 */
const PlanAnswerSchema = z.object({
  decision: z.enum(["approve", "reject"]).optional(),
  steps: z.array(PlanStepSchema).min(1).max(8).optional(),
  reason: z.string().trim().max(500).optional(),
}).strict();
/** Which of the two modes this conversation is in, and how far it may go before checking back. */
const PlanActChoiceSchema = optionalFields(PlanActSettingsSchema).extend({
  sessionId: z.string().max(64).optional(),
  /** "conversation" sets this one apart; "project" changes what every conversation starts from. */
  scope: z.enum(["conversation", "project"]).default("conversation"),
  /** Puts this conversation back on whatever the project says. */
  followProject: z.boolean().optional(),
}).strict();
/** A monthly limit in tokens, in dollars, or both. Older settings that only set tokens still parse. */
const budgetSchema = z
  .object({
    maxMonthlyTokens: z.number().int().positive().optional(),
    maxMonthlyDollars: z.number().positive().max(1_000_000).optional(),
    pauseAtBudget: z.boolean(),
  })
  .strict()
  .refine((b) => b.maxMonthlyTokens !== undefined || b.maxMonthlyDollars !== undefined, {
    message: "Set a monthly limit in tokens, in dollars, or both",
  });
function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
async function readBody(request: IncomingMessage, maximumBytes = 65536): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "Use application/json");
  const tooLarge = () => new HttpError(413, `Request exceeds ${maximumBytes / 1024} KiB`);
  if (Number(request.headers["content-length"] ?? 0) > maximumBytes) throw tooLarge();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maximumBytes) throw tooLarge();
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
async function sessionToken(dataDir: string): Promise<string> {
  const path = join(dataDir, "session-token");
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("Session token must not be a link");
    const token = (await readFile(path, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new Error("Invalid saved session token");
    return token;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const token = randomBytes(32).toString("hex");
  await writeFile(path, token, { mode: 0o600, flag: "wx" });
  return token;
}
/**
 * Which addresses a request may claim it was sent to. Normally only this computer's own loopback
 * address; while "reach Branch from my phone" is on, also the private Tailscale address and name.
 * Everything else is refused, which is what stops a web page elsewhere talking to Branch.
 */
export function hostAllowed(
  host: string | undefined, origin: string | undefined, url: string, extra: readonly string[] = [],
): boolean {
  const hosts = [new URL(url).host, ...extra];
  if (!host || !hosts.includes(host)) return false;
  return !origin || hosts.some((allowed) => origin === `http://${allowed}`);
}
function authorize(
  request: IncomingMessage, url: string, token: string, extra: readonly string[] = [],
  /** Batch 19 (wave 7): counts wrong keys per place, so the key cannot be guessed at speed. */
  limits?: { limiter: AuthLimiter; onFailure: (source: string) => void },
  /**
   * Batch 20 (wave 8): a short-lived key made with `branch token create`. It is only looked at
   * after the master key has already failed, so a mistake here can hold up a script and never the
   * owner's own app. It answers the plain reason it refused, or null to let the request through.
   */
  scoped?: (supplied: string) => string | null,
): void {
  if (!hostAllowed(request.headers.host, undefined, url, extra))
    throw new HttpError(403, "Host rejected");
  if (!hostAllowed(request.headers.host, request.headers.origin, url, extra))
    throw new HttpError(403, "Origin rejected");
  if (request.headers["sec-fetch-site"] === "cross-site")
    throw new HttpError(403, "Cross-site request rejected");
  const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
  const correct =
    supplied.length === token.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
  const from = requestSource(request.socket?.remoteAddress);
  // The right key is checked first and clears the count at once, so the owner's own app can never
  // shut itself out. Only a wrong key is counted, and a place that keeps guessing is made to wait.
  if (correct) { limits?.limiter.succeed(from); return; }
  const waiting = limits?.limiter.refusal(from, "key");
  if (waiting) throw new HttpError(429, waiting);
  const refusal = supplied && scoped ? scoped(supplied) : "Local session token required";
  if (refusal === null) { limits?.limiter.succeed(from); return; }
  limits?.onFailure(from);
  throw new HttpError(401, refusal);
}
/** A study result without its thousands of rows, for the list on the Evaluation screen. */
const studySummary = (result: StudyRunResult) => ({
  id: result.id, studyId: result.studyId, name: result.name, startedAt: result.startedAt,
  rows: result.rows, tasks: result.tasks.length, resumed: result.resumed, stoppedEarly: result.stoppedEarly,
});

async function staticFile(
  path: string,
  response: ServerResponse,
): Promise<boolean> {
  const assets: Record<string, [string, string]> = {
    "/acorn.js": ["acorn.js", "text/javascript; charset=utf-8"],
    "/look-sync.js": ["look-sync.js", "text/javascript; charset=utf-8"],
    "/assets/keepoak-mark.png": ["assets/keepoak-mark.png", "image/png"],
    "/assets/keepoak-mark-reversed.png": ["assets/keepoak-mark-reversed.png", "image/png"],
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/voice.js": ["voice.js", "text/javascript; charset=utf-8"],
    // mac2/desktop-ui: this computer's own permission switches, and the Keychain list on a Mac.
    "/os-permissions.js": ["os-permissions.js", "text/javascript; charset=utf-8"],
    "/voice-talk.js": ["voice-talk.js", "text/javascript; charset=utf-8"],
    // Wave 8: the composer's live-conversation button and everything behind it.
    "/voice-live.js": ["voice-live.js", "text/javascript; charset=utf-8"],
    "/model-profiles.js": ["model-profiles.js", "text/javascript; charset=utf-8"],
    // Help in the app: the owner's handbook, opened in the pane on the right.
    "/help.js": ["help.js", "text/javascript; charset=utf-8"],
    "/documents.js": ["documents.js", "text/javascript; charset=utf-8"],
    "/knowledge.js": ["knowledge.js", "text/javascript; charset=utf-8"],
    "/media.js": ["media.js", "text/javascript; charset=utf-8"],
    "/memory-tidy.js": ["memory-tidy.js", "text/javascript; charset=utf-8"],
    "/docs-memory-2.js": ["docs-memory-2.js", "text/javascript; charset=utf-8"],
    // Batch 27 (wave 8): writing documents, summaries, the map of names and knowledge housekeeping.
    "/docs-3.js": ["docs-3.js", "text/javascript; charset=utf-8"],
    // Wave 9: what it noticed by itself, and the refresh that shows its cost first.
    "/self-improving.js": ["self-improving.js", "text/javascript; charset=utf-8"],
    "/skills-extra.js": ["skills-extra.js", "text/javascript; charset=utf-8"],
    "/local-models.js": ["local-models.js", "text/javascript; charset=utf-8"],
    // Wave 6: sharing, labels and notes, workflows, the waiting line, days off and people.
    "/collab.js": ["collab.js", "text/javascript; charset=utf-8"],
    "/automations.js": ["automations.js", "text/javascript; charset=utf-8"],
    // Wave mac2 (quiet-jobs): the check-in card, automation health and check-script approval.
    "/heartbeat.js": ["heartbeat.js", "text/javascript; charset=utf-8"],
    "/mcp.js": ["mcp.js", "text/javascript; charset=utf-8"],
    "/mcp-workbench.js": ["mcp-workbench.js", "text/javascript; charset=utf-8"],
    "/browser.js": ["browser.js", "text/javascript; charset=utf-8"],
    "/approvals.js": ["approvals.js", "text/javascript; charset=utf-8"],
    "/tracing.js": ["tracing.js", "text/javascript; charset=utf-8"],
    "/desktop.js": ["desktop.js", "text/javascript; charset=utf-8"],
    "/diagnostics.js": ["diagnostics.js", "text/javascript; charset=utf-8"],
    "/update-screen.js": ["update-screen.js", "text/javascript; charset=utf-8"],
    "/deployment.js": ["deployment.js", "text/javascript; charset=utf-8"],
    "/pair": ["pair.html", "text/html; charset=utf-8"],
    "/pair.js": ["pair.js", "text/javascript; charset=utf-8"],
    "/pair.css": ["pair.css", "text/css; charset=utf-8"],
    // Wave mac3: the owner's dashboard, and the card in Customize → Channels that switches it on.
    "/dashboard": ["dashboard/index.html", "text/html; charset=utf-8"],
    "/dashboard/dashboard.css": ["dashboard/dashboard.css", "text/css; charset=utf-8"],
    "/dashboard/dashboard.js": ["dashboard/dashboard.js", "text/javascript; charset=utf-8"],
    "/dashboard/sections.js": ["dashboard/sections.js", "text/javascript; charset=utf-8"],
    "/dashboard/feed.js": ["dashboard/feed.js", "text/javascript; charset=utf-8"],
    "/dashboard/look.js": ["dashboard/look.js", "text/javascript; charset=utf-8"],
    "/dashboard-card.js": ["dashboard/card.js", "text/javascript; charset=utf-8"],
    "/usage.js": ["usage.js", "text/javascript; charset=utf-8"],
    "/evaluation.js": ["evaluation.js", "text/javascript; charset=utf-8"],
    // Wave 7: written-down experiments, under the evaluation card.
    "/studies.js": ["studies.js", "text/javascript; charset=utf-8"],
    // Batch 19 (wave 6): the record, approval kinds, the practice workspace.
    "/misc.js": ["misc.js", "text/javascript; charset=utf-8"],
    // Batch 20 (wave 7): flows drawn as boxes and arrows under Procedures, and the suggested
    // better versions of a skill under Skills.
    "/flows.js": ["flows.js", "text/javascript; charset=utf-8"],
    // Wave 9: the advisor switch and the two debate bounds.
    "/second-opinion.js": ["second-opinion.js", "text/javascript; charset=utf-8"],
    // Wave mac2 (chat-live): the chat-app switches card under Customize, Chat apps.
    "/chat-live.js": ["chat-live.js", "text/javascript; charset=utf-8"],
    "/skill-revisions.js": ["skill-revisions.js", "text/javascript; charset=utf-8"],
    "/specialist-styles.js": ["specialist-styles.js", "text/javascript; charset=utf-8"],
    // Wave 7 (a coder's toolbox): the two Developer switches for language servers and debuggers.
    "/code-ide.js": ["code-ide.js", "text/javascript; charset=utf-8"],
    // Wave 8: the Lockdown switch and the shape branched conversations make.
    "/other.js": ["other.js", "text/javascript; charset=utf-8"],
    "/sandbox-remote.js": ["sandbox-remote.js", "text/javascript; charset=utf-8"],
    // Wave mac2: bringing your chats and memory over from another assistant.
    "/move-in.js": ["move-in.js", "text/javascript; charset=utf-8"],
    // Wave mac2 (guards): the card that asks whether a folder is trusted.
    "/folder-trust.js": ["folder-trust.js", "text/javascript; charset=utf-8"],
    // Wave mac3 (tool-safety): the card for the second look before an approval.
    "/approval-reviewer.js": ["approval-reviewer.js", "text/javascript; charset=utf-8"],
    "/providers.js": ["providers.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"],
    // App shell (wave 2): tokens, layout, appearance.
    "/tokens.css": ["tokens.css", "text/css; charset=utf-8"],
    "/shell.css": ["shell.css", "text/css; charset=utf-8"],
    "/shell.js": ["shell.js", "text/javascript; charset=utf-8"],
    // Wave 9 redesign: the five places, the Settings window, the 44 themes' colours and the oak.
    "/layout.js": ["layout.js", "text/javascript; charset=utf-8"],
    "/context-files.js": ["context-files.js", "text/javascript; charset=utf-8"],
    "/layout.css": ["layout.css", "text/css; charset=utf-8"],
    "/theme-catalogue.js": ["theme-catalogue.js", "text/javascript; charset=utf-8"],
    // Wave mac3: one theme's colours under Branch's token names, for the window and the dashboard.
    "/theme-bridge.js": ["theme-bridge.js", "text/javascript; charset=utf-8"],
    "/grove.js": ["grove.js", "text/javascript; charset=utf-8"],
    "/context-pane.js": ["context-pane.js", "text/javascript; charset=utf-8"],
    // Wave 7: what a conversation is allowed to do right now, and the observability screens.
    "/allowed.js": ["allowed.js", "text/javascript; charset=utf-8"],
    "/labels-ui.js": ["labels-ui.js", "text/javascript; charset=utf-8"],
    "/compare.js": ["compare.js", "text/javascript; charset=utf-8"],
    "/activity-feed.js": ["activity-feed.js", "text/javascript; charset=utf-8"],
    "/appearance.js": ["appearance.js", "text/javascript; charset=utf-8"],
    // Web app (wave 6): rendering, inspector, live intervention, meter, playground, PWA, languages.
    "/web-ui.js": ["web-ui.js", "text/javascript; charset=utf-8"],
    // Wave 8: artifacts out of a reply, charts drawn in the page, the flow editor, reports, the
    // to-do list, the log view and the page a local page of the owner's own can include.
    "/artifacts.js": ["artifacts.js", "text/javascript; charset=utf-8"],
    "/charts.js": ["charts.js", "text/javascript; charset=utf-8"],
    "/reports.js": ["reports.js", "text/javascript; charset=utf-8"],
    "/todos.js": ["todos.js", "text/javascript; charset=utf-8"],
    "/logs.js": ["logs.js", "text/javascript; charset=utf-8"],
    "/flow-editor.js": ["flow-editor.js", "text/javascript; charset=utf-8"],
    // The small box a page of the owner's own can include. Nothing on this page imports it.
    "/widget.js": ["widget.js", "text/javascript; charset=utf-8"],
    "/bridges.js": ["bridges.js", "text/javascript; charset=utf-8"],
    "/markdown.js": ["markdown.js", "text/javascript; charset=utf-8"],
    "/inspector.js": ["inspector.js", "text/javascript; charset=utf-8"],
    "/live-run.js": ["live-run.js", "text/javascript; charset=utf-8"],
    "/plan-act.js": ["plan-act.js", "text/javascript; charset=utf-8"],
    "/token-meter.js": ["token-meter.js", "text/javascript; charset=utf-8"],
    "/playground.js": ["playground.js", "text/javascript; charset=utf-8"],
    "/tool-catalog.js": ["tool-catalog.js", "text/javascript; charset=utf-8"],
    "/i18n.js": ["i18n.js", "text/javascript; charset=utf-8"],
    "/web-ui.css": ["web-ui.css", "text/css; charset=utf-8"],
    "/locales/en.json": ["locales/en.json", "application/json; charset=utf-8"],
    "/locales/fr.json": ["locales/fr.json", "application/json; charset=utf-8"],
    "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json; charset=utf-8"],
    "/service-worker.js": ["service-worker.js", "text/javascript; charset=utf-8"],
    "/assets/icon-192.png": ["assets/icon-192.png", "image/png"],
    "/assets/icon-512.png": ["assets/icon-512.png", "image/png"],
    "/assets/icon.svg": ["assets/icon.svg", "image/svg+xml"],
    "/fonts/archivo.woff2": ["fonts/archivo.woff2", "font/woff2"],
    "/fonts/geist.woff2": ["fonts/geist.woff2", "font/woff2"],
    "/fonts/geist-mono.woff2": ["fonts/geist-mono.woff2", "font/woff2"],
  };
  const asset = assets[path];
  if (!asset) return false;
  const body = await readFile(
    new URL("../public/" + asset[0], import.meta.url),
  );
  response.writeHead(200, {
    "content-type": asset[1],
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      // worker-src and manifest-src let the installable web app register its service worker.
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  response.end(body);
  return true;
}
const OnboardingSchema = z.object({ done: z.boolean(), completedAt: z.string().optional() }).strict();
function onboardingState(app: Branch): { done: boolean } {
  const saved = OnboardingSchema.safeParse(app.store.get("settings", app.runtime.owner, "onboarding")?.data ?? {});
  return { done: saved.success ? saved.data.done : false };
}
/** A real, tiny completion through the chosen preset so setup ends with evidence, not a saved form. */
async function testModel(app: Branch, body: unknown): Promise<unknown> {
  const { preset } = z.object({ preset: z.string().min(1).max(64).nullable().optional() }).strict().parse(body);
  const owner = app.runtime.owner;
  const chosen = preset ? app.runtime.models.presets.get(preset) : app.runtime.models.plan(owner, "").candidates[0];
  if (!chosen) throw new HttpError(400, "That model is not configured");
  const started = Date.now();
  try {
    const completion = await chosen.provider.complete({
      messages: [
        { role: "system", content: "You are Branch Agent. Reply with the single word OK." },
        { role: "user", content: "Connection test" },
      ],
      tools: [], maxTokens: 16, signal: AbortSignal.timeout(30000),
    });
    return { ok: true, presetId: chosen.id, presetName: chosen.name, model: chosen.model,
      reply: completion.content.slice(0, 80), ms: Date.now() - started };
  } catch (error) {
    throw new HttpError(502, `${chosen.name} did not answer: ${errorText(error)}`);
  }
}

function providersCatalog(): unknown {
  return { presets: allPresets() };
}

const providerTestInput = z.object({
  preset: z.string().min(1).max(64).optional(), endpoint: z.string().url().max(2048).optional(),
  model: z.string().min(1).max(256).optional(), apiKey: z.string().min(1).max(4096).optional(),
}).strict();

/** Sends one tiny request through the same provider classes the assistant uses, so URL rules and errors match real use. */
async function testProvider(body: unknown): Promise<unknown> {
  const input = providerTestInput.parse(body);
  const chosen = input.preset ? findPreset(input.preset) : undefined;
  if (input.preset && !chosen) throw new HttpError(400, "Unknown provider preset");
  const endpoint = input.endpoint ?? chosen?.baseUrl, model = input.model ?? chosen?.modelIds[0];
  if (!endpoint || !model || !input.apiKey) throw new HttpError(400, "Provide the address, a model name and the key to test");
  const started = Date.now();
  try {
    const options = { endpoint, model, apiKey: input.apiKey };
    const provider = chosen?.headerStyle === "google-key" ? new GeminiProvider(options)
      : chosen?.headerStyle === "x-api-key" ? new AnthropicProvider(options) : new OpenAIProvider(options);
    const completion = await provider.complete({
      messages: [{ role: "system", content: "You are Branch Agent. Reply with the single word OK." }, { role: "user", content: "Connection test" }],
      tools: [], maxTokens: 16, signal: AbortSignal.timeout(20000),
    });
    return { ok: true, model, reply: completion.content.slice(0, 80), ms: Date.now() - started };
  } catch (error) {
    return { ok: false, reason: providerFailureReason(error), ms: Date.now() - started };
  }
}

function providerFailureReason(error: unknown): string {
  const text = errorText(error);
  if (/(401|403)|invalid.*key|unauthori|forbidden/i.test(text)) return "The key was not accepted. Check it and try again.";
  if (/404|not found|no such model|does not exist/i.test(text)) return "That model name was not found at this address.";
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|timed? ?out|abort/i.test(text)) return "Could not reach that address. Check the URL and your connection.";
  if (/private|blocked|policy|requires HTTPS/i.test(text)) return "That address is not allowed: " + text.slice(0, 120);
  return "The provider answered with an error: " + text.slice(0, 160);
}

async function localProviders(): Promise<unknown> {
  const found: Array<{ runtime: string; baseUrl: string; models: string[] }> = [];

  // Probe Ollama at 127.0.0.1:11434
  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    });
    if (response.ok) {
      const data = (await response.json().catch(() => ({ models: [] }))) as { models?: Array<{ name?: string }> };
      const models = (data.models || [])
        .filter((m) => m.name && typeof m.name === "string")
        .map((m) => m.name!.split(":")[0]!);
      if (models.length > 0) {
        found.push({
          runtime: "ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          models,
        });
      }
    }
  } catch {
    // Ollama not running
  }

  // Probe LM Studio at 127.0.0.1:1234
  try {
    const response = await fetch("http://127.0.0.1:1234/v1/models", {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    });
    if (response.ok) {
      const data = (await response.json().catch(() => ({ data: [] }))) as { data?: Array<{ id?: string }> };
      const models = (data.data || [])
        .filter((m) => m.id && typeof m.id === "string")
        .map((m) => m.id!);
      if (models.length > 0) {
        found.push({
          runtime: "lm-studio",
          baseUrl: "http://127.0.0.1:1234/v1",
          models,
        });
      }
    }
  } catch {
    // LM Studio not running
  }

  return { local: found };
}

/** The preset that actually served a run: the last recorded selection or fallback, if any. */
function modelUsed(app: Branch, runId: string) {
  const events = app.store.events(runId).filter((event) => ["model.selected", "model.fallback"].includes(event.kind));
  const last = events.at(-1);
  if (!last) return null;
  const data = last.data;
  return last.kind === "model.fallback"
    ? { presetId: data.to, provider: data.provider, model: data.model, fellBackFrom: data.from }
    : { presetId: data.presetId, presetName: data.presetName, provider: data.provider, model: data.model, reasoning: data.reasoning };
}
/** Tools that exist right now, grouped by permission, with what makes each group ready. */
function toolInventory(app: Branch) {
  const readiness: Record<string, string> = {
    "web.read": app.web.settings().allowPrivateAddresses ? "ready (private addresses allowed)" : "ready",
    "shell.execute": "ready (configured host commands)",
    "git.remote": "ready (sending to a server switched on)",
    "github.manage": "ready (GitHub token saved)",
    "browser.read": "ready (configured origins)", "browser.act": "ready (configured origins)",
    "browser.interact": "ready (configured origins)",
  };
  const channels = app.channels.summary().channels.map((c) => c.id);
  return {
    tools: app.registry.inventory().map((tool) => ({ ...tool, readiness: readiness[tool.permission] ?? "ready" })),
    permissions: app.registry.permissions(),
    channels,
    models: [...app.runtime.models.presets.keys()],
  };
}
/** Tasks waiting for the person's answer: the latest run of a conversation that stopped with a question. */
function attention(app: Branch) {
  const seen = new Set<string>(), waiting: { runId: string; sessionId: string; question: string; createdAt: string }[] = [];
  for (const run of app.store.runs(app.runtime.owner)) {
    if (seen.has(run.sessionId)) continue;
    seen.add(run.sessionId);
    if (run.status === "needs_input") waiting.push({ runId: run.id, sessionId: run.sessionId, question: run.output, createdAt: run.createdAt });
  }
  return waiting;
}
function state(app: Branch): unknown {
  const owner = app.runtime.owner;
  // Wave 6: conversations and saved facts are read under whoever's profile is switched on.
  const scope = app.store.profiles.scope();
  return {
    collab: collabState(app),
    provider: app.runtime.provider.name,
    activeModel: app.runtime.models.plan(owner, "").choice,
    onboarding: onboardingState(app),
    attention: attention(app),
    project: { active: app.store.projects.active(owner), all: app.store.projects.list(owner) },
    version: app.version,
    chatgpt: { configured: Boolean(app.chatgpt) },
    preferences: preferences(app.store, owner),
    identity: assistantIdentity(app.store, owner),
    workspace: app.runtime.workspace,
    runs: app.store
      .runs(scope)
      .map((run) => ({ ...run, usage: app.store.usage(run.id), cost: runCost(app, run.id), model: modelUsed(app, run.id), changes: fileChanges(app, run.id) })),
    learning: app.store.review.settings(owner),
    // Batch 19 (wave 6)
    allowed: { counts: app.store.audit.counts(owner), recent: app.store.audit.list(owner, { limit: 20 }) },
    approvalCategories: decisionsFromRules(app.registry, readPolicy(app.store, owner).rules),
    askFirst: askFirstSettings(app.store, owner),
    practice: app.practice.state(owner),
    reranking: app.retrieval.view(owner),
    providerPlugins: app.providerPlugins.list(),
    issueTrackers: app.issues?.available() ?? [],
    orchestration: orchestrationSettings(app.store, owner),
    secondOpinion: secondOpinionSettings(app.store, owner),
    background: app.runtime.backgroundResults,
    hooks: app.hooks.list(),
    setAside: app.store.governance.exclusions(),
    consolidation: app.store.review.cursor(owner),
    network: app.web.policy.settings(),
    memoryProposals: app.store.review.proposals(owner),
    memoryCheckpoints: app.store.review.checkpoints(owner),
    snapshots: app.store.workspaceHistory.snapshots(),
    models: app.runtime.models.summary(owner),
    memory: app.store.list("memory", scope),
    memoryCapacity: app.store.memoryCapacity(scope),
    skills: app.store.skills.list(owner),
    skillPolicy: app.store.skills.policy(owner),
    specialists: app.store.list("specialists", owner),
    procedures: app.store.list("procedures", owner),
    schedules: app.store.list("schedules", owner),
    triggers: app.triggers.list(owner),
    webhooks: app.webhooks.list(owner),
    // The app's own tool list is for a person to read, so it keeps the full description.
    tools: app.registry.descriptions(new Set(app.registry.permissions()), { diet: false }),
    lock: app.sessionLock.state(),
    privacy: app.privacy.settings(),
    secretReminders: app.store.secrets.reminders(owner, app.store.projects.list(owner).map((p) => p.id)),
  };
}
async function api(
  app: Branch,
  request: IncomingMessage,
  path: string,
  dataDir: string,
): Promise<unknown> {
  // Batch 19 (wave 6): the record of what it was allowed to do, approval kinds, ask-first,
  // the practice workspace, how passages are ordered, plugin model connections, issue context.
  if (handlesMiscPath(path))
    return miscApi(app, request, path, readBody).catch((error: unknown) => {
      throw error instanceof MiscApiError ? new HttpError(error.status, error.message) : error;
    });
  // Batch 19 (wave 7): spans, sending traces out, and the approval rules read as sentences.
  if (handlesTracingPath(path))
    return tracingApi(app, request, path, readBody).catch((error: unknown) => {
      throw error instanceof TracingApiError ? new HttpError(error.status, error.message) : error;
    });
  // Batch 20 (wave 7): flows as boxes and arrows, jobs handed over to finish later, programs left
  // running, and the switches for the project's check, those programs, and small scripts.
  if (handlesOrchestrationPath(path))
    return orchestrationApi(app, request, path, readBody).catch((error: unknown) => {
      throw error instanceof OrchestrationApiError ? new HttpError(error.status, error.message) : error;
    });
  // Batch 26 (wave 8): sandboxes, the firewall card, per-person ceilings, other computers, marks,
  // and how long conversations are kept.
  if (handlesSandboxRemotePath(path))
    return sandboxRemoteApi(app, request, path, readBody).catch((error: unknown) => {
      throw error instanceof SandboxRemoteApiError ? new HttpError(error.status, error.message) : error;
    });
  // Wave mac2 (move-in): the preview of what another assistant left behind, and bringing it over.
  if (handlesMoveInPath(path))
    return moveInApi(app, request, path, readBody, { ...defaultMoveInOptions(), contextFiles: contextFileSinkFor(app) }).catch((error: unknown) => {
      throw error instanceof MoveInApiError ? new HttpError(error.status, error.message) : error;
    });
  // Wave mac2 (guards): which workspace folders are trusted, what each carries, and both switches.
  if (handlesGuardsPath(path)) return guardsApi(app, request, path, readBody);
  // Wave mac3 (tool-safety): the second look before an approval — its switch, connection and rules.
  if (path === "/api/approval-reviewer" && request.method === "GET") return reviewerView(app.store, app.runtime.owner);
  if (path === "/api/approval-reviewer" && request.method === "POST") {
    saveReviewerSettings(app.store, app.runtime.owner, await readBody(request));
    return reviewerView(app.store, app.runtime.owner);
  }
  // Batch 21 (wave 8): the description of this API, Lockdown, kept answers, whole sets, project cost.
  if (handlesOtherPath(path))
    return otherApi(app, request, path, readBody).catch((error: unknown) => {
      throw error instanceof OtherApiError ? new HttpError(error.status, error.message) : error;
    });
  // The owner's handbook, so Help opens beside the screen a person is on. Reading only.
  if (request.method === "GET" && (path === "/api/help" || path.startsWith("/api/help/"))) {
    const answer = helpApi(path);
    if (answer === undefined) throw new HttpError(404, "There is no handbook chapter by that name");
    return answer;
  }
  if (request.method === "GET" && path === "/api/state") return state(app);
  // Wave 6: sharing, labels and notes, workflows, the waiting line, days off, and profiles.
  const collab = await collabApi(app, request, path, (maximumBytes) => readBody(request, maximumBytes));
  if (collab !== notCollab) return collab;
  if (request.method === "GET" && path === "/api/tools") return toolInventory(app);
  // The developer playground: the form for every tool, and running one by hand through the gate.
  if (request.method === "GET" && path === "/api/tools/forms") return { tools: toolForms(app.registry) };
  if (request.method === "POST" && path === "/api/tools/try")
    // Scrubbed on the way out, exactly as the runtime scrubs a tool result before it records one,
    // and given the same two-minute ceiling a manual action gets so nothing holds a slot for ever.
    return app.runtime.hideSecrets(
      await tryTool(app.registry, app.store, app.runtime.owner,
        app.runtime.context({ signal: AbortSignal.timeout(120000) }),
        TryToolSchema.parse(await readBody(request)),
        (tool, permission) => app.runtime.roleRefusal(tool, permission)));
  // Wave 8: an artifact out of a reply. Minting an address puts the page behind an unguessable
  // name the frame can fetch; saving keeps it beside the task, where the Documents list finds it.
  if (request.method === "POST" && path === "/api/artifacts/page")
    return { url: `/artifact/${holdArtifactPage(ArtifactPageSchema.parse(await readBody(request, 512_000)))}` };
  if (request.method === "POST" && path === "/api/artifacts/save") {
    const wanted = ArtifactSaveSchema.parse(await readBody(request, 512_000));
    const kept = await app.artifacts.write(wanted.runId, wanted.name, wanted.mediaType, Buffer.from(wanted.code, "utf8"));
    return { ...kept, name: wanted.name, runId: wanted.runId };
  }
  if (request.method === "GET" && path === "/api/mcp/connection") return mcpConnectionSnippets(app, request, dataDir);
  if (path.startsWith("/api/mcp/")) return mcpApi(app, request, path);
  // Assistants elsewhere: the ones added, looking for more, and the link that pairs two installs.
  if (path.startsWith("/api/agents/"))
    return remoteAgentsApi(app.remoteAgents, request, path, () => readBody(request), {
      base: `http://${request.headers.host ?? "127.0.0.1:3210"}`,
      token: /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ""))?.[1] ?? "YOUR_SESSION_KEY",
    });
  // A phone-sized list of conversations. It goes through the same door and needs the same key as
  // everything else, so a paired phone can pick up what was started at the computer.
  if (request.method === "GET" && path === "/api/sessions")
    return app.store.recentSessions(app.store.profiles.scope(), Number(new URL(request.url ?? "/", "http://x").searchParams.get("limit") ?? 20) || 20);
  if (path.startsWith("/api/sessions/")) return sessionApi(app, request, path);
  if (path.startsWith("/api/memory/")) return memoryApi(app, request, path);
  if (path.startsWith("/api/history/")) return historyApi(app, request, path);
  // Wave 7: the two coder switches in Settings → Developer, kept in one small block.
  if (path.startsWith("/api/developer/")) return developerApi(app, request, path);
  if (path.startsWith("/api/skills/")) return skillsApi(app, request, path);
  if (path.startsWith("/api/chatgpt/")) return chatgptApi(app, request, path);
  if (path.startsWith("/api/projects")) return projectsApi(app, request, path);
  if (path.startsWith("/api/secrets")) return secretsApi(app, request, path);
  if (path.startsWith("/api/lock") || path.startsWith("/api/privacy")) return guardApi(app, request, path);
  if (path.startsWith("/api/connections/")) return connectionsApi(app, request, path);
  if (path.startsWith("/api/channels")) return channelsApi(app, request, path);
  // Wave mac2 (quiet-jobs): the check-in, and the owner's yes to a job's check script.
  if (path.startsWith("/api/heartbeat") || /^\/api\/schedules\/[a-f0-9-]{36}\/gate$/.test(path)) {
    app.store.profiles.requireOwner("Your schedules");
    const answer = await quietJobsApi(app.scheduler, request.method ?? "GET", path, () => readBody(request));
    if (answer !== undefined) return answer;
    throw new HttpError(404, "Endpoint not found");
  }
  if (path === "/api/schedules" || path.startsWith("/api/schedules/")) return schedulesApi(app, request, path);
  if (path.startsWith("/api/documents")) return documentsApi(app, request, path);
  // Knowledge bases: named sets of folders and files, searched by words and by meaning at once.
  if (path.startsWith("/api/knowledge")) {
    const answer = await knowledgeApi(app.knowledgeBases, app.runtime.models, app.runtime.owner,
      request.method ?? "GET", path, () => readBody(request));
    if (answer !== undefined) return app.runtime.hideSecrets(answer);
    // Batch 20 (wave 8): summaries, the map of names, pictures in words, housekeeping and limits.
    const more = await knowledgeExtrasApi(app.knowledgeParts, app.store, app.runtime.owner,
      request.method ?? "GET", path, () => readBody(request));
    if (more !== undefined) return app.runtime.hideSecrets(more);
    throw new HttpError(404, "Not found");
  }
  if (path.startsWith("/api/research") || path.startsWith("/api/monitors") || path.startsWith("/api/brief"))
    return researchApi(app, request, path);
  if (path.startsWith("/api/triggers")) return triggersApi(app, request, path);
  if (path.startsWith("/api/webhooks")) return webhooksApi(app, request, path);
  if (path.startsWith("/api/browser/")) return browserApi(app, request, path);
  if (request.method === "POST" && path === "/api/identity")
    return saveAssistantIdentity(app.store, app.runtime.owner, await readBody(request));
  // The owner's own instruction files: what each one is set to, and what that produced this time.
  if (request.method === "GET" && path === "/api/context-files")
    return {
      settings: contextFileSettings(app.store, app.runtime.owner),
      files: contextFileStatus(app.store, app.runtime.owner, app.runtime.workspace),
    };
  if (request.method === "POST" && path === "/api/context-files")
    return saveContextFileSettings(app.store, app.runtime.owner, await readBody(request));
  if (request.method === "POST" && path === "/api/models")
    return app.runtime.models.configure(app.runtime.owner, await readBody(request));
  if (request.method === "POST" && path === "/api/models/test") return testModel(app, await readBody(request));
  if (request.method === "GET" && path === "/api/providers/catalog") return providersCatalog();
  if (request.method === "POST" && path === "/api/providers/test") return testProvider(await readBody(request));
  if (request.method === "GET" && path === "/api/providers/local") return localProviders();
  // Batch 20 (wave 8): coding assistants already installed here, used as a model through their own
  // command line and their own sign-in. Listing them installs nothing and signs in to nothing.
  if (request.method === "GET" && path === "/api/providers/cli-agents") return { agents: cliAgentRows() };
  if (request.method === "POST" && path === "/api/providers/cli-agents")
    return registerCliAgent(app.runtime.models, await readBody(request, 8 * 1024));
  // Models on this computer: what is installed, downloads, hardware advice and task routing.
  if (path === "/api/local-models" || path.startsWith("/api/local-models/"))
    return localModelsApi(
      { runtimes: localRuntimes(), store: app.store, models: app.runtime.models, owner: app.runtime.owner },
      request.method ?? "GET", path, () => readBody(request),
    );
  if (request.method === "POST" && path === "/api/onboarding") {
    const value = OnboardingSchema.parse(await readBody(request));
    app.store.save("settings", app.runtime.owner, "onboarding", { ...value, completedAt: new Date().toISOString() });
    return onboardingState(app);
  }
  // Wave mac3 (terminal): the theme `branch theme` and Settings › Appearance share (src/terminal-theme.ts).
  if (path === "/api/look" && request.method !== "GET" && request.method !== "POST") throw new HttpError(405, "Use GET or POST");
  if (path === "/api/look") return lookApi(app.store, app.runtime.owner, request.method ?? "GET", () => readBody(request));
  if (request.method === "POST" && path === "/api/preferences") {
    const value = PreferencesSchema.parse(await readBody(request));
    app.store.save("settings", app.runtime.owner, "preferences", value);
    return value;
  }
  if (request.method === "GET" && path === "/api/voice/settings")
    return voiceSettings(app.store, app.runtime.owner);
  // Wave 7: voice routes and plans, routing profiles, switching model mid-conversation, and a live
  // check of what each connection can do. The bodies of all of these live in src/voice-api.ts.
  if (path === "/api/voice/settings" || path === "/api/voice/plan" || path === "/api/voice/voices"
      || path.startsWith("/api/models/profiles") || path === "/api/models/switch" || path === "/api/models/probe"
      || path === "/api/models/gemini-signin")
    return voiceApi(voiceDeps(app), request.method ?? "GET", path, () => readBody(request));
  // Pictures and sounds (wave 5): what the media tools should use, and everything they have made.
  if (request.method === "GET" && path === "/api/media/settings")
    return { settings: mediaSettings(app.store, app.runtime.owner), prices: builtInImagePrices, pricedAt: imagePricedAt };
  if (request.method === "POST" && path === "/api/media/settings")
    return { settings: saveMediaSettings(app.store, app.runtime.owner, await readBody(request)) };
  if (request.method === "GET" && path === "/api/artifacts") {
    const type = new URL(request.url ?? "/", "http://local").searchParams.get("type") ?? "";
    const kept = await app.artifacts.list();
    return { artifacts: type ? kept.filter((entry) => entry.mediaType.startsWith(`${type}/`)) : kept };
  }
  // Batch 26 (wave 8): what Windows itself allows, with the page that turns each one on.
  if (request.method === "GET" && path === "/api/os-permissions")
    return { permissions: await app.osPermissions.all(), ...permissionsContext() };
  // Batch 26 (wave 8): reading passwords out of the password manager the owner already has.
  if (request.method === "GET" && path === "/api/credentials/settings")
    return readCredentialSettings(app.store, app.runtime.owner);
  if (request.method === "POST" && path === "/api/credentials/settings")
    return saveCredentialSettings(app.store, app.runtime.owner, await readBody(request));
  // mac2/desktop-ui: which Keychain entries Branch may read on a Mac (names only, off by default).
  if (path === keychainSettingsPath)
    return keychainApi(app.store, app.runtime.owner, request.method ?? "GET", () => readBody(request));
  // Using this computer's screen and keyboard: off until the owner turns it on here.
  if (request.method === "GET" && path === "/api/desktop/settings")
    return readDesktopSettings(app.store, app.runtime.owner);
  if (request.method === "POST" && path === "/api/desktop/settings")
    return saveDesktopSettings(app.store, app.runtime.owner, await readBody(request));
  const match = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(cancel|resume|receipts|steer|plan))?$/.exec(path);
  if (match) {
    const run = app.store.run(match[1]!);
    if (!run || run.owner !== app.store.profiles.scope())
      throw new HttpError(404, "Run not found");
    if (request.method === "POST" && match[2] === "cancel")
      return { cancelled: app.runtime.cancel(run.id) };
    if (request.method === "POST" && match[2] === "resume")
      return app.runtime.resume(run.id);
    // Steering a task that is working, and editing or approving the plan it is waiting on.
    if (request.method === "POST" && match[2] === "steer") {
      const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).strict().parse(await readBody(request));
      return app.runtime.steer(run.id, text);
    }
    if (request.method === "GET" && match[2] === "plan")
      return { plan: app.runtime.orchestration.plan(run.sessionId) ?? null };
    if (request.method === "POST" && match[2] === "plan") {
      const body = PlanAnswerSchema.parse(await readBody(request));
      // Saying yes answers here and now; saying no asks for another plan, which takes a model turn.
      if (body.decision !== "reject") return app.runtime.orchestration.decidePlan(run.id, body);
      const { plan, asked } = await app.runtime.answerPlan(run.id, body);
      return { ...plan, asked: asked ? { id: asked.id, status: asked.status, output: asked.output } : null };
    }
    if (request.method === "GET" && match[2] === "receipts") return receiptsView(app, run.id);
    if (request.method === "GET" && !match[2])
      return {
        run,
        events: app.store.events(run.id),
        messages: app.store.messages(run.sessionId),
        usage: app.store.usage(run.id),
        cost: runCost(app, run.id),
        // Shown beside the answer, never folded into it: the owner reads both and decides.
        advice: app.runtime.advice(run.id),
      };
  }
  if (request.method === "GET" && path === "/api/activity")
    return liveActivity(app.store, app.runtime.owner).map((a) => ({ ...a, followUps: app.runtime.queued(a.sessionId).length }));
  if (request.method === "GET" && path === "/api/second-opinion")
    return secondOpinionSettings(app.store, app.runtime.owner);
  if (request.method === "POST" && path === "/api/second-opinion")
    return saveSecondOpinionSettings(app.store, app.runtime.owner, await readBody(request));
  if (request.method === "GET" && path === "/api/orchestration")
    return orchestrationSettings(app.store, app.runtime.owner);
  if (request.method === "POST" && path === "/api/orchestration")
    return saveOrchestrationSettings(app.store, app.runtime.owner, await readBody(request));
  // Wave 9: "Just do it" or "Show me the plan first", per conversation and per project.
  if (path === "/api/plan-act" && (request.method === "GET" || request.method === "POST"))
    return planActApi(app, request, await (request.method === "POST" ? readBody(request) : Promise.resolve({})));
  if (request.method === "GET" && path === "/api/health")
    return healthReport(app, { probeProvider: new URL(request.url ?? "/", "http://local").searchParams.get("probe") === "1" });
  if (request.method === "GET" && path === "/api/backup") {
    audit(app.store, app.runtime.owner, { action: "data.exported", actor: app.runtime.owner, subject: "a full backup",
      reason: "Everything except the saved secrets was written out as one file", outcome: "saved" });
    return app.store.backup(app.version);
  }
  if (request.method === "POST" && path === "/api/restore") return app.store.restore(await readBody(request, maximumBackupBytes));
  if (request.method === "GET" && path === "/v1/models") return modelsList(app);
  if (request.method === "GET" && path === "/api/hooks") return { hooks: app.hooks.list() };
  if (request.method === "GET" && path === "/api/teams") return { teams: app.teams.list() };
  if (request.method === "POST" && path === "/api/teams") return app.teams.save(await readBody(request));
  const team = /^\/api\/teams\/([a-f0-9-]{36})(?:\/(room|run|remove))?$/.exec(path);
  if (team && request.method === "GET" && !team[2]) return app.teams.get(team[1]!);
  if (team && request.method === "GET" && team[2] === "room") return { messages: app.teams.room(team[1]!) };
  if (team && request.method === "POST" && team[2] === "run") {
    const { prompt } = z.object({ prompt: z.string().trim().min(1).max(8000) }).strict().parse(await readBody(request));
    return app.teams.run(app.runtime, app.knowledge, team[1]!, prompt);
  }
  if (team && request.method === "POST" && team[2] === "remove") return app.teams.remove(team[1]!);
  if (request.method === "POST" && path === "/api/registry/browse") {
    const { url } = z.object({ url: z.string().url().max(2000) }).strict().parse(await readBody(request));
    return app.skillRegistry.browse(url);
  }
  if (request.method === "POST" && path === "/api/registry/install") {
    const { url, skillId } = z.object({ url: z.string().url().max(2000), skillId: z.string().min(1).max(64) }).strict().parse(await readBody(request));
    return app.skillRegistry.install(url, skillId);
  }
  // Wave 4: newer versions of skills installed from a registry, and a way back to the old one.
  if (request.method === "GET" && path === "/api/registry/updates") return app.skillRegistry.updates();
  if (request.method === "POST" && (path === "/api/registry/update" || path === "/api/registry/rollback")) {
    const { skillId } = z.object({ skillId: z.string().uuid() }).strict().parse(await readBody(request));
    return path.endsWith("update") ? app.skillRegistry.update(skillId) : app.skillRegistry.rollback(skillId);
  }
  // Wave 7: what the assistant is carrying, what it has learned, and a way to delete the learning.
  // What the assistant has learned is the owner's, exactly like their projects and their locker:
  // somebody else on a shared computer must not read it away or throw it away.
  if (request.method === "GET" && path === "/api/tools/catalog") {
    app.store.profiles.requireOwner("What the assistant has learned about its tools");
    return toolCatalogReport(app);
  }
  if (path === "/api/tools/meaning-search") {
    app.store.profiles.requireOwner("How the assistant finds its tools");
    if (request.method === "POST") {
      const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(await readBody(request));
      app.store.save("settings", app.runtime.owner, meaningSearchSetting, { enabled });
    }
    const reader = app.knowledgeBases.embeddings(app.runtime.owner);
    return { enabled: meaningSearchOn(app.store, app.runtime.owner),
      available: reader !== null,
      explanation: meaningSearchExplanation(meaningSearchReceiver(app, reader)) };
  }
  if (request.method === "POST" && path === "/api/tools/forget") {
    app.store.profiles.requireOwner("What the assistant has learned about its tools");
    const { what } = z.object({ what: z.enum(["history", "notes", "all"]).default("all") }).strict().parse(await readBody(request));
    return app.store.toolUsage.forget(app.runtime.owner, what);
  }
  const toolNote = /^\/api\/tools\/notes\/([a-f0-9-]{36})$/.exec(path);
  if (toolNote && request.method === "DELETE") {
    app.store.profiles.requireOwner("What the assistant has learned about its tools");
    return app.store.toolUsage.removeNote(app.runtime.owner, toolNote[1]!);
  }
  if (request.method === "GET" && path === "/api/plugins") return { plugins: await app.plugins.list(), problems: app.pluginProblems };
  const plugin = /^\/api\/plugins\/([a-z][a-z0-9-]{0,39})\/(inspect|enable|disable)$/.exec(path);
  if (plugin && request.method === "POST") {
    if (plugin[2] === "inspect") return app.plugins.inspect(plugin[1]!);
    if (plugin[2] === "disable") return app.plugins.disable(plugin[1]!);
    // Batch 26 (wave 8): the permissions the owner ticked. Left out, the plugin gets everything its
    // own manifest declared, exactly as switching one on did before.
    const body = z.object({ allow: z.array(z.string().trim().max(64)).max(20).optional() })
      .strict().parse((await readBody(request).catch(() => ({}))) ?? {});
    return app.plugins.enable(plugin[1]!, body.allow);
  }
  if (request.method === "GET" && path === "/api/evaluation") return { results: app.evaluation.list(), standard: standardSuite };
  if (request.method === "POST" && path === "/api/evaluation") { const body = await readBody(request) as Record<string, unknown>; return app.evaluation.run(app.runtime, Object.keys(body).length ? body : undefined); }
  // Suites kept as data: the five that ship, the owner's own, their history and model comparison.
  if (request.method === "GET" && path === "/api/evaluation/suites")
    return { suites: allSuites(app.store, app.runtime.owner) };
  if (request.method === "POST" && path === "/api/evaluation/suites")
    return saveSuite(app.store, app.runtime.owner, await readBody(request));
  if (request.method === "POST" && path === "/api/evaluation/suites/from-run")
    return suiteFromRun(app.store, app.runtime.owner, await readBody(request));
  if (request.method === "POST" && path === "/api/evaluation/suites/remove") {
    const { id } = z.object({ id: z.string().min(1).max(64) }).strict().parse(await readBody(request));
    return removeSuite(app.store, app.runtime.owner, id);
  }
  if (request.method === "POST" && path === "/api/evaluation/run")
    return app.evaluationSuites.run(await readBody(request));
  if (request.method === "POST" && path === "/api/evaluation/compare")
    return app.evaluationSuites.compare(await readBody(request));
  if (request.method === "GET" && path === "/api/evaluation/history") {
    const suite = new URL(request.url ?? "/", "http://local").searchParams.get("suite") ?? undefined;
    return { runs: app.evaluationSuites.history(suite), trend: app.evaluationSuites.trend(suite) };
  }
  // Wave 7 (benchmarks and experiments): scorers, benchmarks read from the owner's own files,
  // studies with checkpoints and resume, comparison with an interval, and the tool checks.
  if (request.method === "GET" && path === "/api/evaluation/benchmarks")
    return { adapters: benchmarkAdapters.map(({ id, name, format, layout }) => ({ id, name, format, layout })), notIntegrated: notIntegratedBenchmarks, scorers: scorerKinds };
  if (request.method === "GET" && path === "/api/studies")
    return { studies: app.studies.list(), results: app.studies.results().map(studySummary) };
  if (request.method === "POST" && path === "/api/studies") return app.studies.save(await readBody(request));
  // Batch 20 (wave 8): the one folder outside the workspace a study may read a benchmark from.
  if (path === "/api/studies/settings")
    return { settings: request.method === "POST" ? app.studies.configure(await readBody(request)) : app.studies.settings() };
  if (request.method === "POST" && path === "/api/studies/run") {
    const body = z.object({ id: z.string().min(1).max(64), fresh: z.boolean().default(false) }).strict().parse(await readBody(request));
    const result = await app.studies.run(body.id, { fresh: body.fresh });
    return { result, table: studyTable(result) };
  }
  if (request.method === "POST" && path === "/api/studies/compare") {
    const body = z.object({ a: z.string().uuid(), b: z.string().uuid() }).strict().parse(await readBody(request));
    const all = app.studies.results();
    const left = all.find((entry) => entry.id === body.a), right = all.find((entry) => entry.id === body.b);
    if (!left || !right) throw new Error("One of those study results is not on file");
    const comparison = compareStudies(left, right);
    return { comparison, table: comparisonTable(comparison) };
  }
  // Wave 9: the same scorers held against the real work, so a quiet break shows up on ordinary
  // tasks rather than only on the test set.
  if (path === "/api/evaluation/live") {
    if (request.method === "POST") return { settings: app.liveScoring.configure(await readBody(request)) };
    return { settings: app.liveScoring.settings(), recent: app.liveScoring.recent(50), summary: app.liveScoring.summary(100) };
  }
  if (request.method === "POST" && path === "/api/evaluation/tools")
    // The checks really write files and really save facts, so they do it in a project and under a
    // name of their own: nothing they do reaches the owner's folder or the owner's memory.
    return runToolChecksSafely(app, AbortSignal.timeout(120000));
  if (request.method === "GET" && path === "/api/policy")
    return { policy: readPolicy(app.store, app.runtime.owner), presets: policyPresets(), waiting: app.runtime.approvals.waiting() };
  if (request.method === "POST" && path === "/api/policy")
    return { policy: savePolicy(app.store, app.runtime.owner, await readBody(request)) };
  if (request.method === "POST" && path === "/api/policy/approve") {
    const input = z.object({ sessionId: z.string().uuid(), decision: z.enum(["allow", "deny"]),
      remember: PolicyRememberSchema.default("session"),
      // Batch 19 (wave 7): the fingerprint the person was shown, so a yes cannot land on a changed request.
      fingerprint: z.string().regex(/^[a-f0-9]{32}$/).optional() }).strict().parse(await readBody(request));
    return app.runtime.approve(input.sessionId, input.decision, input.remember, input.fingerprint);
  }
  if (request.method === "GET" && path === "/api/governance")
    return { settings: app.store.governance.settings(), setAside: app.store.governance.exclusions(), benchmarks: app.store.governance.benchmarks() };
  if (request.method === "POST" && path === "/api/governance") return app.store.governance.configure(await readBody(request));
  const restoreSkill = /^\/api\/governance\/set-aside\/([a-f0-9-]{36})\/restore$/.exec(path);
  if (restoreSkill && request.method === "POST") { app.store.governance.restore(restoreSkill[1]!); return { restored: true }; }
  const hookEnable = /^\/api\/hooks\/([a-z][a-z0-9_-]{0,39})\/enable$/.exec(path);
  if (hookEnable && request.method === "POST") return app.hooks.enable(hookEnable[1]!);
  const template = /^\/api\/templates\/(specialist|procedure)\/([a-f0-9-]{36})$/.exec(path);
  if (template && request.method === "GET") return exportTemplate(app.store, app.runtime.owner, template[1] as "specialist" | "procedure", template[2]!);
  if (request.method === "POST" && path === "/api/templates/import") return importTemplate(app.knowledge, app.runtime.context(), await readBody(request, 256 * 1024));
  if (request.method === "POST" && path === "/api/receipts/verify") {
    const body = z.object({ runId: z.string().min(1).max(64), data: z.record(z.string(), z.unknown()) }).strict().parse(await readBody(request));
    return app.store.receipts.verify(body.runId, body.data);
  }
  if (request.method === "POST" && path === "/api/run") {
    const input = RunInputSchema.parse(await readBody(request));
    // Wave 6: a task started while somebody's profile is switched on is filed under their name.
    return runForCurrentPerson(app, {
      prompt: input.prompt,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.temporary ? { temporary: true } : {}),
      ...(input.checks ? { checks: CompletionCheckSchema.parse(input.checks) } : {}),
      ...(input.dryRun ? { dryRun: true } : {}),
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.plan !== undefined ? { plan: input.plan } : {}),
      ...(input.verify !== undefined ? { verify: input.verify } : {}),
    });
  }
  if (request.method === "POST" && path === "/api/action") {
    const action = actionSchema.parse(await readBody(request));
    return app.runtime.executeTool(action.tool, action.args);
  }
  // Usage and observability routes
  if (request.method === "GET" && path === "/api/usage") {
    const url = new URL(request.url ?? "/", "http://local");
    const range = (url.searchParams.get("range") ?? "30d") as "7d" | "30d" | "90d" | "all";
    const by = (url.searchParams.get("by") ?? "day") as "day" | "model" | "conversation" | "source";
    const { overrides } = pricingSettings(app.store, app.runtime.owner);
    const data = app.store.usageStore().aggregateUsage(range, by, overrides);
    const budget = app.store.get("settings", app.runtime.owner, "usage_budget")?.data as { maxMonthlyTokens?: number } | undefined;
    const stats = app.store.usageStore().getMonthlyStats(budget?.maxMonthlyTokens, overrides);
    // Wave 7: the few numbers that say how it is behaving, beside what it cost.
    const statistics = app.store.usageStore().statistics(app.runtime.owner, range === "7d" ? 7 : range === "90d" ? 90 : 30);
    return { data, stats, statistics, pricing: pricingTableInUse(app.store, app.runtime.owner) };
  }
  if (request.method === "GET" && path === "/api/pricing")
    return pricingTableInUse(app.store, app.runtime.owner);
  if (request.method === "POST" && path === "/api/pricing")
    return savePricingSettings(app.store, app.runtime.owner, await readBody(request));
  if (request.method === "GET" && path === "/api/trace/settings")
    return traceSettings(app.store, app.runtime.owner);
  if (request.method === "POST" && path === "/api/trace/settings")
    return saveTraceSettings(app.store, app.runtime.owner, app.runtime.workspace, await readBody(request));
  if (request.method === "POST" && path === "/api/diagnostics/bundle")
    return writeDiagnosticsBundle(app.store, app.runtime.owner, dataDir, {
      health: await healthReport(app), version: app.version, memory: app.memory.tidy.health(app.runtime.owner),
    });
  const traceMatch = /^\/api\/runs\/([a-f0-9-]{36})\/trace$/.exec(path);
  if (request.method === "GET" && traceMatch) {
    const run = app.store.run(traceMatch[1]!);
    if (!run || run.owner !== app.store.profiles.scope()) throw new HttpError(404, "Run not found");
    return buildTraceDocument(app.store, run.id, app.version);
  }
  // "Look inside" a task: rounds, tool calls, plan, verdicts and steering in one answer.
  const inspectMatch = /^\/api\/runs\/([a-f0-9-]{36})\/inspect$/.exec(path);
  if (request.method === "GET" && inspectMatch) {
    const run = app.store.run(inspectMatch[1]!);
    if (!run || run.owner !== app.runtime.owner) throw new HttpError(404, "Run not found");
    // A tool call's raw arguments are read back off the assistant message, which the runtime never
    // scrubbed; nothing leaves here carrying a saved password or key.
    return app.runtime.hideSecrets(inspectRun(app.store, run.id, await trajectoryOptions(app, run.id)));
  }
  // Batch 26 (wave 8): "Do this again" — the same words, the same tools and the same model, in a
  // conversation of its own, so the two can be read side by side.
  const replay = /^\/api\/runs\/([a-f0-9-]{36})\/replay$/.exec(path);
  if (request.method === "POST" && replay) {
    const run = app.store.run(replay[1]!);
    if (!run || run.owner !== app.runtime.owner) throw new HttpError(404, "Run not found");
    const done = await replayRun(app.runtime, app.store, run.id);
    return { original: done.original, replay: done.replay, status: done.run.status, plan: done.plan };
  }
  // Wave 7: the same task as a trajectory — "Look inside" plus the conversation's messages and the
  // spans — in the documented shape, for keeping or for feeding an evaluation run.
  const trajectory = /^\/api\/runs\/([a-f0-9-]{36})\/trajectory$/.exec(path);
  if (request.method === "GET" && trajectory) {
    const run = app.store.run(trajectory[1]!);
    if (!run || run.owner !== app.runtime.owner) throw new HttpError(404, "Run not found");
    return app.runtime.hideSecrets(buildTrajectory(app.store, run.id, await trajectoryOptions(app, run.id)));
  }
  if (request.method === "GET" && /^\/api\/runs\/([a-f0-9-]{36})\/timeline$/.test(path)) {
    const match = /^\/api\/runs\/([a-f0-9-]{36})\/timeline$/.exec(path);
    if (!match) throw new HttpError(400, "Invalid run ID");
    const run = app.store.run(match[1]!);
    if (!run || run.owner !== app.store.profiles.scope()) throw new HttpError(404, "Run not found");
    return { timeline: app.store.usageStore().getRunTimeline(run.id) };
  }
  // Wave 7: writing the month's usage out as a spreadsheet, on a schedule, into your workspace.
  if (path === "/api/usage/metering") {
    const deps = meteringDeps(app);
    if (request.method === "GET") return { metering: meteringSettings(app.store, app.runtime.owner) };
    if (request.method === "POST") {
      const settings = saveMeteringSettings(app.store, app.runtime.owner, await readBody(request));
      /* A folder that would climb out of the workspace is refused now, not at the next beat. */
      meteringFolder(deps.workspace, settings.folder);
      return { metering: settings };
    }
  }
  if (request.method === "POST" && path === "/api/usage/metering/now") {
    const written = await writeMeteringFile(meteringDeps(app));
    return { ...written, metering: meteringSettings(app.store, app.runtime.owner) };
  }
  if (request.method === "GET" && path === "/api/usage/budget") {
    const budget = app.store.get("settings", app.runtime.owner, "usage_budget")?.data;
    return { budget: budget || null };
  }
  if (request.method === "POST" && path === "/api/usage/budget") {
    const input = budgetSchema.parse(await readBody(request));
    app.store.save("settings", app.runtime.owner, "usage_budget", input);
    return { budget: input };
  }
  throw new HttpError(404, "Endpoint not found");
}
async function sessionApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  // Wave 6: conversations belong to whoever's profile is switched on, not always to the owner.
  const owner = app.store.profiles.scope();
  if (request.method === "POST" && path === "/api/sessions/search")
    return app.store.searchSessions(owner, await readBody(request));
  if (request.method === "POST" && path === "/api/sessions/import")
    return app.store.importSession(owner, await readBody(request, maximumArchiveBytes));
  const match = /^\/api\/sessions\/([a-f0-9-]{36})(?:\/(export|duplicate|model|discard|skill|followups|memory-policy|summary|pins|tree|merge-note))?$/.exec(path);
  // Wave 8: conversations branched off this one as a tree, and carrying one branch's answer back.
  if (match && match[2] === "tree" && request.method === "GET") return app.sessionTree.tree(owner, match[1]!);
  if (match && match[2] === "merge-note" && request.method === "POST")
    return app.sessionTree.mergeNote(owner, { sessionId: match[1]! });
  if (match && match[2] === "summary" && request.method === "GET") return app.store.sessionSummary(owner, match[1]!);
  if (match && match[2] === "pins") {
    if (request.method === "GET") return { pins: app.store.sessionSummary(owner, match[1]!).pins };
    if (request.method === "POST") {
      const value = z.object({ messageId: z.number().int().positive(), pinned: z.boolean().default(true) }).strict().parse(await readBody(request));
      return app.store.pinMessage(owner, match[1]!, value.messageId, value.pinned);
    }
  }
  if (match && match[2] === "memory-policy") {
    if (!app.store.ownsSession(owner, match[1]!)) throw new HttpError(404, "Session not found");
    if (request.method === "GET") return { remember: !app.store.memorySuppressed(owner, match[1]!) };
    if (request.method === "POST") {
      const { remember } = z.object({ remember: z.boolean() }).strict().parse(await readBody(request));
      return { remember: !app.store.setMemorySuppressed(owner, match[1]!, !remember) };
    }
  }
  if (match && match[2] === "followups") {
    if (request.method === "GET") return { followUps: app.runtime.queued(match[1]!) };
    if (request.method === "POST") {
      const { prompt } = z.object({ prompt: z.string().trim().min(1).max(16000) }).strict().parse(await readBody(request));
      return app.runtime.followUp(match[1]!, prompt);
    }
  }
  if (match && request.method === "GET" && !match[2]) return app.store.sessionView(owner, match[1]!);
  if (match && match[2] === "skill") {
    if (!app.store.ownsSession(owner, match[1]!)) throw new HttpError(404, "Session not found");
    const key = `pinned-skill:${match[1]}`;
    if (request.method === "POST") {
      const { skillId } = z.object({ skillId: z.string().uuid().nullable() }).strict().parse(await readBody(request));
      if (skillId && !app.store.skills.catalog(owner).some((s) => s.id === skillId)) throw new HttpError(400, "That skill is not enabled");
      if (skillId) app.store.save("settings", owner, key, { skillId }); else app.store.delete("settings", owner, key);
      return { skillId };
    }
    if (request.method === "GET") return { skillId: (app.store.get("settings", owner, key)?.data as { skillId?: string } | undefined)?.skillId ?? null };
  }
  if (match && match[2] === "model") {
    if (request.method === "POST")
      return app.runtime.models.configureSession(owner, match[1]!, await readBody(request));
    if (request.method === "GET") {
      if (!app.store.ownsSession(owner, match[1]!)) throw new HttpError(404, "Session not found");
      return { ...app.runtime.models.session(owner, match[1]!), effective: app.runtime.models.plan(owner, match[1]!).choice };
    }
  }
  if (match && request.method === "GET" && match[2] === "export") {
    audit(app.store, owner, { action: "data.exported", actor: owner, subject: `conversation ${match[1]!.slice(0, 8)}`,
      reason: "One conversation was written out as a file", outcome: "saved" });
    return app.store.exportSession(owner, match[1]!);
  }
  if (match && request.method === "POST" && match[2] === "discard") {
    z.object({}).strict().parse(await readBody(request));
    return app.store.discardSession(owner, match[1]!);
  }
  if (match && request.method === "POST" && match[2] === "duplicate") {
    z.object({}).strict().parse(await readBody(request));
    return app.store.duplicateSession(owner, match[1]!);
  }
  throw new HttpError(404, "Endpoint not found");
}
async function historyApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const history = app.store.workspaceHistory;
  if (request.method === "GET" && path === "/api/history/files")
    return { versions: history.history(new URL(request.url ?? "/", "http://local").searchParams.get("path") ?? "") };
  if (request.method === "POST" && path === "/api/history/restore")
    return history.restore(z.object({ versionId: z.string().uuid() }).strict().parse(await readBody(request)).versionId);
  if (request.method === "GET" && path === "/api/history/snapshots") return { snapshots: history.snapshots() };
  if (request.method === "POST" && path === "/api/history/snapshots") return history.snapshot(await readBody(request));
  const restore = /^\/api\/history\/snapshots\/([a-f0-9-]{36})\/restore$/.exec(path);
  if (restore && request.method === "POST") return history.restoreSnapshot(restore[1]!);
  throw new HttpError(404, "Endpoint not found");
}
/**
 * Settings → Developer: the language servers and the debuggers the owner has on this computer.
 * Both are off until they say otherwise, and saving refuses a program that is not there.
 */
async function developerApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  if (path === "/api/developer/language-servers")
    return request.method === "POST"
      ? saveLanguageServerSettings(app.store, owner, await readBody(request))
      : languageServerSettings(app.store, owner);
  if (path === "/api/developer/debug-adapters")
    return request.method === "POST"
      ? saveDebugSettings(app.store, owner, await readBody(request))
      : debugSettings(app.store, owner);
  if (path === "/api/developer/running" && request.method === "GET")
    return { languageServers: app.languageServers.list(), services: app.openApiTools.list() };
  throw new HttpError(404, "Endpoint not found");
}

async function memoryApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  // Wave 6: saved facts belong to whoever's profile is switched on, not always to the owner.
  const owner = app.store.profiles.scope();
  if (request.method === "GET" && path === "/api/memory/export") {
    audit(app.store, owner, { action: "data.exported", actor: owner, subject: "your saved notes",
      reason: "The facts the assistant remembers were written out", outcome: "saved" });
    return app.store.exportMemory(owner);
  }
  if (request.method === "POST" && path === "/api/memory/import") {
    const body = await readBody(request, maximumMemoryArchiveBytes);
    // Facts arrive either as the whole-archive file or as JSON Lines; the second kind is deduplicated.
    const lines = z.object({ jsonl: z.string().max(maximumImportBytes) }).strict().safeParse(body);
    return lines.success ? app.memory.transfer.import(owner, lines.data.jsonl) : app.store.importMemory(owner, body);
  }
  if (request.method === "POST" && path === "/api/memory/capacity")
    return app.store.configureMemory(owner, await readBody(request));
  if (request.method === "POST" && path === "/api/memory/forget/preview") {
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).strict().parse(await readBody(request));
    return app.store.forgetMemoryPreview(owner, sessionId);
  }
  if (request.method === "POST" && path === "/api/memory/forget")
    return app.store.forgetMemory(owner, await readBody(request));
  if (path === "/api/memory/retrieval") {
    if (request.method === "GET") return app.memory.retrieval.view(owner);
    if (request.method === "POST") return app.memory.retrieval.configure(owner, await readBody(request));
  }
  if (request.method === "POST" && path === "/api/memory/index") {
    z.object({}).strict().parse(await readBody(request));
    return app.memory.retrieval.index(owner);
  }
  if (request.method === "POST" && path === "/api/memory/search") {
    const { query, limit } = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(50).default(20) })
      .strict().parse(await readBody(request));
    return { results: await app.memory.retrieval.search(owner, query, undefined, limit) };
  }
  // "Tidy my memory" in one screen: the four checks together, and the same call with stage on.
  if (request.method === "GET" && path === "/api/memory/tidy/all") return app.memory.tidy.run(owner);
  if (request.method === "POST" && path === "/api/memory/tidy/all") return app.memory.tidy.run(owner, await readBody(request));
  if (request.method === "GET" && path === "/api/memory/health") return app.memory.tidy.health(owner);
  // Wave 9: what the assistant has noticed for itself, and turning it into suggestions. Looking
  // changes nothing at all; the second call only ever adds to the queue the owner decides on.
  if (request.method === "GET" && path === "/api/memory/learned") return { noticed: app.learning.notice(owner) };
  if (request.method === "POST" && path === "/api/memory/learned") {
    z.object({}).strict().parse(await readBody(request));
    return app.learning.propose(owner);
  }
  // Wave 9: what reading recent conversations again for fact cards would cost. Worked out here
  // with no model call at all, so the owner sees it before anything is sent anywhere. The reading
  // itself is POST /api/knowledge/refresh, which answers with the same reckoning afterwards.
  if (request.method === "GET" && path === "/api/memory/refresh") return app.knowledgeCards.cost(owner);
  const keep = /^\/api\/memory\/([^/]{1,200})\/keep$/.exec(path);
  if (request.method === "POST" && keep) return app.store.promoteMemory(owner, decodeURIComponent(keep[1]!));
  if (request.method === "GET" && path === "/api/memory/tidy") return app.memory.hygiene.review(owner);
  if (request.method === "POST" && path === "/api/memory/tidy") {
    z.object({}).strict().parse(await readBody(request));
    const { staged, review } = app.memory.hygiene.suggest(owner);
    return { suggested: staged.length, proposals: staged, review };
  }
  if (request.method === "POST" && path === "/api/memory/hygiene") return app.store.memoryHygiene(owner, await readBody(request));
  if (request.method === "GET" && path === "/api/memory/archive") return { archived: app.store.archivedMemory(owner) };
  if (request.method === "POST" && path === "/api/memory/consolidate") return app.store.review.consolidate(app.runtime, owner);
  if (request.method === "GET" && path === "/api/memory/settings") return app.store.review.settings(owner);
  if (request.method === "POST" && path === "/api/memory/settings") return app.store.review.configure(owner, await readBody(request));
  if (request.method === "GET" && path === "/api/memory/proposals") return { proposals: app.store.review.proposals(owner) };
  // Batch 27 (wave 8): write the Markdown mirror of what is remembered by hand. It also writes
  // itself after every task, so this is for the owner who wants it now.
  if (request.method === "POST" && path === "/api/memory/mirror")
    return app.memoryMirror.regenerate(owner, await readBody(request));
  const decide = /^\/api\/memory\/proposals\/([a-f0-9-]{36})\/(accept|reject)$/.exec(path);
  if (decide && request.method === "POST") return app.store.review.decide(owner, decide[1]!, decide[2] === "accept");
  if (request.method === "GET" && path === "/api/memory/versions")
    return { versions: app.store.review.versions(owner, new URL(request.url ?? "/", "http://local").searchParams.get("id") ?? "") };
  if (request.method === "POST" && path === "/api/memory/versions/restore") {
    const body = z.object({ id: z.string().min(1).max(200), revision: z.number().int().positive() }).strict().parse(await readBody(request));
    return app.store.review.restoreVersion(owner, body.id, body.revision);
  }
  if (request.method === "GET" && path === "/api/memory/checkpoints") return { checkpoints: app.store.review.checkpoints(owner) };
  if (request.method === "POST" && path === "/api/memory/checkpoints") return app.store.review.checkpoint(owner, await readBody(request));
  const restoreCheckpoint = /^\/api\/memory\/checkpoints\/([a-f0-9-]{36})\/restore$/.exec(path);
  if (restoreCheckpoint && request.method === "POST") return app.store.review.restoreCheckpoint(owner, restoreCheckpoint[1]!);
  const restore = /^\/api\/memory\/archive\/([^/]{1,200})\/restore$/.exec(path);
  if (restore && request.method === "POST") {
    z.object({}).strict().parse(await readBody(request));
    return app.store.restoreMemory(owner, decodeURIComponent(restore[1]!));
  }
  throw new HttpError(404, "Endpoint not found");
}
async function projectsApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  app.store.profiles.requireOwner("Projects"); // Wave 6: projects stay with the owner.
  const owner = app.runtime.owner, projects = app.store.projects;
  if (request.method === "GET" && path === "/api/projects") return { active: projects.active(owner), all: projects.list(owner) };
  if (request.method === "POST" && path === "/api/projects") {
    const body = await readBody(request) as { modelPreset?: unknown };
    if (typeof body?.modelPreset === "string" && !app.runtime.models.presets.has(body.modelPreset))
      throw new HttpError(400, "That model preset is not configured");
    return projects.save(owner, body);
  }
  if (request.method === "POST" && path === "/api/projects/active") return projects.setActive(owner, await readBody(request));
  const match = /^\/api\/projects\/([a-z0-9-]{1,40})\/remove$/.exec(path);
  if (match && request.method === "POST") {
    z.object({}).strict().parse(await readBody(request));
    const result = projects.remove(owner, match[1]!);
    app.store.locker.removeProject(owner, match[1]!);
    return result;
  }
  throw new HttpError(404, "Endpoint not found");
}
/** Secret values go in and never come out; only names, dates and who used them are listed. */
async function secretsApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  app.store.profiles.requireOwner("The secrets locker"); // Wave 6: secrets stay with the owner.
  const owner = app.runtime.owner, secrets = app.store.secrets;
  const known = (project: string) => { if (!app.store.projects.list(owner).some((p) => p.id === project)) throw new HttpError(404, "Project not found"); };
  if (request.method === "GET" && path === "/api/secrets/audit")
    return { uses: secrets.audit(owner), reminders: secrets.reminders(owner, app.store.projects.list(owner).map((p) => p.id)) };
  const listMatch = /^\/api\/secrets\/([a-z0-9-]{1,40})$/.exec(path);
  if (listMatch && request.method === "GET") { known(listMatch[1]!); return { project: listMatch[1], secrets: secrets.list(owner, listMatch[1]!) }; }
  if (request.method === "POST" && path === "/api/secrets") {
    const body = z.object({ project: z.string(), name: z.string(), value: z.string(), expiresInDays: z.number().optional() })
      .strict().parse(await readBody(request, 64 * 1024));
    known(body.project);
    return secrets.put(owner, body.project, body.name, body.value, { expiresInDays: body.expiresInDays ?? 0 });
  }
  const action = /^\/api\/secrets\/([a-z0-9-]{1,40})\/([A-Z][A-Z0-9_]{0,63})\/(remove|rotate)$/.exec(path);
  if (action && request.method === "POST") {
    if (action[3] === "remove") {
      z.object({}).strict().parse(await readBody(request));
      return { removed: secrets.remove(owner, action[1]!, action[2]!) };
    }
    const body = z.object({ value: z.string(), expiresInDays: z.number().optional() }).strict().parse(await readBody(request, 64 * 1024));
    known(action[1]!);
    return secrets.rotate(owner, action[1]!, action[2]!, body.value, { expiresInDays: body.expiresInDays ?? 0 });
  }
  throw new HttpError(404, "Endpoint not found");
}
/** Locking the app, and the privacy checks on messages that leave this computer. */
async function guardApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  if (request.method === "GET" && path === "/api/lock") return app.sessionLock.state();
  if (request.method === "POST" && path === "/api/lock") return app.sessionLock.lock();
  if (request.method === "POST" && path === "/api/lock/unlock") { z.object({}).strict().parse(await readBody(request)); return app.sessionLock.unlock(); }
  if (request.method === "POST" && path === "/api/lock/settings") return app.sessionLock.configure(await readBody(request));
  if (request.method === "GET" && path === "/api/privacy") return app.privacy.settings();
  if (request.method === "POST" && path === "/api/privacy") return app.privacy.configure(await readBody(request));
  throw new HttpError(404, "Endpoint not found");
}
/** Signing in to an outside service: the app opens the address this returns in the browser. */
async function connectionsApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  if (request.method === "POST" && path === "/api/connections/oauth/start") {
    const started = await app.oauth.start(await readBody(request, 16 * 1024));
    // The flow finishes on its own when the service calls back; nothing here waits for it.
    app.oauth.waitFor(started.id).catch(() => undefined);
    return started;
  }
  const cancel = /^\/api\/connections\/oauth\/([a-z][a-z0-9-]{0,39})\/cancel$/.exec(path);
  if (cancel && request.method === "POST") {
    z.object({}).strict().parse(await readBody(request));
    await app.oauth.cancel(cancel[1]!);
    return { cancelled: cancel[1] };
  }
  // Batch 19 (wave 7): adding a model service from the catalog, checked before anything is saved.
  if (request.method === "POST" && path === "/api/connections/from-preset")
    return connectFromPreset(
      { models: app.runtime.models, locker: app.store.locker, owner: app.runtime.owner, policy: app.web.policy, store: app.store },
      await readBody(request, 16 * 1024),
    );
  // Taking one back out again: the model list, the written-down record and the key, all at once.
  if (request.method === "POST" && path === "/api/connections/forget") {
    const { id } = z.object({ id: z.string().min(1).max(64) }).strict().parse(await readBody(request, 4 * 1024));
    return forgetConnection(
      { models: app.runtime.models, locker: app.store.locker, owner: app.runtime.owner, policy: app.web.policy, store: app.store },
      id,
    );
  }
  if (request.method === "GET" && path === "/api/connections/catalog")
    return { pricedAt: providerCatalog().pricedAt, services: catalogEntries() };
  const status = /^\/api\/connections\/oauth\/([a-z][a-z0-9-]{0,39})$/.exec(path);
  if (status && request.method === "GET") {
    const tokens = await app.oauth.saved(status[1]!);
    return { id: status[1], signedIn: tokens !== null, expiresAt: tokens?.expiresAt ?? null, scope: tokens?.scope ?? null };
  }
  throw new HttpError(404, "Endpoint not found");
}
async function schedulesApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  // Batch 20 (wave 8): adding, listing and removing a schedule over the local API, so `branch
  // schedule` works against the engine already running rather than starting a second one.
  if (path === "/api/schedules" || path === "/api/schedules/") {
    app.store.profiles.requireOwner("Your schedules");
    if (request.method === "GET") return { schedules: app.store.list("schedules", owner) };
    if (request.method === "POST") return app.scheduler.create(scheduleContext(app), await readBody(request));
    throw new HttpError(404, "Endpoint not found");
  }
  const match = /^\/api\/schedules\/([a-f0-9-]{36})(?:\/(trigger|remove))?$/.exec(path);
  if (!match) throw new HttpError(404, "Endpoint not found");
  const record = app.store.get("schedules", owner, match[1]!);
  if (!record) throw new HttpError(404, "Schedule not found");
  if (request.method === "GET" && !match[2]) return { ...record, hookPath: record.data.hookToken ? `/hooks/${record.id}` : null };
  if (request.method === "POST" && match[2] === "trigger") {
    z.object({}).strict().parse(await readBody(request));
    return app.scheduler.trigger(owner, record.id, undefined, "local");
  }
  if (request.method === "POST" && match[2] === "remove") {
    z.object({}).strict().parse(await readBody(request));
    return app.scheduler.remove(scheduleContext(app), record.id);
  }
  throw new HttpError(404, "Endpoint not found");
}
/** The owner's own hands, for a schedule they are adding or removing from the command line. */
function scheduleContext(app: Branch) {
  return app.runtime.context({ signal: AbortSignal.timeout(30000), source: "owner" });
}
/** Webhook triggers carry their own per-schedule token instead of the session token. */
async function hook(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const match = /^\/hooks\/([a-f0-9-]{36})$/.exec(path);
  if (!match || request.method !== "POST") throw new HttpError(404, "Endpoint not found");
  const record = app.store.get("schedules", app.runtime.owner, match[1]!);
  const expected = typeof record?.data.hookToken === "string" ? record.data.hookToken : "";
  const supplied = String(request.headers["x-branch-hook-token"] ?? "");
  const same = expected.length > 0 && supplied.length === expected.length &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!record || !same) throw new HttpError(401, "Hook token rejected");
  const payload = await readBody(request, 16 * 1024).catch(() => ({}));
  const run = await app.scheduler.trigger(app.runtime.owner, record.id, payload, "webhook");
  return { runId: run.id, status: run.status };
}
/**
 * WhatsApp sends messages to this address instead of holding a connection open, so the route has
 * to work without the app's session token. WhatsApp checks the address once with a challenge it
 * expects echoed back as plain text, and signs every later request with the app secret.
 */
async function whatsAppWebhook(app: Branch, request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  const match = /^\/webhooks\/whatsapp\/([a-z][a-z0-9_-]{0,29})(?:\/([a-f0-9]{32}))?$/.exec(path);
  if (!match) return false;
  // The random word on the end of the address is what makes it unguessable. Checked before the
  // channel is even looked up, so a wrong address tells nobody which names exist.
  const wrongAddress = webhookAddressRefusal(app.store, app.runtime.owner, match[1]!, match[2]);
  if (wrongAddress) throw new HttpError(404, wrongAddress);
  const adapter = app.channels.adapter(match[1]!);
  if (!(adapter instanceof WhatsAppAdapter)) throw new HttpError(404, "No WhatsApp channel with that name is connected");
  if (request.method === "GET") {
    const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
    const challenge = tryOr(() => adapter.verify(query), 403);
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(challenge);
    return true;
  }
  if (request.method !== "POST") throw new HttpError(404, "Endpoint not found");
  const { raw } = await readBodyWithRaw(request, 256 * 1024).catch(() => { throw new HttpError(400, "That message could not be read"); });
  const signature = request.headers["x-hub-signature-256"];
  const result = await adapter.receive(raw, typeof signature === "string" ? signature : undefined)
    .catch((error: unknown) => { throw new HttpError(401, errorText(error)); });
  send(response, 200, result);
  return true;
}
/**
 * The one address every other chat service posts to. Which signature has to be there, and what the
 * post looks like inside, comes from that service's row in `data/channels.json`; this route only
 * hands over the exact bytes and the headers. Like the WhatsApp route it carries no session key,
 * so the signature check is the only thing letting a post through.
 */
async function chatWebhook(app: Branch, request: IncomingMessage, response: ServerResponse, path: string, limiter: AuthLimiter): Promise<boolean> {
  const match = /^\/webhooks\/chat\/([a-z][a-z0-9_-]{0,29})(?:\/([a-f0-9]{32}))?$/.exec(path);
  if (!match) return false;
  // Nothing here carries the session key, so a place that keeps posting rubbish is made to wait,
  // exactly as somewhere guessing the key is. That also keeps a flood off the record of refusals.
  const from = requestSource(request.socket?.remoteAddress);
  const waiting = limiter.refusal(from, "signature");
  if (waiting) throw new HttpError(429, waiting);
  // The random word on the end of the address is what makes it unguessable. Checked before the
  // channel is even looked up, so a wrong address tells nobody which channel names exist.
  const wrongAddress = webhookAddressRefusal(app.store, app.runtime.owner, match[1]!, match[2]);
  if (wrongAddress) throw new HttpError(404, wrongAddress);
  const adapter = app.channels.adapter(match[1]!);
  if (adapter instanceof MetaMessagingAdapter) return metaWebhook(app, adapter, request, response, { limiter, from });
  if (!(adapter instanceof WebhookChatAdapter)) throw new HttpError(404, "No chat service with that name is connected");
  if (request.method !== "POST") throw new HttpError(404, "Endpoint not found");
  const { raw } = await readBodyWithRaw(request, 256 * 1024).catch(() => { throw new HttpError(400, "That message could not be read"); });
  const result = await adapter.receive(raw, request.headers)
    .catch((error: unknown) => { throw refusedChatPost(app, match[1]!, adapter.kind, error, { limiter, from }); });
  limiter.succeed(from);
  // Some services will not send anything until the address echoes a word back once.
  send(response, 200, result.challenge === undefined ? { accepted: result.accepted } : { challenge: result.challenge });
  return true;
}
/** Where a post came from, so repeated refusals from one place can be counted and slowed down. */
interface ChatWebhookLimit { limiter: AuthLimiter; from: string }
/** A post that did not prove it came from the service is refused, and the refusal is written down. */
function refusedChatPost(app: Branch, channel: string, kind: string, error: unknown, limit: ChatWebhookLimit): HttpError {
  audit(app.store, app.runtime.owner, {
    action: "auth.refused", actor: `the ${kind} connection`, subject: `/webhooks/chat/${channel}`, source: "system",
    reason: "A message arrived claiming to come from that chat service, but it was not proved to have come from it",
    outcome: "refused",
  });
  // The post itself is never written down: it was not proved genuine, so nothing inside it is kept.
  noteAuthFailure(limit.limiter, app.store, app.runtime.owner, limit.from, "a chat service's signature");
  return new HttpError(401, errorText(error));
}
/** Messenger and Instagram answer Meta's one-off check and sign every later post, as WhatsApp does. */
async function metaWebhook(app: Branch, adapter: MetaMessagingAdapter, request: IncomingMessage, response: ServerResponse, limit: ChatWebhookLimit): Promise<boolean> {
  if (request.method === "GET") {
    const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
    const challenge = tryOr(() => adapter.verify(query), 403);
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(challenge);
    return true;
  }
  if (request.method !== "POST") throw new HttpError(404, "Endpoint not found");
  const { raw } = await readBodyWithRaw(request, 256 * 1024).catch(() => { throw new HttpError(400, "That message could not be read"); });
  const signature = request.headers["x-hub-signature-256"];
  const result = await adapter.receive(raw, typeof signature === "string" ? signature : undefined)
    .catch((error: unknown) => { throw refusedChatPost(app, adapter.id, adapter.kind, error, limit); });
  limit.limiter.succeed(limit.from);
  send(response, 200, result);
  return true;
}
function tryOr<T>(work: () => T, status: number): T {
  try { return work(); } catch (error) { throw new HttpError(status, errorText(error)); }
}
const triggerBodyLimit = 256 * 1024;
async function triggerFire(app: Branch, request: IncomingMessage, triggerId: string): Promise<unknown> {
  const trigger = app.triggers.get(app.runtime.owner, triggerId);
  if (!trigger) throw new HttpError(404, "Trigger not found");
  if (Number(request.headers["content-length"] ?? 0) > triggerBodyLimit)
    throw new HttpError(413, `Request exceeds ${triggerBodyLimit / 1024} KiB`);

  const { raw, parsed } = await readBodyWithRaw(request, triggerBodyLimit).catch((error: unknown) => {
    const message = errorText(error);
    throw new HttpError(message.includes("exceeds") ? 413 : 400, message);
  });

  const verified = app.triggers.verify(trigger, request.headers, raw);
  if (!verified.valid) throw new HttpError(401, verified.error ?? "Unauthorized");
  // A copied request cannot be sent again: when the owner asked for it, the timestamp must be
  // fresh and the nonce one nobody has used before.
  const fresh = app.triggers.checkFreshness(trigger, request.headers);
  if (!fresh.valid) throw new HttpError(401, fresh.error ?? "Unauthorized");

  return app.triggers.fire(app.runtime.owner, triggerId, parsed).catch((error: unknown) => {
    const message = errorText(error);
    if (message.includes("disabled")) throw new HttpError(403, message);
    if (message.includes("Rate limit")) throw new HttpError(429, message);
    throw error;
  });
}
async function triggersApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  const context = app.runtime.context();

  if (request.method === "GET" && path === "/api/triggers")
    return { triggers: app.triggers.list(owner) };

  if (request.method === "POST" && path === "/api/triggers")
    return app.triggers.create(context, await readBody(request));

  const match = /^\/api\/triggers\/([a-f0-9-]{36})(?:\/(log|rotate-secret|enabled|remove))?$/.exec(path);
  if (!match) throw new HttpError(404, "Endpoint not found");

  const trigger = app.triggers.get(owner, match[1]!);
  if (!trigger) throw new HttpError(404, "Trigger not found");

  if (request.method === "GET" && !match[2])
    return trigger;

  if (request.method === "GET" && match[2] === "log")
    return { log: app.triggers.getLog(match[1]!, owner) };

  if (request.method === "POST" && match[2] === "rotate-secret") {
    z.object({}).strict().parse(await readBody(request));
    const secret = app.triggers.rotateSecret(owner, match[1]!);
    return { secret };
  }

  if (request.method === "POST" && match[2] === "enabled") {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(await readBody(request));
    return app.triggers.setEnabled(owner, match[1]!, enabled);
  }

  if (["POST", "DELETE"].includes(request.method ?? "") && match[2] === "remove") {
    app.triggers.remove(owner, match[1]!);
    return { removed: true };
  }

  throw new HttpError(404, "Endpoint not found");
}
async function webhooksApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  const context = app.runtime.context();

  if (request.method === "GET" && path === "/api/webhooks")
    return { webhooks: app.webhooks.list(owner) };

  if (request.method === "POST" && path === "/api/webhooks")
    return app.webhooks.create(context, await readBody(request));

  const match = /^\/api\/webhooks\/([a-f0-9-]{36})(?:\/(log|test|remove|enable|preview))?$/.exec(path);
  if (!match) throw new HttpError(404, "Endpoint not found");

  const webhook = app.webhooks.get(owner, match[1]!);
  if (!webhook) throw new HttpError(404, "Webhook not found");

  if (request.method === "GET" && !match[2])
    return webhook;

  if (request.method === "GET" && match[2] === "log")
    return { log: app.webhooks.getLog(match[1]!, owner) };

  if (request.method === "POST" && match[2] === "test") {
    z.object({}).strict().parse(await readBody(request));
    return app.webhooks.test(owner, match[1]!);
  }

  if (["POST", "DELETE"].includes(request.method ?? "") && match[2] === "remove") {
    app.webhooks.remove(owner, match[1]!);
    return { removed: true };
  }

  // The shape editor in Settings: what one event would be sent as, without sending anything.
  if (request.method === "POST" && match[2] === "preview") {
    const body = z.object({ event: z.string().min(1).max(50), sample: z.record(z.string().max(60), z.unknown()).default({}) })
      .strict().parse(await readBody(request));
    return app.webhooks.preview(owner, match[1]!, body.event, body.sample);
  }

  if (request.method === "POST" && match[2] === "enable") {
    z.object({}).strict().parse(await readBody(request));
    return app.webhooks.enable(owner, match[1]!);
  }

  throw new HttpError(404, "Endpoint not found");
}
async function channelsApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  if (request.method === "GET" && path === "/api/channels") return { ...app.channels.summary(), outstanding: app.channels.outstanding() };
  // The chat services this copy knows how to talk to, so the Connections card lists them from data
  // rather than from a piece of hand-written page per service. No secret is involved either way.
  if (request.method === "GET" && path === "/api/channels/catalog")
    return { services: channelEntries().map((entry) => ({
      id: entry.id, name: entry.name, docs: entry.docs, needs: entry.needs, note: entry.note,
      can: entry.can, maxTextLength: entry.maxTextLength, canReceive: entry.receive !== null,
    })) };
  const retry = /^\/api\/channels\/deliveries\/([^/]{1,220})\/retry$/.exec(path);
  if (request.method === "POST" && retry) return app.channels.retryDelivery(decodeURIComponent(retry[1]!));
  if (request.method === "POST" && path === "/api/channels/pairings/approve") return app.channels.approve(owner, await readBody(request));
  if (request.method === "POST" && path === "/api/channels/link") return app.channels.link(owner, await readBody(request));
  // Wave mac2 (chat-live): the on / off / when-needed switches for typing, commands, steering and splitting.
  if (request.method === "POST" && path === "/api/channels/live") return { live: app.channels.setSwitches(await readBody(request)) };
  if (request.method === "POST" && path === "/api/channels/test") {
    const { channel, chatId } = z.object({ channel: z.string().min(1).max(64), chatId: z.string().min(1).max(64) }).strict().parse(await readBody(request));
    return app.channels.deliver(channel, chatId, "Test message from Branch Agent: this channel is connected and working.", `test:${Date.now()}`);
  }
  if (request.method === "POST" && path === "/api/channels/pairings/remove") return app.channels.remove(owner, await readBody(request));
  // Batch 20 (wave 8): the address each chat service posts to, with its own unguessable word on the
  // end. Shown on the Connections card with a button that copies it, and rotatable.
  if (request.method === "GET" && path === "/api/channels/addresses") return channelAddresses(app, owner);
  if (request.method === "POST" && path === "/api/channels/addresses/rotate") {
    const { channel } = z.object({ channel: z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/) }).strict().parse(await readBody(request));
    rotateWebhookSecret(app.store, owner, channel);
    return channelAddresses(app, owner);
  }
  if (request.method === "POST" && path === "/api/channels/addresses/settings")
    return { ...channelAddresses(app, owner), settings: saveWebhookAddressSettings(app.store, owner, await readBody(request)) };
  throw new HttpError(404, "Endpoint not found");
}
/** Every connected channel that is posted to, with the whole address to paste into that service. */
function channelAddresses(app: Branch, owner: string): {
  addresses: { channel: string; kind: string; address: string }[];
  settings: ReturnType<typeof webhookAddressSettings>;
} {
  const addresses = app.channels.summary().channels
    .filter((channel) => channel.kind === "whatsapp" || app.channels.adapter(channel.id) instanceof WebhookChatAdapter
      || app.channels.adapter(channel.id) instanceof MetaMessagingAdapter)
    .map((channel) => ({
      channel: channel.id, kind: channel.kind,
      address: webhookAddress(channel.kind === "whatsapp" ? "whatsapp" : "chat", channel.id,
        webhookSecret(app.store, owner, channel.id)),
    }));
  return { addresses, settings: webhookAddressSettings(app.store, owner) };
}
async function chatgptApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const auth = app.chatgpt, owner = app.runtime.owner;
  if (!auth) throw new HttpError(404, "ChatGPT sign-in is not available in this launch");
  if (request.method === "GET" && path === "/api/chatgpt/status") return auth.status();
  if (request.method === "POST" && path === "/api/chatgpt/login") {
    z.object({}).strict().parse(await readBody(request));
    const prompt = await auth.startDeviceLogin();
    void finishChatGPTSignIn(app.runtime.models, auth, owner, app.userAgent).catch(() => undefined);
    return { userCode: prompt.userCode, verificationUrl: prompt.verificationUrl, expiresAt: prompt.expiresAt };
  }
  if (request.method === "POST" && path === "/api/chatgpt/logout") {
    z.object({}).strict().parse(await readBody(request));
    const status = await auth.signOut();
    syncChatGPTPresets(app.runtime.models, auth, false, app.userAgent);
    return status;
  }
  throw new HttpError(404, "Endpoint not found");
}
/** Files a run changed, with the kept version to undo each change. */
function fileChanges(app: Branch, runId: string) {
  return app.store.events(runId).filter((e) => e.kind === "file.changed").slice(0, 10)
    .map((e) => ({ path: e.data.path, versionId: e.data.versionId, existed: e.data.existed, added: e.data.added, removed: e.data.removed, diff: e.data.diff }));
}
/** What one task probably cost: a dollar figure when the model it used has a price on file. */
function runCost(app: Branch, runId: string) {
  const usage = app.store.usage(runId);
  const named = app.store.events(runId).filter((e) => e.kind.startsWith("model.") && e.data.model !== undefined);
  const model = String(named.at(-1)?.data.model ?? "");
  if (!model) return { amount: null, currency: "USD" as const, confidence: "unknown" as const, note: "no price on file", display: "no price on file", model: null };
  const { overrides } = pricingSettings(app.store, app.runtime.owner);
  const estimate = estimateCost(model, {
    input: usage.reportedInput || usage.estimatedInput || 0,
    output: usage.reportedOutput || usage.estimatedOutput || 0,
  }, overrides);
  return { ...estimate, display: formatCost(estimate), model };
}
/**
 * Which of the two modes a conversation is in, and how far it may go before checking back. Reading
 * gives the project's choice, this conversation's own if it has one, and the words for both; writing
 * sets either, or puts the conversation back on whatever the project says.
 */
function planActApi(app: Branch, request: IncomingMessage, body: unknown): unknown {
  const owner = app.runtime.owner, projectId = app.store.projects.active(owner).id;
  const url = new URL(request.url ?? "/", "http://local");
  const asked = request.method === "POST" ? PlanActChoiceSchema.parse(body ?? {}) : null;
  const sessionId = asked?.sessionId ?? url.searchParams.get("sessionId") ?? "";
  const choice = { ...(asked?.planMode ? { planMode: asked.planMode } : {}),
    ...(asked?.autonomy ? { autonomy: asked.autonomy } : {}) };
  if (asked?.followProject && sessionId) clearSessionPlanAct(app.store, owner, sessionId);
  else if (asked && asked.scope === "project") saveProjectPlanAct(app.store, owner, projectId, choice);
  else if (asked && sessionId) saveSessionPlanAct(app.store, owner, sessionId, projectId, choice);
  const effective = sessionPlanAct(app.store, owner, sessionId, projectId);
  return { projectId, project: projectPlanAct(app.store, owner, projectId), effective,
    words: { planMode: planModeWords, autonomy: autonomyWords },
    plan: sessionId ? app.runtime.orchestration.plan(sessionId) ?? null : null };
}
/** Every tool event of a run with its verified outcome: success with a genuine receipt, or why not. */
async function receiptsView(app: Branch, runId: string) {
  const events = app.store.events(runId).filter((e) => e.kind.startsWith("tool."));
  const items = [];
  for (const event of events) {
    const outcome = await classifyToolEvent(app.store.receipts, runId, event.kind, event.data);
    if (outcome) items.push({ eventId: event.id, kind: event.kind, name: event.data.name ?? null, id: event.data.id ?? null, outcome, at: event.createdAt });
  }
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.outcome] = (counts[item.outcome] ?? 0) + 1;
  return { runId, counts, items, usage: app.store.usage(runId), cost: runCost(app, runId) };
}
async function skillsApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner, skills = app.store.skills;
  if (path === "/api/skills/policy") {
    if (request.method === "GET") return { policy: skills.policy(owner) };
    if (request.method === "POST") {
      const value = SkillScanPolicySchema.parse(await readBody(request));
      app.store.save("settings", owner, "skill-scan", value);
      return value;
    }
  }
  if (request.method === "POST" && path === "/api/skills/install")
    return skills.install(owner, await readBody(request, 128 * 1024));
  // Wave 4: packages people share, help with writing a skill, and suggestions from recent tasks.
  if (request.method === "GET" && path === "/api/skills/packages") return { packages: app.skillPackages.list(), problems: app.packageProblems };
  if (request.method === "GET" && path === "/api/skills/suggest") return suggestSkills(app.store, owner);
  if (request.method === "POST" && (path === "/api/skills/package/inspect" || path === "/api/skills/package/install")) {
    const body = PackageInstallSchema.parse(await readBody(request, 2 * 1024 * 1024));
    const bytes = Buffer.from(body.file, "base64");
    return path.endsWith("inspect") ? app.skillPackages.inspect(bytes) : app.skillPackages.install(bytes, body.approve, body.allow);
  }
  // Wave 7: the three browser skills that come with Branch. Listing shows what they are; installing
  // puts one in as an ordinary skill package, switched off until the owner turns it on.
  if (request.method === "GET" && path === "/api/skills/browser") return { skills: browserSkillList() };
  if (request.method === "POST" && path === "/api/skills/browser") {
    const body = (await readBody(request)) as { name?: unknown };
    return app.skillPackages.install(browserSkillPackage(String(body.name ?? "")), true);
  }
  if (request.method === "POST" && path === "/api/skills/draft-from-runs")
    return draftFromRuns(app.store, owner, app.runtime, await readBody(request));
  const match = /^\/api\/skills\/([a-f0-9-]{36})(?:\/(update|activate|disable|remove|read|benchmark|draft|pack|test))?$/.exec(path);
  if (match && request.method === "POST" && match[2] === "pack") return app.skillPackages.pack(match[1]!, await readBody(request));
  if (match && request.method === "POST" && match[2] === "test") return testSkill(app.store, owner, app.runtime, match[1]!, await readBody(request));
  if (match && request.method === "POST" && match[2] === "benchmark") return app.store.governance.benchmark(app.runtime, { ...(await readBody(request) as Record<string, unknown>), skillId: match[1]! });
  if (match && request.method === "POST" && match[2] === "draft") {
    const { runId } = z.object({ runId: z.string().uuid() }).strict().parse(await readBody(request));
    return app.store.governance.proposeFromRun(app.runtime, match[1]!, runId);
  }
  if (match && request.method === "GET" && !match[2]) return skills.view(owner, match[1]!);
  if (match && request.method === "POST" && match[2]) {
    const input = await readBody(request, 128 * 1024), id = match[1]!;
    switch (match[2]) {
      case "update": return skills.update(owner, id, input);
      case "activate": return skills.activate(owner, id, input);
      case "disable": return skills.disable(owner, id, input);
      case "remove": { const removed = skills.remove(owner, id, input); app.skillPackages.forget(id); return removed; }
      case "read": return skills.read(owner, id, input);
    }
  }
  throw new HttpError(404, "Endpoint not found");
}
/** A 20 MB file arrives base64 encoded, which is a third larger again. */
const documentBodyBytes = 28 * 1024 * 1024;
async function documentsApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner, library = app.documents;
  if (path === "/api/documents/settings") {
    if (request.method === "GET") return library.settings(owner);
    if (request.method === "POST") return library.configure(owner, await readBody(request));
  }
  if (request.method === "GET" && path === "/api/documents") return library.view(owner);
  if (request.method === "POST" && path === "/api/documents")
    return library.add(owner, await readBody(request, documentBodyBytes));
  if (request.method === "POST" && path === "/api/documents/search")
    return { results: await library.search(owner, await readBody(request)) };
  if (request.method === "POST" && path === "/api/documents/reindex") {
    const { id } = z.object({ id: z.string().min(1).max(100) }).strict().parse(await readBody(request));
    return library.reindex(owner, id);
  }
  const one = /^\/api\/documents\/([a-f0-9-]{36})$/.exec(path);
  if (one && request.method === "DELETE") return library.remove(owner, one[1]!);
  throw new HttpError(404, "Endpoint not found");
}
/**
 * The reports the assistant has written, the watches that are running, and the morning brief.
 * These are the routes only; no screen in the app calls them yet.
 */
async function researchApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  if (request.method === "GET" && path === "/api/research") return { reports: app.research.list(owner) };
  if (request.method === "GET" && path === "/api/monitors") return { monitors: app.monitors.list(owner) };
  if (request.method === "POST" && path === "/api/monitors") return app.monitors.create(owner, await readBody(request));
  const watch = /^\/api\/monitors\/([a-f0-9-]{36})(?:\/(check))?$/.exec(path);
  if (watch && request.method === "DELETE" && !watch[2]) return app.monitors.remove(owner, watch[1]!);
  if (watch && request.method === "POST" && watch[2] === "check") return app.monitors.check(owner, watch[1]!);
  if (request.method === "GET" && path === "/api/brief") return app.brief.preview(owner);
  if (request.method === "POST" && path === "/api/brief") return app.brief.configure(owner, await readBody(request));
  if (request.method === "POST" && path === "/api/brief/send") return app.brief.send(owner);
  throw new HttpError(404, "Endpoint not found");
}
async function mcpApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const extra = await mcpModeApi(app, request, path);
  if (extra !== undefined) return extra;
  if (path === "/api/mcp/settings") {
    const mcp = app.mcpServer;
    if (!mcp) throw new HttpError(500, "Sharing is not available");
    if (request.method === "GET")
      return { ...mcp.sharing(), ...readServingSettings(app.store, app.runtime.owner), tools: shareableTools(app.registry) };
    if (request.method === "POST") {
      const body = await readBody(request);
      // How long a quiet connection is kept and how long a call waits for the owner's yes are
      // saved separately, so a screen that does not know about them cannot reset them by saving.
      const { idleMinutes, askWaitSeconds, ...rest } = (body as Record<string, unknown> | null) ?? {};
      const serving = saveServingSettings(app.store, app.runtime.owner,
        { ...(idleMinutes === undefined ? {} : { idleMinutes }), ...(askWaitSeconds === undefined ? {} : { askWaitSeconds }) });
      const sharing = McpSharingSchema.parse(rest);
      const known = new Set(app.registry.names());
      const exposedTools = sharing.exposedTools.filter((name) => known.has(name));
      // A screen that does not know about answering other assistants must not switch it off by saving.
      const said = (body as Record<string, unknown> | null)?.a2a;
      const a2a = typeof said === "boolean" ? said : mcp.sharing().a2a;
      app.store.save("settings", app.runtime.owner, "mcp-sharing", { enabled: sharing.enabled, exposedTools, a2a });
      return { ...mcp.sharing(), ...serving, tools: shareableTools(app.registry) };
    }
  }
  throw new HttpError(404, "Endpoint not found");
}
/**
 * Wave 7. What this connection is being offered and what is held back, the records of tool lists
 * other tools were shown, how the connections to outside servers are set up and faring, and the
 * "try a server" bench. `undefined` means this path is not one of these.
 */
async function mcpModeApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const mcp = app.mcpServer;
  if (path === "/api/mcp/preflight" && request.method === "GET" && mcp) {
    const result = mcp.preflight();
    return { ...result, explanation: hiddenToolsText(result), tools: mcp.listTools().map((tool) => tool.name) };
  }
  if (path === "/api/mcp/snapshots" && request.method === "GET")
    return { snapshots: listSnapshots(app.store, app.runtime.owner).map((s) => ({ ...s, tools: s.tools.length })) };
  if (path === "/api/mcp/connections") {
    const scope = app.store.profiles.scope();
    if (request.method === "GET")
      return { settings: readLifecycleSettings(app.store, scope), servers: app.mcpConnections.health(), known: app.mcpConnections.known() };
    if (request.method === "POST")
      return { settings: saveLifecycleSettings(app.store, scope, await readBody(request)), servers: app.mcpConnections.health() };
  }
  if (path === "/api/mcp/signin" && request.method === "POST") {
    app.store.profiles.requireOwner("Signing in to another AI tool's server");
    // The address to open in the owner's own browser; the key lands in the locker, never here.
    const started = await mcpSignIn(await readBody(request), {
      store: app.store, owner: app.runtime.owner, connections: app.oauth, policy: app.web.policy,
    });
    return { url: started.url, redirectUri: started.redirectUri, expiresInMs: started.expiresInMs };
  }
  if (path === "/api/mcp/try" && request.method === "POST") {
    // Trying a server starts a program on this computer, or reaches out to a web address, so it
    // stays with the owner even where several people share the app.
    app.store.profiles.requireOwner("Trying another AI tool's server");
    return tryServer(app.store, app.runtime.owner, await readBody(request, 65536), process.env, app.web.policy);
  }
  // The pages outside servers offered during one conversation, newest first. The page itself
  // travels with the answer so the card can hand it straight back for a one-time address; it is
  // never put in a frame here, only listed.
  if (path === "/api/mcp/apps" && request.method === "GET") {
    const sessionId = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("session") ?? "";
    const scope = app.store.profiles.scope();
    const apps: { server: string; uri: string; html: string; runId: string }[] = [];
    for (const run of app.store.runs(scope).slice(0, 12)) {
      if (sessionId && run.sessionId !== sessionId) continue;
      for (const event of app.store.events(run.id))
        if (event.kind === "mcp.app")
          apps.push({ server: String(event.data.server ?? "a server"), uri: String(event.data.uri ?? ""),
            html: String(event.data.html ?? ""), runId: run.id });
      if (apps.length >= 5) break;
    }
    return { apps: apps.slice(0, 5) };
  }
  if (path === "/api/mcp/app" && request.method === "POST") {
    const resource = AppResourceSchema.parse(await readBody(request, 512_000));
    return { url: `/mcp-app/${holdApp(resource)}` };
  }
  return undefined;
}
/**
 * A small page an outside server sent, shown in its own frame. It is served without the session
 * key because a frame cannot carry one; instead the address is a one-time unguessable name that
 * stops working after five minutes, and the page is locked down so hard by its content rules that
 * it can neither run a script nor reach anything at all.
 */
const heldApps = new Map<string, { resource: AppResource; until: number }>();
function holdApp(resource: AppResource): string {
  for (const [id, held] of heldApps) if (held.until < Date.now()) heldApps.delete(id);
  // At the limit the oldest waiting page goes, rather than every page anyone is still looking at.
  while (heldApps.size > 20) heldApps.delete(heldApps.keys().next().value!);
  const id = randomBytes(24).toString("base64url");
  heldApps.set(id, { resource, until: Date.now() + 300_000 });
  return id;
}
export function mcpAppPage(request: IncomingMessage, response: ServerResponse, path: string): boolean {
  const match = /^\/mcp-app\/([A-Za-z0-9_-]{32,48})$/.exec(path);
  if (!match || request.method !== "GET") return false;
  const held = heldApps.get(match[1]!);
  // The name is good for one fetch. It is handed over without the session key, so it stops working
  // the moment it has been used, as well as after five minutes.
  heldApps.delete(match[1]!);
  if (!held || held.until < Date.now()) {
    send(response, 404, { error: "That page has expired. Open it again from Settings." });
    return true;
  }
  const page = appPage(held.resource);
  response.writeHead(200, { ...appHeaders(), "x-mcp-app-removed": String(page.removed) });
  response.end(page.body);
  return true;
}
async function handleMcpRequest(
  app: Branch,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path !== "/mcp") return false;
  if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) return false;

  try {
    const owner = app.runtime.owner;
    const mcp = app.mcpServer;
    if (!mcp) throw new HttpError(500, "MCP server not initialized");

    const sessionId = request.headers["mcp-session-id"] as string | undefined;

    if (request.method === "DELETE") {
      if (sessionId) {
        mcp.deleteSession(sessionId);
      }
      response.writeHead(204);
      response.end();
      return true;
    }

    // A name Branch never handed out is not a conversation. Only the very first message may bring
    // one of its own; after that a made-up name is refused, rather than quietly opening a second
    // conversation or letting anything read a stream it was never given.
    const unknownSession = sessionId !== undefined && !mcp.hasSession(sessionId);

    if (request.method === "GET") {
      // The spec's streaming half: a client that says it wants an event stream gets one, and
      // messages Branch starts itself — "the tools have changed", "that task has finished" — come
      // down it. A plain GET is still refused, because a plain GET cannot carry them.
      if (!/text\/event-stream/i.test(String(request.headers.accept ?? "")))
        throw new HttpError(405, "Use POST for JSON-RPC requests, or ask for text/event-stream to open a stream");
      if (unknownSession) throw new HttpError(404, "That conversation is not open. Send initialize first.");
      openEventStream(mcp, request, response, sessionId);
      return true;
    }

    const body = request.method === "POST" ? await readBody(request, 65536) : undefined;

    if (request.method === "POST" && body) {
      const JsonRpcSchema = z
        .object({
          jsonrpc: z.literal("2.0"),
          id: z.union([z.string(), z.number()]),
          method: z.string(),
          params: z.record(z.string(), z.unknown()).optional().default({}),
        })
        .strict();
      const jsonRpcRequest = JsonRpcSchema.parse(body) as { jsonrpc: "2.0"; id: string | number; method: string; params?: Record<string, unknown> };
      if (unknownSession && jsonRpcRequest.method !== "initialize")
        throw new HttpError(404, "That conversation is not open. Send initialize first.");
      // A client that did not bring a conversation of its own is given one, named in the reply to
      // its first message, so everything it does afterwards is kept together.
      const opened = !sessionId && jsonRpcRequest.method === "initialize" ? mcp.getSession().id : undefined;
      const session = mcp.getSession(sessionId ?? opened);
      const result = await mcp.handle(jsonRpcRequest, session.id);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "mcp-protocol-version": session.protocolVersion,
        ...(opened ? { "mcp-session-id": opened } : {}),
      });
      response.end(JSON.stringify(result));
      return true;
    }

    throw new HttpError(405, "Only POST is supported for MCP");
  } catch (e) {
    if (!response.headersSent) {
      const status = e instanceof HttpError ? e.status : 400;
      send(response, status, { error: errorText(e) });
    } else {
      response.end();
    }
    return true;
  }
}
/**
 * The stream half of the modern MCP transport. The connection stays open and Branch writes down it
 * whenever something changes on this side; a colon line every half minute keeps it from being
 * closed by something in the middle for going quiet.
 */
function openEventStream(
  mcp: McpServer, request: IncomingMessage, response: ServerResponse, sessionId?: string,
): void {
  const session = mcp.getSession(sessionId);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "mcp-session-id": session.id,
    "mcp-protocol-version": session.protocolVersion,
  });
  response.write(": connected\n\n");
  const stop = mcp.openStream(session.id, (notification) => {
    response.write(`event: message\ndata: ${JSON.stringify(notification)}\n\n`);
  });
  const beat = setInterval(() => response.write(": keep-alive\n\n"), 30000);
  beat.unref?.();
  const end = () => { clearInterval(beat); stop(); response.end(); };
  request.on("close", end);
  request.on("error", end);
}
/**
 * How another AI tool starts Branch as a child program on this machine. The child is given this
 * install's data and workspace paths, because it inherits the other tool's working directory.
 */
function stdioCommand(dataDir: string, workspace: string): {
  command: string; args: string[]; env: Record<string, string>; packaged: boolean;
} {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const packaged = Boolean(process.versions.electron) && !(process as { defaultApp?: boolean }).defaultApp;
  const env = { BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: workspace };
  return packaged
    ? { command: process.execPath, args: [cli, "mcp-serve"], env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, packaged }
    : { command: "branch", args: ["mcp-serve"], env, packaged };
}
/** Ready-to-paste settings for the other AI tool, using this server's own address and key. */
function mcpConnectionSnippets(app: Branch, request: IncomingMessage, dataDir: string): unknown {
  const url = `http://${request.headers.host ?? "127.0.0.1:3210"}`;
  const token = /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ""))?.[1] ?? "YOUR_SESSION_KEY";
  const stdio = stdioCommand(dataDir, app.runtime.workspace);
  const stdioConfig = JSON.stringify({ mcpServers: { branch: {
    command: stdio.command, args: stdio.args, env: stdio.env,
  } } }, null, 2);
  const httpConfig = JSON.stringify({ mcpServers: { branch: {
    type: "http", url: `${url}/mcp`, headers: { Authorization: `Bearer ${token}` },
  } } }, null, 2);
  return {
    httpEndpoint: `${url}/mcp`,
    bearerToken: token,
    stdio: { ...stdio, configExample: stdioConfig },
    claudeDesktop: {
      configExample: stdioConfig,
      note: "Paste this into Claude Desktop's settings file, then restart it. On Windows the file is %APPDATA%/Claude/claude_desktop_config.json; on macOS and Linux it is ~/.config/Claude/claude_desktop_config.json. Claude Desktop starts its own copy of Branch, so close this app first — two copies cannot share the same records.",
    },
    claudeCode: {
      configExample: `claude mcp add --transport http branch ${url}/mcp --header "Authorization: Bearer ${token}"`,
      note: "Run this once in a terminal. Claude Code then talks to Branch while Branch is open.",
    },
    cursor: {
      configExample: httpConfig,
      note: "Paste this into Cursor's MCP settings. It talks to Branch over this computer's own address, so Branch has to be open.",
    },
  };
}
/** The pairing door, open only on the phone's listener and only for the invitation on offer. */
export async function pairingRequest(
  remote: RemoteAccess, request: IncomingMessage, response: ServerResponse, path: string,
  /** Batch 20 (wave 8): writes the phone down and hands it a secret of its own, when asked to. */
  gateway?: GatewayAuth,
): Promise<boolean> {
  if (request.method !== "POST" || path !== "/api/pair") return false;
  const body = z.object({ id: z.string().max(64), code: z.string().max(16), name: z.string().trim().max(80).default("A phone") })
    .strict().parse(await readBody(request, 1024));
  const redeemed = remote.pairing.redeem(body.id, body.code);
  // The phone is remembered the moment it is let in, so the "this exact phone" step of the chain
  // has something to check against from the very next request.
  const device = gateway?.remember(body.name);
  send(response, 200, device ? { ...redeemed, deviceId: device.device.id, deviceKey: device.secret } : redeemed);
  return true;
}
export async function startServer(
  app: Branch,
  options: {
    dataDir: string; port?: number;
    /** The installed program file and folder, when Branch runs from an install rather than source. */
    executable?: string | null; installRoot?: string | null;
    /** Announce this engine to other launches, so a second window joins it instead of starting again. */
    presence?: "app" | "daemon";
    /** How many wrong keys a place may try before it waits; the defaults suit a real install. */
    authLimits?: { attempts?: number; lockoutMs?: number; windowMs?: number };
  },
) {
  const token = await sessionToken(options.dataDir);
  let url = "";
  // The same count the waiting line uses, so the two together never run more than this computer is
  // meant to handle.
  const executions = app.executions;
  const remote = new RemoteAccess(token);
  // Batch 20 (wave 8): what a phone must satisfy on the extra door, as a chain of named steps.
  const gateway = new GatewayAuth(app.store, app.runtime.owner);
  // Wrong keys, PINs and pairing codes are counted per place they came from; five in a row and that
  // place is made to wait, with a line written into the record of what the assistant was allowed to do.
  const authLimiter = new AuthLimiter(options.authLimits);
  // Counted separately from the session key, so a chat service that is set up wrongly can slow
  // itself down without ever standing between the owner and their own app.
  const webhookLimiter = new AuthLimiter(options.authLimits);

/**
 * The widget sits on a page of the owner's own, so its call to the paired listener is cross-origin
 * and the browser asks permission before sending it. Permission is given only to a website the owner
 * listed, named exactly rather than with a star, and only while the widget switch is on. Without
 * this the browser never sends the call at all, so the box on the owner's page could not ask
 * anything; with a star, any page that had got hold of the pairing key could.
 */
function widgetCors(app: Branch, request: IncomingMessage, response: ServerResponse): boolean {
  const allowed = widgetOrigin(embedSettings(app.store, app.runtime.owner), request.headers.origin);
  if (!allowed) return false;
  response.setHeader("access-control-allow-origin", allowed);
  response.setHeader("vary", "Origin");
  if ((request.method ?? "GET") !== "OPTIONS") return false;
  response.setHeader("access-control-allow-methods", "POST, GET");
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-max-age", "600");
  response.writeHead(204).end();
  return true;
}
  const handle = async (request: IncomingMessage, response: ServerResponse, viaRemote: boolean): Promise<void> => {
    try {
      const path = new URL(request.url ?? "/", url || "http://127.0.0.1")
        .pathname;
      if (!hostAllowed(request.headers.host, undefined, url, remote.allowedHosts()))
        throw new HttpError(403, "Host rejected");
      if (viaRemote && widgetCors(app, request, response)) return;
      if (viaRemote && (await pairingRequest(remote, request, response, path, gateway))) return;
      // The widget's own script is not served while the switch is off, so turning it off takes the
      // box off the owner's page rather than only hiding the setting.
      if (path === "/widget.js" && !embedSettings(app.store, app.runtime.owner).widget)
        throw new HttpError(404, "Not found");
      // Wave mac3: while the dashboard switch is off its page and files are not served at all.
      if (isDashboardFile(path) && dashboardSettings(app.store, app.runtime.owner).mode === "off")
        throw new HttpError(404, "Not found");
      if (request.method === "GET" && (await staticFile(path, response)))
        return;
      if (path.startsWith("/hooks/")) {
        send(response, 200, await hook(app, request, path));
        return;
      }
      if (await whatsAppWebhook(app, request, response, path)) return;
      if (await chatWebhook(app, request, response, path, webhookLimiter)) return;
      // Wave 6: a read-only shared conversation carries its own code instead of the session key.
      if (await sharePage(app, request, response, path)) return;
      // Wave 7: a page an outside AI-tool server sent, shown in a frame that can do nothing at all.
      // A frame cannot carry the session key, so the address itself is the one-time secret.
      if (mcpAppPage(request, response, path)) return;
      // Wave 8: an artifact out of a reply, in that same frame. Its address is not used up by the
      // first fetch, so the frame may reload and "open larger" may show the same one again.
      if (artifactPageRoute(request, response, path)) return;
      const triggerFireMatch = /^\/api\/triggers\/([a-f0-9-]{36})\/fire$/.exec(path);
      if (triggerFireMatch && request.method === "POST") {
        send(response, 200, await triggerFire(app, request, triggerFireMatch[1]!));
        return;
      }
      authorize(request, url, token, remote.allowedHosts(), {
        limiter: authLimiter,
        onFailure: (from) => noteAuthFailure(authLimiter, app.store, app.runtime.owner, from, "the local key"),
      }, (supplied) => offLimitsToShortLivedKeys(request.method, path)
        ?? app.sessionTokens.check(app.runtime.owner, supplied, {
          method: request.method ?? "GET", executes: isExecution(request, path),
        }));
      // The extra door has its own chain on top of the key: see src/remote/gateway-auth.ts. The
      // window on this computer never goes through it.
      if (viaRemote) {
        const refused = gateway.check(request, true);
        if (refused) throw new HttpError(401, refused);
      }
      // Doing something counts as activity; merely looking does not, or the app's own three-second
      // refresh of the screen would keep it awake for ever and it would never lock itself.
      if (request.method !== "GET" && path !== "/api/lock") app.sessionLock.touch();
      if (await handleMcpRequest(app, request, response)) return;
      // ---- Wave mac3: the owner's dashboard (src/dashboard-api.ts). What this key may do is worked
      // out once here, so the page can show a read-only view to a key that may only look. ----
      if (handlesDashboardPath(path)) {
        // The key was already checked and its use counted above; this only reads what it may do.
        const access = dashboardAccess(request, token, (supplied) => app.sessionTokens.scopeOf(app.runtime.owner, supplied));
        const answer = await dashboardApi(app, request, path, {
          dataDir: options.dataDir, access, readBody: () => readBody(request),
        }).catch((error: unknown) => {
          throw error instanceof DashboardApiError ? new HttpError(error.status, error.message) : error;
        });
        send(response, 200, answer);
        return;
      }
      // ---- end of the dashboard block ----
      const executes = isExecution(request, path);
      const place = executes ? executions.take() : null;
      if (executes && !place)
        throw new HttpError(429, "Too many active executions");
      try {
        if (await rawApi(app, request, response, path)) return;
        if (path.startsWith("/api/deployment")) {
          const result = await deploymentApi(app, request, path, deployment(), (r) => readBody(r), remoteHandler);
          if (result !== undefined) { send(response, 200, result); return; }
        }
        send(response, 200, await api(app, request, path, options.dataDir));
      } finally {
        place?.();
      }
    } catch (e) {
      if (!response.headersSent)
        send(response, e instanceof HttpError ? e.status : 400, {
          // A saved password or key can never travel back out in a failure message.
          error: app.runtime.hideSecrets(errorText(e)),
        });
      else response.end();
    }
  };
  const server = createServer((request, response) => void handle(request, response, false));
  const remoteHandler = (request: IncomingMessage, response: ServerResponse) =>
    void handle(request, response, true);
  const deployment = (): DeploymentContext => ({
    dataDir: options.dataDir, workspace: app.runtime.workspace, port: new URL(url).port ? Number(new URL(url).port) : 0,
    executable: options.executable ?? null, installRoot: options.installRoot ?? null, remote,
  });
  server.on("upgrade", (request, socket) => {
    void (async () => {
      const path = new URL(request.url ?? "/", url || "http://127.0.0.1").pathname;
      const match = /^\/api\/runs\/([a-f0-9-]{36})\/ws$/.exec(path);
      const run = match && app.store.run(match[1]!);
      const sameHost = hostAllowed(request.headers.host, request.headers.origin, url, remote.allowedHosts());
      if (!match || !run || run.owner !== app.store.profiles.scope() || !sameHost || !tokenFromProtocol(request, token)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      // Wave 8: the same socket also carries a live voice conversation, when the browser asks for
      // one. Nothing is opened until it does, so an ordinary task is unchanged.
      await serveRunSocket(app.store, run.id, request, socket, liveHooks(app.live, run.id, run.sessionId));
    })().catch(() => socket.destroy());
  });
  configureLimits(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 3210, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Failed to bind loopback server");
  url = `http://127.0.0.1:${address.port}`;
  app.scheduler.start();
  if (options.presence) {
    await writeRunning(options.dataDir, { port: address.port, pid: process.pid, url, mode: options.presence, version: app.version }).catch(() => undefined);
    await noteFirstStart(app, options.dataDir).catch(() => undefined);
  }
  return {
    url,
    token,
    remote,
    /**
     * The same handler the paired listener is given. It is exposed so the behaviour that only
     * happens on that door — the question a browser asks before letting a page of the owner's own
     * send anything — can be tested without a Tailscale address and a real network.
     */
    remoteHandler,
    close: async () => {
      await remote.disable().catch(() => undefined);
      if (options.presence) await clearRunning(options.dataDir).catch(() => undefined);
      await stopServer(app, server);
    },
  };
}
/** Records whether a version that has just replaced another one came up healthy the first time. */
async function noteFirstStart(app: Branch, dataDir: string): Promise<void> {
  if ((await readFirstStart(dataDir))?.version === app.version) return;
  await recordFirstStart(dataDir, app.version, (await healthReport(app)).ok);
}
/** Endpoints that write the response themselves (streams and the OpenAI-style chat). */
async function rawApi(app: Branch, request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  // Batch 19 (wave 7): the counters, as the plain text a monitoring tool reads rather than JSON.
  if (request.method === "GET" && path === "/api/metrics") { metricsResponse(app, response); return true; }
  // Batch 20 (wave 8): what every task wrote down, as one JSON object per line, for a log shipper.
  if (request.method === "GET" && path === "/api/logs") { logsResponse(app, request, response); return true; }
  // Talking to other assistants: the card and the task endpoint, which streams when asked to.
  if (path === "/a2a" || path === "/.well-known/agent.json")
    if (await handleA2a(app.a2a, request, response, path, () => readBody(request, 131072))) return true;
  // Wave 7: everything happening on this computer, filtered by kind, as one live stream.
  if (request.method === "GET" && path === "/api/events/stream") {
    const query = new URL(request.url ?? "/", "http://local").searchParams;
    const kinds = (query.get("kind") ?? "").split(",").map((kind) => kind.trim()).filter(Boolean).slice(0, 20);
    // "after=0" means "everything you have"; leaving it out means "only what happens from now on",
    // so zero has to be told apart from absent rather than treated as nothing.
    const asked = query.get("after");
    const after = asked === null || !/^\d+$/.test(asked) ? undefined : Number(asked);
    await streamOwnerEvents(app.store, app.store.profiles.scope(), response, {
      ...(after === undefined ? {} : { after }), kinds,
      // The stream carries tool arguments and results, so nothing goes out of it carrying a saved
      // password or key; how long it may run and how much it may send are both capped inside.
      scrub: app.runtime.hideSecrets,
      ...(Number(query.get("maxMs")) ? { maxMs: Number(query.get("maxMs")) } : {}),
    });
    return true;
  }
  const stream = /^\/api\/runs\/([a-f0-9-]{36})\/stream$/.exec(path);
  if (stream && request.method === "GET") {
    const run = app.store.run(stream[1]!);
    if (!run || run.owner !== app.store.profiles.scope()) throw new HttpError(404, "Run not found");
    const after = Number(new URL(request.url ?? "/", "http://local").searchParams.get("after") ?? 0) || 0;
    await streamRunEvents(app.store, run.id, response, after);
    return true;
  }
  // One kept picture or sound, so the gallery can show it. Anything outside the artifacts folder
  // is refused by RunArtifacts itself, and only kinds the browser can safely display are served.
  if (request.method === "GET" && path === "/api/artifacts/file") {
    const wanted = new URL(request.url ?? "/", "http://local").searchParams.get("path") ?? "";
    const entry = (await app.artifacts.list(500)).find((kept) => kept.path === wanted);
    if (!entry) throw new HttpError(404, "That file was not made by the assistant");
    if (!/^(image|audio)\//.test(entry.mediaType)) throw new HttpError(415, "Only pictures and sounds are shown here");
    const bytes = await app.artifacts.read(entry.path);
    response.writeHead(200, {
      "content-type": entry.mediaType, "cache-control": "no-store",
      "x-content-type-options": "nosniff", "content-disposition": `inline; filename="${entry.name}"`,
      "content-security-policy": "default-src 'none'; sandbox",
    });
    response.end(bytes);
    return true;
  }
  if (request.method === "POST" && path === "/api/voice/transcribe") {
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.includes("audio/") && !contentType.includes("application/octet-stream")) {
      throw new HttpError(415, "Use audio/* content-type");
    }
    const maxBytes = 25 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) throw new HttpError(413, "Audio exceeds 25 MiB");
      chunks.push(Buffer.from(chunk));
    }
    const audio = new Uint8Array(Buffer.concat(chunks));
    try {
      // One service decides which route writes this out, and refuses outright when the owner has
      // said audio must stay on this computer. The length comes from the recorder, for the cost.
      const seconds = Number(new URL(request.url ?? "/", "http://local").searchParams.get("seconds"));
      const written = await app.voice.transcribe(app.runtime.owner, {
        bytes: audio, mediaType: (contentType.split(";")[0] ?? "audio/webm").trim(), name: "recording",
        ...(Number.isFinite(seconds) && seconds > 0 ? { seconds } : {}),
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ text: written.text, via: written.route, language: written.language, cost: written.cost }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new HttpError(400, msg);
    }
    return true;
  }
  if (request.method === "POST" && path === "/api/voice/speak") {
    const body = z.object({
      text: z.string().max(4000), voice: z.string().max(80).optional(), speed: z.number().min(0.5).max(2).optional(),
    }).strict().parse(await readBody(request));
    try {
      const spoken = await app.voice.speak(app.runtime.owner, {
        text: body.text, voice: body.voice ?? "", speed: body.speed ?? 1,
      });
      response.writeHead(200, {
        "content-type": spoken.mediaType, "cache-control": "no-store",
        "x-voice-route": spoken.route, "x-voice-name": encodeURIComponent(spoken.voice),
      });
      response.end(Buffer.from(spoken.bytes));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new HttpError(400, msg);
    }
    return true;
  }
  if (request.method === "GET" && path === "/api/memory/export"
      && new URL(request.url ?? "/", "http://local").searchParams.get("format") === "jsonl") {
    const jsonl = app.memory.transfer.export(app.runtime.owner);
    response.writeHead(200, {
      "content-type": "application/jsonl; charset=utf-8",
      "content-disposition": 'attachment; filename="memory.jsonl"',
      "cache-control": "no-store",
    });
    response.end(jsonl);
    return true;
  }
  // Wave 6: one conversation as a single page, with keys blanked out, ready to keep or send on.
  const htmlExport = /^\/api\/sessions\/([a-f0-9-]{36})\/export$/.exec(path);
  if (htmlExport && request.method === "GET"
      && new URL(request.url ?? "/", "http://local").searchParams.get("format") === "html") {
    const sessionId = htmlExport[1]!, query = new URL(request.url ?? "/", "http://local").searchParams;
    if (!app.store.ownsSession(app.store.profiles.scope(), sessionId)) throw new HttpError(404, "Conversation not found");
    const redact = RedactionSchema.parse({ secrets: query.get("secrets") !== "0",
      contactDetails: query.get("contactDetails") === "1", toolResults: query.get("toolResults") === "0" });
    const view = app.store.sessionView(app.store.profiles.scope(), sessionId) as { createdAt?: string; title?: string };
    const page = shareHtml({ sessionId, ...(view.createdAt ? { createdAt: view.createdAt } : {}),
      ...(view.title ? { title: view.title } : {}) }, app.store.messages(sessionId), redact);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="conversation-${sessionId.slice(0, 8)}.html"`,
      "cache-control": "no-store", "x-content-type-options": "nosniff",
      "x-branch-share-receipt": JSON.stringify(page.receipt),
    });
    response.end(page.html);
    return true;
  }
  const sessionExport = /^\/api\/sessions\/([a-f0-9-]{36})\/export$/.exec(path);
  if (sessionExport && request.method === "GET"
      && new URL(request.url ?? "/", "http://local").searchParams.get("format") === "markdown") {
    const sessionId = sessionExport[1]!;
    if (!app.store.ownsSession(app.runtime.owner, sessionId)) throw new HttpError(404, "Conversation not found");
    const view = app.store.sessionView(app.runtime.owner, sessionId) as { createdAt?: string; title?: string };
    const markdown = conversationMarkdown({ sessionId, ...(view.createdAt ? { createdAt: view.createdAt } : {}), ...(view.title ? { title: view.title } : {}) },
      app.store.messages(sessionId));
    response.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="conversation-${sessionId.slice(0, 8)}.md"`,
      "cache-control": "no-store",
    });
    response.end(markdown);
    return true;
  }
  if (request.method === "GET" && path === "/api/usage/export.csv") {
    const url = new URL(request.url ?? "/", "http://local");
    const range = (url.searchParams.get("range") ?? "30d") as "7d" | "30d" | "90d" | "all";
    const { overrides } = pricingSettings(app.store, app.runtime.owner);
    const data = app.store.usageStore().aggregateUsage(range, "day", overrides);
    // estimatedCostUsd covers only the tasks with a price; runsWithoutPrice says how many had none.
    // Wave 7: the money columns a spreadsheet needs — what the day cost, what one task cost on
    // average, and the model that cost the most — with an empty cell wherever nobody knows.
    const csv = ["date,runs,toolCalls,tokensInput,tokensOutput,estimatedCostUsd,costPerRunUsd,dearestModel,dearestModelCostUsd,runsWithPrice,runsWithoutPrice,failures"]
      .concat(
        data.map((d) => {
          const dearest = [...d.presets].filter((p) => p.cost !== null).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))[0];
          return [d.date, d.runs, d.toolCalls, d.tokens.input, d.tokens.output,
            d.pricedRuns ? d.estimatedCost.toFixed(4) : "",
            d.pricedRuns ? (d.estimatedCost / d.pricedRuns).toFixed(6) : "",
            csvCell(dearest?.id ?? ""), dearest ? (dearest.cost ?? 0).toFixed(4) : "",
            d.pricedRuns, d.unpricedRuns, d.failures].join(",");
        })
      )
      .join("\n");
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="usage-${range}.csv"`,
      "cache-control": "no-store",
    });
    response.end(csv);
    return true;
  }
  if (request.method === "GET" && path === "/api/audit/export.csv") {
    auditCsvResponse(app, request, response);
    return true;
  }
  // Wave 7: many tasks as JSON Lines, one trajectory per line, for feeding an evaluation run.
  if (request.method === "GET" && path === "/api/runs/trajectories.jsonl") {
    await trajectoriesResponse(app, request, response);
    return true;
  }
  if (request.method === "POST" && path === "/v1/chat/completions") {
    await chatCompletion(app, request, response, await readBody(request, 1024 * 1024));
    return true;
  }
  return false;
}
/**
 * Saved browser sign-ins. "Sign in once" opens a real browser window the person can see and use;
 * only the cookies that keep them signed in are kept, and the assistant is not part of any of it.
 */
async function browserApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  if (request.method === "GET" && path === "/api/browser/profiles")
    return { profiles: await app.browserProfiles.list(owner), canSignIn: !!app.browser };
  // Wave 7: "Let Branch use my browser for this task". Off unless the owner turns it on, tied to
  // one task, and it runs out on its own after a quarter of an hour.
  if (request.method === "GET" && path === "/api/browser/attach")
    return { settings: readAttachSettings(app.store, owner), refusedSites: refusedHosts.length };
  if (request.method === "POST" && path === "/api/browser/attach")
    return { settings: saveAttachSettings(app.store, owner, await readBody(request)) };
  const body = (await readBody(request)) as { name?: unknown; url?: unknown };
  const name = String(body.name ?? "");
  if (request.method === "POST" && path === "/api/browser/profiles")
    return { profile: await app.browserProfiles.create(owner, name) };
  if (request.method === "POST" && path === "/api/browser/profiles/remove")
    return { removed: await app.browserProfiles.remove(owner, name) };
  if (request.method === "POST" && path === "/api/browser/signin") {
    if (!app.browser) throw new HttpError(400, "The browser is not switched on in this launch's integration settings");
    return { signedIn: await app.browser.signIn(owner, name, String(body.url ?? ""), 240000) };
  }
  throw new HttpError(404, "Not found");
}
/**
 * Wave 6: a shared conversation page. It needs the code the owner was shown, works once, and stops
 * at its expiry. It is served by this app on this computer, so it needs no session key of its own;
 * nothing is published anywhere.
 */
async function sharePage(app: Branch, request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  const match = /^\/share\/([a-f0-9-]{36})$/.exec(path);
  if (!match) return false;
  if (request.method !== "GET") throw new HttpError(404, "Endpoint not found");
  const code = new URL(request.url ?? "/", "http://local").searchParams.get("code") ?? "";
  let body: string, status = 200;
  try { body = app.store.shares.open(match[1]!, code); }
  catch (error) {
    status = 403;
    body = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Not available</title></head>`
      + `<body style="font:16px system-ui;margin:3rem auto;max-width:32rem"><h1>This link is not available</h1>`
      + `<p>${errorText(error).replace(/[<>&"]/g, "")}</p></body></html>`;
  }
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  response.end(body);
  return true;
}
/** Everything the voice and model-routing screens need, gathered in one place (wave 7). */
/**
 * Every task in the range as JSON Lines, written one line at a time so a thousand of them never
 * become one enormous string first. Only this person's own tasks are in it.
 */
async function trajectoriesResponse(app: Branch, request: IncomingMessage, response: ServerResponse): Promise<void> {
  // Every task at once, messages and tool arguments included, is the owner's own record: a second
  // person's profile may not have it, not even the part of it that belongs to them.
  app.store.profiles.requireOwner("Saved records of your tasks");
  const query = new URL(request.url ?? "/", "http://local").searchParams;
  const limit = Math.min(Math.max(Number(query.get("limit") ?? 50) || 50, 1), 500);
  const runs = app.store.runs(app.runtime.owner).slice(0, limit);
  const options = new Map<string, Awaited<ReturnType<typeof trajectoryOptions>>>();
  for (const run of runs) options.set(run.id, await trajectoryOptions(app, run.id));
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "content-disposition": `attachment; filename="branch-trajectories.jsonl"`,
    "cache-control": "no-store",
  });
  for (const line of trajectoryLines(app.store, runs.map((run) => run.id), (id) => options.get(id)!,
    app.runtime.hideSecrets))
    response.write(line + "\n");
  response.end();
}
/**
 * Everything "Look inside" and a trajectory both need about one task: its receipts, its timeline,
 * and the workspace's own price table so each model round is costed the way the Usage screen does.
 */
export async function trajectoryOptions(app: Branch, runId: string) {
  const receipts = await receiptsView(app, runId);
  const { overrides } = pricingSettings(app.store, app.runtime.owner);
  return {
    receipts, version: app.version, cost: receipts.cost,
    timeline: app.store.usageStore().getRunTimeline(runId),
    price: (model: string, tokens: { input: number; output: number }) => {
      const estimate = estimateCost(model, tokens, overrides);
      return { amount: estimate.amount, display: formatCost(estimate) };
    },
  };
}
/** What the metering export needs: the ledger, the workspace it may write into, and the prices. */
function meteringDeps(app: Branch) {
  return {
    store: app.store, owner: app.runtime.owner, workspace: app.files.root,
    overrides: () => pricingSettings(app.store, app.runtime.owner).overrides,
  };
}
/**
 * Who would actually receive the tool descriptions, named, so the sentence the owner reads before
 * switching meaning search on says where their words go rather than gesturing at "a model".
 */
function meaningSearchReceiver(app: Branch, reader: { local: boolean } | null): string | undefined {
  if (!reader) return undefined;
  if (reader.local) return "the model running on this computer, so nothing leaves it";
  const provider = app.runtime.models.plan(app.runtime.owner, "").candidates[0]?.provider.name;
  return provider ? `${provider}, the model service you have connected` : undefined;
}

function voiceDeps(app: Branch) {
  return {
    store: app.store, models: app.runtime.models, owner: app.runtime.owner,
    voice: app.voice, policy: app.web.policy, fetch: app.web.policy.guard(globalThis.fetch),
    // Wave 7: the Gemini card's "Sign in with Google" needs the workspace's OAuth connections.
    oauth: app.oauth,
  };
}
/**
 * Batch 20 (wave 8): the doors a short-lived key never opens, whatever its scope. A "run" key is
 * described to its holder as one that may start a task but may not change what Branch is allowed to
 * do — and naming a program for Branch to run, or writing into the locker, is exactly that. Those
 * two are the owner's own step, in the app window, with the master key.
 */
function offLimitsToShortLivedKeys(method: string | undefined, path: string): string | null {
  if (method === "GET") return null;
  if (path === "/api/providers/cli-agents" || path.startsWith("/api/secrets") || path.startsWith("/api/connections") || /^\/api\/schedules\/[a-f0-9-]{36}\/gate$/.test(path))
    return "A short-lived key cannot name a program for Branch to run, add a model service, or change the locker. Do that in the app window.";
  if (path === "/api/deployment/close")
    return "A short-lived key cannot close Branch. Only the app on this computer can.";
  // Wave mac2 (quiet-jobs): the check-in's switches, hours and where its news goes are the owner's.
  if (path === "/api/heartbeat" || path.startsWith("/api/heartbeat/"))
    return "A short-lived key cannot change the check-in or start one. Do that in the app window.";
  // Wave mac3 (dashboard review): a "run" key "cannot change what Branch is allowed to do", and
  // Lockdown is exactly that; without this a script's key could switch Lockdown off.
  if (path === "/api/lockdown")
    return "A short-lived key cannot switch Lockdown on or off. Do that in the app window or with the key of this computer.";
  // Wave mac2 (guards): trusting a folder lets what is in it steer the assistant.
  if (handlesGuardsPath(path)) return "A short-lived key cannot change which folders are trusted or how repeated steps are stopped. Do that in the app window.";
  // Wave mac3 (tool-safety): the second look decides what gets asked about.
  if (path === "/api/approval-reviewer" && method !== "GET") return "A short-lived key cannot change the safety check before approvals. Do that in the app window.";
  return null;
}
function isExecution(request: IncomingMessage, path: string): boolean {
  return (
    request.method === "POST" && (["/api/run", "/api/action", "/v1/chat/completions", "/api/restore", "/api/deployment/restore-point", "/api/deployment/close", "/a2a", "/api/tools/try", "/api/tools/forget", "/api/tools/meaning-search", "/api/firewall/test", "/api/sandboxes", "/api/limits"].includes(path) || /^\/api\/(sessions|memory|skills|chatgpt|projects|secrets|channels|teams|registry|evaluation|documents|browser|agents|plugins|local-models|connections|monitors|brief|ask-first|retrieval|issues|practice|workflows|queue|profiles|labels|shares|calendar|knowledge|tracing|rules|flows|deferred|processes|skill-revisions|plugin-catalog|developer|studies|batch|artifacts|reports|todos|obsidian|log|remotes|marks|retention|heartbeat)(\/|$)/.test(path) || /^\/api\/mcp\/(try|signin)(\/|$)/.test(path) || /^\/api\/triggers\/[a-f0-9-]{36}\/fire$/.test(path) || /^\/api\/runs\/[a-f0-9-]{36}\/replay$/.test(path) || /^\/webhooks\/(whatsapp|chat)\//.test(path))
  );
}
function configureLimits(server: Server): void {
  server.requestTimeout = 150000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 40;
}
async function stopServer(app: Branch, server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  const schedulesStopped = app.scheduler.stop();
  await app.runtime.shutdown();
  await schedulesStopped;
  server.closeAllConnections();
  await closed;
}

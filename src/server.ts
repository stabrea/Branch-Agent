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
import { finishChatGPTSignIn, syncChatGPTPresets } from "./chatgpt-presets.js";
import { RunInputSchema, errorText } from "./contracts.js";
import { CompletionCheckSchema } from "./reliability.js";
import { liveActivity } from "./activity.js";
import { PlanStepSchema, orchestrationSettings, saveOrchestrationSettings } from "./orchestration.js";
import { classifyToolEvent } from "./receipts.js";
import { SkillScanPolicySchema } from "./skill-scan.js";
import { healthReport } from "./health.js";
import { maximumBackupBytes } from "./backup.js";
import { chatCompletion, modelsList } from "./openai-compat.js";
import { AnthropicProvider, GeminiProvider, OpenAIProvider } from "./providers.js";
import { allPresets, findPreset } from "./providers/presets.js";
import { streamRunEvents } from "./streams.js";
import { exportTemplate, importTemplate } from "./templates.js";
import { serveRunSocket, tokenFromProtocol } from "./ws.js";
import { readBodyWithRaw } from "./triggers.js";
import { WhatsAppAdapter } from "./channels/whatsapp.js";
import { standardSuite } from "./evaluation.js";
import { allSuites, saveSuite, removeSuite, suiteFromRun } from "./evaluation-suites.js";
import { McpSharingSchema, shareableTools } from "./mcp-server.js";
import { handleA2a, remoteAgentsApi } from "./a2a-routes.js";
import type { createBranch } from "./index.js";
import { PreferencesSchema, preferences } from "./preferences.js";
import { PolicyRememberSchema, policyPresets, readPolicy, savePolicy } from "./policy.js";
import { maximumArchiveBytes } from "./session-library.js";
import { maximumMemoryArchiveBytes } from "./memory.js";
import { conversationMarkdown, maximumImportBytes } from "./memory-export.js";
import { assistantIdentity, saveAssistantIdentity } from "./identity.js";
import { voiceSettings, saveVoiceSettings, transcribeAudio, generateSpeech } from "./voice.js";
import { pricingSettings, savePricingSettings, pricingTableInUse, estimateCost, formatCost } from "./pricing.js";
import { buildTraceDocument, traceSettings, saveTraceSettings } from "./trace.js";
import { writeDiagnosticsBundle } from "./diagnostics.js";

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
function authorize(request: IncomingMessage, url: string, token: string): void {
  const expected = new URL(url);
  if (request.headers.host !== expected.host)
    throw new HttpError(403, "Host rejected");
  if (request.headers.origin && request.headers.origin !== url)
    throw new HttpError(403, "Origin rejected");
  if (request.headers["sec-fetch-site"] === "cross-site")
    throw new HttpError(403, "Cross-site request rejected");
  const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
  if (
    supplied.length !== token.length ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
  )
    throw new HttpError(401, "Local session token required");
}
async function staticFile(
  path: string,
  response: ServerResponse,
): Promise<boolean> {
  const assets: Record<string, [string, string]> = {
    "/acorn.js": ["acorn.js", "text/javascript; charset=utf-8"],
    "/assets/keepoak-mark.png": ["assets/keepoak-mark.png", "image/png"],
    "/assets/keepoak-mark-reversed.png": ["assets/keepoak-mark-reversed.png", "image/png"],
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/voice.js": ["voice.js", "text/javascript; charset=utf-8"],
    "/documents.js": ["documents.js", "text/javascript; charset=utf-8"],
    "/memory-tidy.js": ["memory-tidy.js", "text/javascript; charset=utf-8"],
    "/automations.js": ["automations.js", "text/javascript; charset=utf-8"],
    "/mcp.js": ["mcp.js", "text/javascript; charset=utf-8"],
    "/browser.js": ["browser.js", "text/javascript; charset=utf-8"],
    "/approvals.js": ["approvals.js", "text/javascript; charset=utf-8"],
    "/diagnostics.js": ["diagnostics.js", "text/javascript; charset=utf-8"],
    "/update-screen.js": ["update-screen.js", "text/javascript; charset=utf-8"],
    "/usage.js": ["usage.js", "text/javascript; charset=utf-8"],
    "/evaluation.js": ["evaluation.js", "text/javascript; charset=utf-8"],
    "/providers.js": ["providers.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"],
    // App shell (wave 2): tokens, layout, appearance.
    "/tokens.css": ["tokens.css", "text/css; charset=utf-8"],
    "/shell.css": ["shell.css", "text/css; charset=utf-8"],
    "/shell.js": ["shell.js", "text/javascript; charset=utf-8"],
    "/context-pane.js": ["context-pane.js", "text/javascript; charset=utf-8"],
    "/appearance.js": ["appearance.js", "text/javascript; charset=utf-8"],
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
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
  return {
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
      .runs(owner)
      .map((run) => ({ ...run, usage: app.store.usage(run.id), cost: runCost(app, run.id), model: modelUsed(app, run.id), changes: fileChanges(app, run.id) })),
    learning: app.store.review.settings(owner),
    orchestration: orchestrationSettings(app.store, owner),
    background: app.runtime.backgroundResults,
    hooks: app.hooks.list(),
    setAside: app.store.governance.exclusions(),
    consolidation: app.store.review.cursor(owner),
    network: app.web.policy.settings(),
    memoryProposals: app.store.review.proposals(owner),
    memoryCheckpoints: app.store.review.checkpoints(owner),
    snapshots: app.store.workspaceHistory.snapshots(),
    models: app.runtime.models.summary(owner),
    memory: app.store.list("memory", owner),
    memoryCapacity: app.store.memoryCapacity(owner),
    skills: app.store.skills.list(owner),
    skillPolicy: app.store.skills.policy(owner),
    specialists: app.store.list("specialists", owner),
    procedures: app.store.list("procedures", owner),
    schedules: app.store.list("schedules", owner),
    triggers: app.triggers.list(owner),
    webhooks: app.webhooks.list(owner),
    tools: app.registry.descriptions(new Set(app.registry.permissions())),
  };
}
async function api(
  app: Branch,
  request: IncomingMessage,
  path: string,
  dataDir: string,
): Promise<unknown> {
  if (request.method === "GET" && path === "/api/state") return state(app);
  if (request.method === "GET" && path === "/api/tools") return toolInventory(app);
  if (request.method === "GET" && path === "/api/mcp/connection") return mcpConnectionSnippets(app, request, dataDir);
  if (path.startsWith("/api/mcp/")) return mcpApi(app, request, path);
  // Assistants elsewhere: the ones added, looking for more, and the link that pairs two installs.
  if (path.startsWith("/api/agents/"))
    return remoteAgentsApi(app.remoteAgents, request, path, () => readBody(request), {
      base: `http://${request.headers.host ?? "127.0.0.1:3210"}`,
      token: /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ""))?.[1] ?? "YOUR_SESSION_KEY",
    });
  if (path.startsWith("/api/sessions/")) return sessionApi(app, request, path);
  if (path.startsWith("/api/memory/")) return memoryApi(app, request, path);
  if (path.startsWith("/api/history/")) return historyApi(app, request, path);
  if (path.startsWith("/api/skills/")) return skillsApi(app, request, path);
  if (path.startsWith("/api/chatgpt/")) return chatgptApi(app, request, path);
  if (path.startsWith("/api/projects")) return projectsApi(app, request, path);
  if (path.startsWith("/api/secrets")) return secretsApi(app, request, path);
  if (path.startsWith("/api/channels")) return channelsApi(app, request, path);
  if (path.startsWith("/api/schedules/")) return schedulesApi(app, request, path);
  if (path.startsWith("/api/documents")) return documentsApi(app, request, path);
  if (path.startsWith("/api/triggers")) return triggersApi(app, request, path);
  if (path.startsWith("/api/webhooks")) return webhooksApi(app, request, path);
  if (path.startsWith("/api/browser/")) return browserApi(app, request, path);
  if (request.method === "POST" && path === "/api/identity")
    return saveAssistantIdentity(app.store, app.runtime.owner, await readBody(request));
  if (request.method === "POST" && path === "/api/models")
    return app.runtime.models.configure(app.runtime.owner, await readBody(request));
  if (request.method === "POST" && path === "/api/models/test") return testModel(app, await readBody(request));
  if (request.method === "GET" && path === "/api/providers/catalog") return providersCatalog();
  if (request.method === "POST" && path === "/api/providers/test") return testProvider(await readBody(request));
  if (request.method === "GET" && path === "/api/providers/local") return localProviders();
  if (request.method === "POST" && path === "/api/onboarding") {
    const value = OnboardingSchema.parse(await readBody(request));
    app.store.save("settings", app.runtime.owner, "onboarding", { ...value, completedAt: new Date().toISOString() });
    return onboardingState(app);
  }
  if (request.method === "POST" && path === "/api/preferences") {
    const value = PreferencesSchema.parse(await readBody(request));
    app.store.save("settings", app.runtime.owner, "preferences", value);
    return value;
  }
  if (request.method === "GET" && path === "/api/voice/settings")
    return voiceSettings(app.store, app.runtime.owner);
  if (request.method === "POST" && path === "/api/voice/settings")
    return saveVoiceSettings(app.store, app.runtime.owner, await readBody(request));
  const match = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(cancel|resume|receipts|steer|plan))?$/.exec(path);
  if (match) {
    const run = app.store.run(match[1]!);
    if (!run || run.owner !== app.runtime.owner)
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
      const body = z.object({ steps: z.array(PlanStepSchema).min(1).max(8).optional() }).strict().parse(await readBody(request));
      return app.runtime.orchestration.editPlan(run.id, body.steps);
    }
    if (request.method === "GET" && match[2] === "receipts") return receiptsView(app, run.id);
    if (request.method === "GET" && !match[2])
      return {
        run,
        events: app.store.events(run.id),
        messages: app.store.messages(run.sessionId),
        usage: app.store.usage(run.id),
        cost: runCost(app, run.id),
      };
  }
  if (request.method === "GET" && path === "/api/activity")
    return liveActivity(app.store, app.runtime.owner).map((a) => ({ ...a, followUps: app.runtime.queued(a.sessionId).length }));
  if (request.method === "GET" && path === "/api/orchestration")
    return orchestrationSettings(app.store, app.runtime.owner);
  if (request.method === "POST" && path === "/api/orchestration")
    return saveOrchestrationSettings(app.store, app.runtime.owner, await readBody(request));
  if (request.method === "GET" && path === "/api/health")
    return healthReport(app, { probeProvider: new URL(request.url ?? "/", "http://local").searchParams.get("probe") === "1" });
  if (request.method === "GET" && path === "/api/backup") return app.store.backup(app.version);
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
  if (request.method === "GET" && path === "/api/policy")
    return { policy: readPolicy(app.store, app.runtime.owner), presets: policyPresets(), waiting: app.runtime.approvals.waiting() };
  if (request.method === "POST" && path === "/api/policy")
    return { policy: savePolicy(app.store, app.runtime.owner, await readBody(request)) };
  if (request.method === "POST" && path === "/api/policy/approve") {
    const input = z.object({ sessionId: z.string().uuid(), decision: z.enum(["allow", "deny"]),
      remember: PolicyRememberSchema.default("session") }).strict().parse(await readBody(request));
    return app.runtime.approve(input.sessionId, input.decision, input.remember);
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
    return app.runtime.run({
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
    return { data, stats, pricing: pricingTableInUse(app.store, app.runtime.owner) };
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
      health: await healthReport(app), version: app.version,
    });
  const traceMatch = /^\/api\/runs\/([a-f0-9-]{36})\/trace$/.exec(path);
  if (request.method === "GET" && traceMatch) {
    const run = app.store.run(traceMatch[1]!);
    if (!run || run.owner !== app.runtime.owner) throw new HttpError(404, "Run not found");
    return buildTraceDocument(app.store, run.id, app.version);
  }
  if (request.method === "GET" && /^\/api\/runs\/([a-f0-9-]{36})\/timeline$/.test(path)) {
    const match = /^\/api\/runs\/([a-f0-9-]{36})\/timeline$/.exec(path);
    if (!match) throw new HttpError(400, "Invalid run ID");
    const run = app.store.run(match[1]!);
    if (!run || run.owner !== app.runtime.owner) throw new HttpError(404, "Run not found");
    return { timeline: app.store.usageStore().getRunTimeline(run.id) };
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
  const owner = app.runtime.owner;
  if (request.method === "POST" && path === "/api/sessions/search")
    return app.store.searchSessions(owner, await readBody(request));
  if (request.method === "POST" && path === "/api/sessions/import")
    return app.store.importSession(owner, await readBody(request, maximumArchiveBytes));
  const match = /^\/api\/sessions\/([a-f0-9-]{36})(?:\/(export|duplicate|model|discard|skill|followups|memory-policy|summary|pins))?$/.exec(path);
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
  if (match && request.method === "GET" && match[2] === "export")
    return app.store.exportSession(owner, match[1]!);
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
async function memoryApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  if (request.method === "GET" && path === "/api/memory/export") return app.store.exportMemory(owner);
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
/** Secret values go in and never come out; only names are listed. */
async function secretsApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner, locker = app.store.locker;
  const known = (project: string) => { if (!app.store.projects.list(owner).some((p) => p.id === project)) throw new HttpError(404, "Project not found"); };
  const listMatch = /^\/api\/secrets\/([a-z0-9-]{1,40})$/.exec(path);
  if (listMatch && request.method === "GET") { known(listMatch[1]!); return { project: listMatch[1], secrets: locker.names(owner, listMatch[1]!) }; }
  if (request.method === "POST" && path === "/api/secrets") {
    const { project, name, value } = z.object({ project: z.string(), name: z.string(), value: z.string() }).strict().parse(await readBody(request, 64 * 1024));
    known(project);
    return locker.set(owner, project, name, value);
  }
  const removeMatch = /^\/api\/secrets\/([a-z0-9-]{1,40})\/([A-Z][A-Z0-9_]{0,63})\/remove$/.exec(path);
  if (removeMatch && request.method === "POST") {
    z.object({}).strict().parse(await readBody(request));
    return { removed: locker.remove(owner, removeMatch[1]!, removeMatch[2]!) };
  }
  throw new HttpError(404, "Endpoint not found");
}
async function schedulesApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  const match = /^\/api\/schedules\/([a-f0-9-]{36})(?:\/(trigger))?$/.exec(path);
  if (!match) throw new HttpError(404, "Endpoint not found");
  const record = app.store.get("schedules", owner, match[1]!);
  if (!record) throw new HttpError(404, "Schedule not found");
  if (request.method === "GET" && !match[2]) return { ...record, hookPath: record.data.hookToken ? `/hooks/${record.id}` : null };
  if (request.method === "POST" && match[2] === "trigger") {
    z.object({}).strict().parse(await readBody(request));
    return app.scheduler.trigger(owner, record.id, undefined, "local");
  }
  throw new HttpError(404, "Endpoint not found");
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
  const match = /^\/webhooks\/whatsapp\/([a-z][a-z0-9_-]{0,29})$/.exec(path);
  if (!match) return false;
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

  const match = /^\/api\/webhooks\/([a-f0-9-]{36})(?:\/(log|test|remove|enable))?$/.exec(path);
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

  if (request.method === "POST" && match[2] === "enable") {
    z.object({}).strict().parse(await readBody(request));
    return app.webhooks.enable(owner, match[1]!);
  }

  throw new HttpError(404, "Endpoint not found");
}
async function channelsApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  if (request.method === "GET" && path === "/api/channels") return { ...app.channels.summary(), outstanding: app.channels.outstanding() };
  const retry = /^\/api\/channels\/deliveries\/([^/]{1,220})\/retry$/.exec(path);
  if (request.method === "POST" && retry) return app.channels.retryDelivery(decodeURIComponent(retry[1]!));
  if (request.method === "POST" && path === "/api/channels/pairings/approve") return app.channels.approve(owner, await readBody(request));
  if (request.method === "POST" && path === "/api/channels/link") return app.channels.link(owner, await readBody(request));
  if (request.method === "POST" && path === "/api/channels/test") {
    const { channel, chatId } = z.object({ channel: z.string().min(1).max(64), chatId: z.string().min(1).max(64) }).strict().parse(await readBody(request));
    return app.channels.deliver(channel, chatId, "Test message from Branch Agent: this channel is connected and working.", `test:${Date.now()}`);
  }
  if (request.method === "POST" && path === "/api/channels/pairings/remove") return app.channels.remove(owner, await readBody(request));
  throw new HttpError(404, "Endpoint not found");
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
  const match = /^\/api\/skills\/([a-f0-9-]{36})(?:\/(update|activate|disable|remove|read|benchmark|draft))?$/.exec(path);
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
      case "remove": return skills.remove(owner, id, input);
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
async function mcpApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  if (path === "/api/mcp/settings") {
    const mcp = app.mcpServer;
    if (!mcp) throw new HttpError(500, "Sharing is not available");
    if (request.method === "GET")
      return { ...mcp.sharing(), tools: shareableTools(app.registry) };
    if (request.method === "POST") {
      const body = await readBody(request);
      const sharing = McpSharingSchema.parse(body);
      const known = new Set(app.registry.names());
      const exposedTools = sharing.exposedTools.filter((name) => known.has(name));
      // A screen that does not know about answering other assistants must not switch it off by saving.
      const said = (body as Record<string, unknown> | null)?.a2a;
      const a2a = typeof said === "boolean" ? said : mcp.sharing().a2a;
      app.store.save("settings", app.runtime.owner, "mcp-sharing", { enabled: sharing.enabled, exposedTools, a2a });
      return { ...mcp.sharing(), tools: shareableTools(app.registry) };
    }
  }
  throw new HttpError(404, "Endpoint not found");
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

    if (request.method === "GET") {
      throw new HttpError(405, "Use POST for JSON-RPC requests");
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
      const result = await mcp.handle(jsonRpcRequest, sessionId);
      const session = mcp.getSession(sessionId);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "mcp-protocol-version": session.protocolVersion,
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
export async function startServer(
  app: Branch,
  options: { dataDir: string; port?: number },
) {
  const token = await sessionToken(options.dataDir);
  let url = "";
  let executions = 0;
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? "/", url || "http://127.0.0.1")
        .pathname;
      if (request.headers.host !== new URL(url).host)
        throw new HttpError(403, "Host rejected");
      if (request.method === "GET" && (await staticFile(path, response)))
        return;
      if (path.startsWith("/hooks/")) {
        send(response, 200, await hook(app, request, path));
        return;
      }
      if (await whatsAppWebhook(app, request, response, path)) return;
      const triggerFireMatch = /^\/api\/triggers\/([a-f0-9-]{36})\/fire$/.exec(path);
      if (triggerFireMatch && request.method === "POST") {
        send(response, 200, await triggerFire(app, request, triggerFireMatch[1]!));
        return;
      }
      authorize(request, url, token);
      if (await handleMcpRequest(app, request, response)) return;
      const executes = isExecution(request, path);
      if (executes && executions >= 8)
        throw new HttpError(429, "Too many active executions");
      if (executes) executions++;
      try {
        if (await rawApi(app, request, response, path)) return;
        send(response, 200, await api(app, request, path, options.dataDir));
      } finally {
        if (executes) executions--;
      }
    } catch (e) {
      if (!response.headersSent)
        send(response, e instanceof HttpError ? e.status : 400, {
          error: errorText(e),
        });
      else response.end();
    }
  });
  server.on("upgrade", (request, socket) => {
    void (async () => {
      const path = new URL(request.url ?? "/", url || "http://127.0.0.1").pathname;
      const match = /^\/api\/runs\/([a-f0-9-]{36})\/ws$/.exec(path);
      const run = match && app.store.run(match[1]!);
      const sameHost = request.headers.host === new URL(url).host && (!request.headers.origin || request.headers.origin === url);
      if (!match || !run || run.owner !== app.runtime.owner || !sameHost || !tokenFromProtocol(request, token)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      await serveRunSocket(app.store, run.id, request, socket);
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
  return {
    url,
    token,
    close: () => stopServer(app, server),
  };
}
/** Endpoints that write the response themselves (streams and the OpenAI-style chat). */
async function rawApi(app: Branch, request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  // Talking to other assistants: the card and the task endpoint, which streams when asked to.
  if (path === "/a2a" || path === "/.well-known/agent.json")
    if (await handleA2a(app.a2a, request, response, path, () => readBody(request, 131072))) return true;
  const stream = /^\/api\/runs\/([a-f0-9-]{36})\/stream$/.exec(path);
  if (stream && request.method === "GET") {
    const run = app.store.run(stream[1]!);
    if (!run || run.owner !== app.runtime.owner) throw new HttpError(404, "Run not found");
    const after = Number(new URL(request.url ?? "/", "http://local").searchParams.get("after") ?? 0) || 0;
    await streamRunEvents(app.store, run.id, response, after);
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
      // Get the active provider's audio endpoints
      const plan = app.runtime.models.plan(app.runtime.owner, "voice");
      const provider = plan.candidates[0]?.provider ?? null;
      const audioEndpoint = provider?.audio?.() ?? null;
      const text = await transcribeAudio(audio, audioEndpoint, app.web.policy, globalThis.fetch);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ text }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new HttpError(400, msg);
    }
    return true;
  }
  if (request.method === "POST" && path === "/api/voice/speak") {
    const body = z.object({ text: z.string().max(4000) }).strict().parse(await readBody(request));
    try {
      // Get the active provider's audio endpoints
      const plan = app.runtime.models.plan(app.runtime.owner, "voice");
      const provider = plan.candidates[0]?.provider ?? null;
      const audioEndpoint = provider?.audio?.() ?? null;
      const audio = await generateSpeech(body.text, audioEndpoint, app.web.policy, globalThis.fetch);
      response.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "no-store" });
      response.end(Buffer.from(audio));
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
    const csv = ["date,runs,toolCalls,tokensInput,tokensOutput,estimatedCostUsd,runsWithoutPrice,failures"]
      .concat(
        data.map((d) =>
          [d.date, d.runs, d.toolCalls, d.tokens.input, d.tokens.output,
            d.pricedRuns ? d.estimatedCost.toFixed(4) : "", d.unpricedRuns, d.failures].join(",")
        )
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
function isExecution(request: IncomingMessage, path: string): boolean {
  return (
    request.method === "POST" && (["/api/run", "/api/action", "/v1/chat/completions", "/api/restore", "/a2a"].includes(path) || /^\/api\/(sessions|memory|skills|chatgpt|projects|secrets|channels|teams|registry|evaluation|documents|browser|agents)(\/|$)/.test(path) || /^\/api\/triggers\/[a-f0-9-]{36}\/fire$/.test(path) || /^\/webhooks\/whatsapp\//.test(path))
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

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { finishChatGPTSignIn, syncChatGPTPresets } from "./chatgpt-presets.js";
import { RunInputSchema, errorText } from "./contracts.js";
import { CompletionCheckSchema } from "./reliability.js";
import { liveActivity } from "./activity.js";
import { classifyToolEvent } from "./receipts.js";
import { SkillScanPolicySchema } from "./skill-scan.js";
import { healthReport } from "./health.js";
import { maximumBackupBytes } from "./backup.js";
import { chatCompletion, modelsList } from "./openai-compat.js";
import { streamRunEvents } from "./streams.js";
import { exportTemplate, importTemplate } from "./templates.js";
import { serveRunSocket, tokenFromProtocol } from "./ws.js";
import { standardSuite } from "./evaluation.js";
import type { createBranch } from "./index.js";
import { PreferencesSchema, preferences } from "./preferences.js";
import { maximumArchiveBytes } from "./session-library.js";
import { maximumMemoryArchiveBytes } from "./memory.js";
import { assistantIdentity, saveAssistantIdentity } from "./identity.js";

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
    "/update-screen.js": ["update-screen.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"],
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
  const { allPresets } = require("./providers/presets.js");
  return { presets: allPresets() };
}

async function testProvider(body: unknown): Promise<unknown> {
  const { preset, endpoint, model, apiKey } = z
    .object({
      preset: z.string().min(1).max(64).optional(),
      endpoint: z.string().url().max(2048).optional(),
      model: z.string().min(1).max(256).optional(),
      apiKey: z.string().min(1).max(4096).optional(),
    })
    .strict()
    .parse(body);

  if (!preset && !endpoint)
    throw new HttpError(400, "Provide either a preset name or an endpoint URL");

  let providerName: string, providerEndpoint: string, providerModel: string, providerKey: string;

  if (preset) {
    const { findPreset } = require("./providers/presets.js");
    const presetData = findPreset(preset);
    if (!presetData) throw new HttpError(400, `Unknown preset: ${preset}`);
    providerName = presetData.displayName;
    providerEndpoint = presetData.baseUrl;
    providerModel = model || presetData.modelIds[0] || "";
    providerKey = apiKey || "";
  } else {
    providerName = "Custom";
    providerEndpoint = endpoint || "";
    providerModel = model || "";
    providerKey = apiKey || "";
  }

  if (!providerModel || !providerKey)
    throw new HttpError(400, "Model and API key are required");

  // Validate endpoint: HTTPS or loopback HTTP
  const url = new URL(providerEndpoint);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  ) {
    throw new HttpError(400, "Endpoint requires HTTPS (HTTP allowed only on localhost)");
  }

  // Try a test request
  const started = Date.now();
  try {
    const testBody = {
      model: providerModel,
      max_tokens: 16,
      messages: [
        { role: "system", content: "You are an assistant. Reply with OK." },
        { role: "user", content: "Test" },
      ],
    };

    const response = await fetch(new URL(providerEndpoint).origin + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${providerKey}` },
      body: JSON.stringify(testBody),
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let reason = "Request failed";
      if (response.status === 401 || response.status === 403) reason = "Invalid API key";
      else if (response.status === 404) reason = "Model not found";
      else if (response.status >= 500) reason = "Provider error";
      throw new HttpError(502, reason);
    }

    const data = await response.json().catch(() => ({}));
    const content = (data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content || "OK";

    return {
      ok: true,
      provider: providerName,
      model: providerModel,
      reply: content.slice(0, 80),
      ms: Date.now() - started,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("ECONNREFUSED")) throw new HttpError(502, "Connection refused (endpoint not running?)");
    if (msg.includes("ETIMEDOUT") || msg.includes("timeout")) throw new HttpError(502, "Request timeout");
    if (msg.includes("ERR_HTTP_REQUEST_TIMEOUT")) throw new HttpError(502, "Request timeout");
    throw new HttpError(502, `Connection failed: ${msg}`);
  }
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
    "browser.read": "ready (configured origins)", "browser.act": "ready (configured origins)",
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
      .map((run) => ({ ...run, usage: app.store.usage(run.id), model: modelUsed(app, run.id), changes: fileChanges(app, run.id) })),
    learning: app.store.review.settings(owner),
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
    tools: app.registry.descriptions(new Set(app.registry.permissions())),
  };
}
async function api(
  app: Branch,
  request: IncomingMessage,
  path: string,
): Promise<unknown> {
  if (request.method === "GET" && path === "/api/state") return state(app);
  if (request.method === "GET" && path === "/api/tools") return toolInventory(app);
  if (path.startsWith("/api/sessions/")) return sessionApi(app, request, path);
  if (path.startsWith("/api/memory/")) return memoryApi(app, request, path);
  if (path.startsWith("/api/history/")) return historyApi(app, request, path);
  if (path.startsWith("/api/skills/")) return skillsApi(app, request, path);
  if (path.startsWith("/api/chatgpt/")) return chatgptApi(app, request, path);
  if (path.startsWith("/api/projects")) return projectsApi(app, request, path);
  if (path.startsWith("/api/secrets")) return secretsApi(app, request, path);
  if (path.startsWith("/api/channels")) return channelsApi(app, request, path);
  if (path.startsWith("/api/schedules/")) return schedulesApi(app, request, path);
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
  const match = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(cancel|resume|receipts))?$/.exec(path);
  if (match) {
    const run = app.store.run(match[1]!);
    if (!run || run.owner !== app.runtime.owner)
      throw new HttpError(404, "Run not found");
    if (request.method === "POST" && match[2] === "cancel")
      return { cancelled: app.runtime.cancel(run.id) };
    if (request.method === "POST" && match[2] === "resume")
      return app.runtime.resume(run.id);
    if (request.method === "GET" && match[2] === "receipts") return receiptsView(app, run.id);
    if (request.method === "GET" && !match[2])
      return {
        run,
        events: app.store.events(run.id),
        messages: app.store.messages(run.sessionId),
        usage: app.store.usage(run.id),
      };
  }
  if (request.method === "GET" && path === "/api/activity")
    return liveActivity(app.store, app.runtime.owner).map((a) => ({ ...a, followUps: app.runtime.queued(a.sessionId).length }));
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
    });
  }
  if (request.method === "POST" && path === "/api/action") {
    const action = actionSchema.parse(await readBody(request));
    return app.runtime.executeTool(action.tool, action.args);
  }
  throw new HttpError(404, "Endpoint not found");
}
async function sessionApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner;
  if (request.method === "POST" && path === "/api/sessions/search")
    return app.store.searchSessions(owner, await readBody(request));
  if (request.method === "POST" && path === "/api/sessions/import")
    return app.store.importSession(owner, await readBody(request, maximumArchiveBytes));
  const match = /^\/api\/sessions\/([a-f0-9-]{36})(?:\/(export|duplicate|model|discard|skill|followups|memory-policy))?$/.exec(path);
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
  if (request.method === "POST" && path === "/api/memory/import")
    return app.store.importMemory(owner, await readBody(request, maximumMemoryArchiveBytes));
  if (request.method === "POST" && path === "/api/memory/capacity")
    return app.store.configureMemory(owner, await readBody(request));
  if (request.method === "POST" && path === "/api/memory/forget/preview") {
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).strict().parse(await readBody(request));
    return app.store.forgetMemoryPreview(owner, sessionId);
  }
  if (request.method === "POST" && path === "/api/memory/forget")
    return app.store.forgetMemory(owner, await readBody(request));
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
  return { runId, counts, items };
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
      authorize(request, url, token);
      const executes = isExecution(request, path);
      if (executes && executions >= 8)
        throw new HttpError(429, "Too many active executions");
      if (executes) executions++;
      try {
        if (await rawApi(app, request, response, path)) return;
        send(response, 200, await api(app, request, path));
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
  const stream = /^\/api\/runs\/([a-f0-9-]{36})\/stream$/.exec(path);
  if (stream && request.method === "GET") {
    const run = app.store.run(stream[1]!);
    if (!run || run.owner !== app.runtime.owner) throw new HttpError(404, "Run not found");
    const after = Number(new URL(request.url ?? "/", "http://local").searchParams.get("after") ?? 0) || 0;
    await streamRunEvents(app.store, run.id, response, after);
    return true;
  }
  if (request.method === "POST" && path === "/v1/chat/completions") {
    await chatCompletion(app, request, response, await readBody(request, 1024 * 1024));
    return true;
  }
  return false;
}
function isExecution(request: IncomingMessage, path: string): boolean {
  return (
    request.method === "POST" && (["/api/run", "/api/action", "/v1/chat/completions", "/api/restore"].includes(path) || /^\/api\/(sessions|memory|skills|chatgpt|projects|secrets|channels|teams|registry|evaluation)(\/|$)/.test(path))
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

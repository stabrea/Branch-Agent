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
function state(app: Branch): unknown {
  const owner = app.runtime.owner;
  return {
    provider: app.runtime.provider.name,
    activeModel: app.runtime.models.plan(owner, "").choice,
    onboarding: onboardingState(app),
    project: { active: app.store.projects.active(owner), all: app.store.projects.list(owner) },
    version: app.version,
    chatgpt: { configured: Boolean(app.chatgpt) },
    preferences: preferences(app.store, owner),
    identity: assistantIdentity(app.store, owner),
    workspace: app.runtime.workspace,
    runs: app.store
      .runs(owner)
      .map((run) => ({ ...run, usage: app.store.usage(run.id), model: modelUsed(app, run.id) })),
    models: app.runtime.models.summary(owner),
    memory: app.store.list("memory", owner),
    memoryCapacity: app.store.memoryCapacity(owner),
    skills: app.store.skills.list(owner),
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
  if (path.startsWith("/api/sessions/")) return sessionApi(app, request, path);
  if (path.startsWith("/api/memory/")) return memoryApi(app, request, path);
  if (path.startsWith("/api/skills/")) return skillsApi(app, request, path);
  if (path.startsWith("/api/chatgpt/")) return chatgptApi(app, request, path);
  if (path.startsWith("/api/projects")) return projectsApi(app, request, path);
  if (path.startsWith("/api/secrets")) return secretsApi(app, request, path);
  if (request.method === "POST" && path === "/api/identity")
    return saveAssistantIdentity(app.store, app.runtime.owner, await readBody(request));
  if (request.method === "POST" && path === "/api/models")
    return app.runtime.models.configure(app.runtime.owner, await readBody(request));
  if (request.method === "POST" && path === "/api/models/test") return testModel(app, await readBody(request));
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
  const match = /^\/api\/runs\/([a-f0-9-]{36})(\/cancel)?$/.exec(path);
  if (match) {
    const run = app.store.run(match[1]!);
    if (!run || run.owner !== app.runtime.owner)
      throw new HttpError(404, "Run not found");
    if (request.method === "POST" && match[2])
      return { cancelled: app.runtime.cancel(run.id) };
    if (request.method === "GET" && !match[2])
      return {
        run,
        events: app.store.events(run.id),
        messages: app.store.messages(run.sessionId),
        usage: app.store.usage(run.id),
      };
  }
  if (request.method === "POST" && path === "/api/run") {
    const input = RunInputSchema.parse(await readBody(request));
    return app.runtime.run({
      prompt: input.prompt,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.temporary ? { temporary: true } : {}),
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
  const match = /^\/api\/sessions\/([a-f0-9-]{36})(?:\/(export|duplicate|model|discard))?$/.exec(path);
  if (match && request.method === "GET" && !match[2]) return app.store.sessionView(owner, match[1]!);
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
async function skillsApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  const owner = app.runtime.owner, skills = app.store.skills;
  if (request.method === "POST" && path === "/api/skills/install")
    return skills.install(owner, await readBody(request, 128 * 1024));
  const match = /^\/api\/skills\/([a-f0-9-]{36})(?:\/(update|activate|disable|remove|read))?$/.exec(path);
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
      authorize(request, url, token);
      const executes = isExecution(request, path);
      if (executes && executions >= 8)
        throw new HttpError(429, "Too many active executions");
      if (executes) executions++;
      try {
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
function isExecution(request: IncomingMessage, path: string): boolean {
  return (
    request.method === "POST" && (["/api/run", "/api/action"].includes(path) || /^\/api\/(sessions|memory|skills|chatgpt|projects|secrets)(\/|$)/.test(path))
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

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
import { RunInputSchema, errorText } from "./contracts.js";
import type { createBranch } from "./index.js";
import { PreferencesSchema, preferences } from "./preferences.js";

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
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "Use application/json");
  if (Number(request.headers["content-length"] ?? 0) > 65536)
    throw new HttpError(413, "Request exceeds 64 KiB");
  let body = "";
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 65536) throw new HttpError(413, "Request exceeds 64 KiB");
    body += String(chunk);
  }
  try {
    return JSON.parse(body) as unknown;
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
function state(app: Branch): unknown {
  const owner = app.runtime.owner;
  return {
    provider: app.runtime.provider.name,
    preferences: preferences(app.store, owner),
    workspace: app.runtime.workspace,
    runs: app.store
      .runs(owner)
      .map((run) => ({ ...run, usage: app.store.usage(run.id) })),
    memory: app.store.list("memory", owner),
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
    });
  }
  if (request.method === "POST" && path === "/api/action") {
    const action = actionSchema.parse(await readBody(request));
    return app.runtime.executeTool(action.tool, action.args);
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
    request.method === "POST" && ["/api/run", "/api/action"].includes(path)
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
  await closed;
}

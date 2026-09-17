import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { audit, auditCsv, AuditQuerySchema } from "./audit.js";
import { clarifyingQuestions, promptWithAnswers, askFirstSettings, saveAskFirstSettings } from "./ask-first.js";
import { configureRepositoryContext, repositoryContextSettings } from "./context-providers.js";
import { decisionsFromRules, mergeCategoryRules } from "./tool-categories.js";
import { readPolicy, savePolicy } from "./policy.js";
import { IssueLinkSchema } from "./integrations/issue-context.js";
import type { createBranch } from "./index.js";

/**
 * The routes for the smaller things in this batch: the record of what the assistant was allowed to
 * do, deciding approvals a kind at a time, being asked questions before a task starts, the practice
 * workspace, how passages are ordered, model connections plugins brought, and pulling an issue into
 * a task from its address. They live here so the main route file stays readable.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
export class MiscApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const notFound = (): never => { throw new MiscApiError(404, "Endpoint not found"); };

/** Every path this file answers, so the main route file can hand them over in one line. */
export function handlesMiscPath(path: string): boolean {
  return /^\/api\/(audit|approvals\/categories|ask-first|practice|retrieval|providers\/plugins|issues)(\/|$)/.test(path);
}

export async function miscApi(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  const owner = app.runtime.owner;
  if (path.startsWith("/api/audit")) return auditApi(app, request, path, owner);
  if (path === "/api/approvals/categories") return categoriesApi(app, request, owner, readBody);
  if (path.startsWith("/api/ask-first")) return askFirstApi(app, request, path, owner, readBody);
  if (path.startsWith("/api/practice")) return practiceApi(app, request, path, owner, readBody);
  if (path.startsWith("/api/retrieval")) return retrievalApi(app, request, path, owner, readBody);
  if (path === "/api/providers/plugins") return providerPluginsApi(app, request, readBody);
  if (path === "/api/issues/context") return issueContextApi(app, request, readBody);
  return notFound();
}

async function auditApi(app: Branch, request: IncomingMessage, path: string, owner: string): Promise<unknown> {
  if (request.method !== "GET" || path !== "/api/audit") return notFound();
  const query = new URL(request.url ?? "/", "http://local").searchParams;
  const entries = app.store.audit.list(owner, filterFrom(query));
  return { entries, counts: app.store.audit.counts(owner) };
}
/** The filters a web address can carry, in the shape the record understands. */
function filterFrom(query: URLSearchParams): unknown {
  const value: Record<string, unknown> = {};
  for (const name of ["action", "source", "origin", "from", "to"]) {
    const found = query.get(name);
    if (found) value[name] = found;
  }
  const limit = Number(query.get("limit") ?? 0);
  if (limit > 0) value.limit = Math.min(limit, 1000);
  return AuditQuerySchema.parse(value);
}
/** The same record as a spreadsheet file; it writes its own answer, like the other exports. */
export function auditCsvResponse(app: Branch, request: IncomingMessage, response: ServerResponse): void {
  const owner = app.runtime.owner;
  const entries = app.store.audit.list(owner, filterFrom(new URL(request.url ?? "/", "http://local").searchParams));
  audit(app.store, owner, { action: "data.exported", actor: owner, subject: "the record of what the assistant was allowed to do", reason: "Saved as a spreadsheet file", outcome: "saved" });
  response.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": 'attachment; filename="what-it-was-allowed-to-do.csv"',
    "cache-control": "no-store",
  });
  response.end(auditCsv(entries));
}

async function categoriesApi(
  app: Branch, request: IncomingMessage, owner: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (request.method === "GET")
    return { categories: decisionsFromRules(app.registry, readPolicy(app.store, owner).rules) };
  if (request.method === "POST") {
    // Only the kinds named in the request change; every other rule the owner has is kept.
    const rules = mergeCategoryRules(app.registry, readPolicy(app.store, owner).rules, await readBody(request));
    const policy = savePolicy(app.store, owner, { rules }, "Decided a whole kind of thing at once in the approval settings");
    return { policy, categories: decisionsFromRules(app.registry, policy.rules) };
  }
  return notFound();
}

async function askFirstApi(
  app: Branch, request: IncomingMessage, path: string, owner: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (path === "/api/ask-first/settings") {
    if (request.method === "GET") return askFirstSettings(app.store, owner);
    if (request.method === "POST") return saveAskFirstSettings(app.store, owner, await readBody(request));
  }
  if (path === "/api/ask-first" && request.method === "POST")
    return clarifyingQuestions(app.store, app.runtime.models, owner, await readBody(request));
  if (path === "/api/ask-first/answers" && request.method === "POST")
    return promptWithAnswers(await readBody(request, 128 * 1024));
  return notFound();
}

async function practiceApi(
  app: Branch, request: IncomingMessage, path: string, owner: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (path !== "/api/practice") return notFound();
  if (request.method === "GET") return app.practice.state(owner);
  if (request.method === "POST") return app.practice.switch(owner, await readBody(request));
  return notFound();
}

async function retrievalApi(
  app: Branch, request: IncomingMessage, path: string, owner: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (path === "/api/retrieval") {
    if (request.method === "GET")
      return { ...app.retrieval.view(owner), ...repositoryContextSettings(app.store, owner),
        providers: app.contextProviders.list() };
    if (request.method === "POST") return app.retrieval.configure(owner, await readBody(request));
  }
  if (path === "/api/retrieval/context" && request.method === "POST")
    return configureRepositoryContext(app.store, owner, await readBody(request));
  if (path === "/api/retrieval/pipelines" && request.method === "POST")
    return app.retrieval.configurePipelines(owner, await readBody(request));
  if (path === "/api/retrieval/search" && request.method === "POST") {
    const asked = z.object({
      query: z.string().trim().min(1).max(500),
      pipeline: z.string().trim().min(1).max(60).optional(),
      collection: z.string().trim().min(1).max(120).optional(),
    }).strict().parse(await readBody(request));
    return app.retrieval.search(owner, asked.query, undefined, {
      ...(asked.pipeline ? { pipeline: asked.pipeline } : {}),
      ...(asked.collection ? { collection: asked.collection } : {}),
    });
  }
  return notFound();
}

async function providerPluginsApi(
  app: Branch, request: IncomingMessage,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (request.method === "GET") return { providers: app.providerPlugins.list() };
  if (request.method === "POST") return app.providerPlugins.addPreset(await readBody(request));
  return notFound();
}

async function issueContextApi(
  app: Branch, request: IncomingMessage,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (request.method !== "POST") return notFound();
  const { url } = IssueLinkSchema.parse(await readBody(request));
  const issues = app.issues;
  if (!issues) throw new MiscApiError(400, "No issue tracker is switched on in this launch's integration settings");
  const context = await issues.contextFor(url, 2);
  if (!context) throw new MiscApiError(404, "That does not look like an issue address this assistant can read");
  return context;
}

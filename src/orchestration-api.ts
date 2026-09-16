import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { flowsApi } from "./flows.js";
import { projectCheck, saveProjectCheck } from "./code-change.js";
import { codeRunSettings, saveCodeRunSettings } from "./code-run.js";
import { backgroundSettings, saveBackgroundSettings } from "./processes.js";
import { SettleDeferredSchema } from "./deferred.js";
import { specialistStyles, styleShape } from "./specialist-styles.js";
import type { createBranch } from "./index.js";

/**
 * The routes for this batch: flows as boxes and arrows, jobs handed over to finish later, programs
 * left running, and the three switches behind them — the project's own check, the programs the
 * owner allows to be left running, and whether small scripts may run at all.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
export class OrchestrationApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const notFound = (): never => { throw new OrchestrationApiError(404, "Endpoint not found"); };

/** Every path this file answers, so the main route file can hand them over in one line. */
export function handlesOrchestrationPath(path: string): boolean {
  return /^\/api\/(flows|deferred|processes|code-check|code-run|background-programs|specialist-styles|skill-revisions|plugin-catalog)(\/|$)/.test(path);
}

export async function orchestrationApi(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  const owner = app.runtime.owner;
  // Every one of these belongs to the owner: they switch host execution on, say which programs may
  // be left running, copy a plugin in, keep a drafted skill, or answer a job handed over earlier.
  app.store.profiles.requireOwner("Flows, programs left running and the switches behind them");
  if (path.startsWith("/api/flows")) {
    const answered = await flowsApi(app.flows, request, path, () => readBody(request));
    return answered ?? notFound();
  }
  if (path.startsWith("/api/deferred")) return deferredApi(app, request, path, readBody);
  if (path.startsWith("/api/skill-revisions")) return revisionsApi(app, request, path, readBody);
  if (path.startsWith("/api/plugin-catalog")) return pluginCatalogApi(app, request, path, readBody);
  if (path === "/api/processes") return processesApi(app, request, readBody);
  if (path === "/api/specialist-styles")
    return { styles: specialistStyles.map((style) => ({ style, ...summaryOf(style) })) };
  if (path === "/api/code-check")
    return request.method === "POST"
      ? saveProjectCheck(app.store, owner, await readBody(request)) : projectCheck(app.store, owner);
  if (path === "/api/code-run")
    return request.method === "POST"
      ? saveCodeRunSettings(app.store, owner, await readBody(request)) : codeRunSettings(app.store, owner);
  if (path === "/api/background-programs")
    return request.method === "POST"
      ? saveBackgroundSettings(app.store, owner, await readBody(request)) : backgroundSettings(app.store, owner);
  return notFound();
}

const summaryOf = (style: string) => {
  const shape = styleShape(style as Parameters<typeof styleShape>[0]);
  return { summary: shape.summary, opens: shape.groups, readOnly: shape.readOnly, plans: shape.plan, thinksAloud: shape.scratch };
};

async function deferredApi(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (request.method === "GET" && path === "/api/deferred") {
    const waiting = new URL(request.url ?? "/", "http://local").searchParams.get("waiting") === "1";
    return { deferred: app.runtime.deferrals.list(waiting ? { waiting: true } : {}) };
  }
  if (request.method === "POST" && path === "/api/deferred/settle") {
    const value = SettleDeferredSchema.parse(await readBody(request));
    return app.runtime.settleDeferred(value.id, value.outcome);
  }
  return notFound();
}

/**
 * Switching a draft on without the trial needs the owner to say so in as many words. `force` on
 * its own is not enough: the exact sentence below has to come with it, typed by the screen only
 * when the person has pressed a second button that says what they are skipping. Nothing the model
 * can reach passes this — these routes are the owner's own, and the model has no tool for them.
 */
export const skipTrialConfirmation = "I have not tried this draft and I want it anyway";
const revisionBody = z.object({
  skillId: z.string().uuid(), version: z.number().int().min(1).max(20),
  force: z.boolean().optional(), confirm: z.string().max(200).optional(),
}).strict();
/** Drafted better versions of a skill: seeing the changed lines, trying them, and saying yes or no. */
async function revisionsApi(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (request.method === "GET" && path === "/api/skill-revisions") return { revisions: app.skillRevisions.list() };
  if (request.method !== "POST") return notFound();
  const body = revisionBody.parse(await readBody(request));
  if (path === "/api/skill-revisions/try") return app.skillRevisions.tryOut(app.runtime, body.skillId, body.version);
  if (path === "/api/skill-revisions/accept") {
    if (!body.force) return app.skillRevisions.accept(body.skillId, body.version);
    app.store.profiles.requireOwner("Switching on a drafted skill without trying it");
    if (body.confirm !== skipTrialConfirmation)
      throw new Error(`To switch this on without trying it, confirm it in the app. It is refused until the words "${skipTrialConfirmation}" come with the request.`);
    return app.skillRevisions.accept(body.skillId, body.version, { force: true });
  }
  if (path === "/api/skill-revisions/reject") return app.skillRevisions.reject(body.skillId, body.version);
  return notFound();
}

const pluginSource = z.object({ source: z.string().min(1).max(1000), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict();
/** Plugins from a folder or one file on this computer: looking first, then copying in. */
async function pluginCatalogApi(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (request.method === "GET" && path === "/api/plugin-catalog") return { plugins: await app.pluginCatalog.list() };
  if (request.method !== "POST") return notFound();
  if (path === "/api/plugin-catalog/inspect") return app.pluginCatalog.inspect(pluginSource.parse(await readBody(request)).source);
  if (path === "/api/plugin-catalog/install") {
    const body = pluginSource.parse(await readBody(request));
    return app.pluginCatalog.install(body.source, body.sha256 ? { expectSha256: body.sha256 } : {});
  }
  if (path === "/api/plugin-catalog/forget") {
    const { id } = z.object({ id: z.string().min(1).max(40) }).strict().parse(await readBody(request));
    return app.pluginCatalog.forget(id);
  }
  return notFound();
}

async function processesApi(
  app: Branch, request: IncomingMessage,
  readBody: (request: IncomingMessage, maximumBytes?: number) => Promise<unknown>,
): Promise<unknown> {
  if (request.method === "GET") return { processes: app.processes.list() };
  if (request.method === "POST") {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(await readBody(request));
    return app.processes.stop(id);
  }
  return notFound();
}

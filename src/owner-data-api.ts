import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { createBranch } from "./index.js";
import { reservedProjectId } from "./projects.js";
import { HttpError, readJsonBody } from "./server-http.js";

type Branch = Awaited<ReturnType<typeof createBranch>>;

export async function projectsApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  app.store.profiles.requireOwner("Projects");
  const owner = app.runtime.owner, projects = app.store.projects;
  if (request.method === "GET" && path === "/api/projects") return { active: projects.active(owner), all: projects.list(owner) };
  if (request.method === "POST" && path === "/api/projects") {
    const body = await readJsonBody(request) as { modelPreset?: unknown };
    if (typeof body?.modelPreset === "string" && !app.runtime.models.presets.has(body.modelPreset))
      throw new HttpError(400, "That model preset is not configured");
    return projects.save(owner, body);
  }
  if (request.method === "POST" && path === "/api/projects/active") return projects.setActive(owner, await readJsonBody(request));
  const match = /^\/api\/projects\/([a-z0-9-]{1,40})\/remove$/.exec(path);
  if (match && request.method === "POST") {
    z.object({}).strict().parse(await readJsonBody(request));
    const result = projects.remove(owner, match[1]!);
    app.store.locker.removeProject(owner, match[1]!);
    return result;
  }
  throw new HttpError(404, "Endpoint not found");
}

function knownProject(app: Branch, owner: string, project: string): void {
  if (!app.store.projects.list(owner).some((candidate) => candidate.id === project))
    throw new HttpError(404, "Project not found");
}

/** Secret values go in and never come out; only names, dates and who used them are listed. */
export async function secretsApi(app: Branch, request: IncomingMessage, path: string): Promise<unknown> {
  app.store.profiles.requireOwner("The secrets locker");
  const owner = app.runtime.owner, secrets = app.store.secrets;
  if (request.method === "GET" && path === "/api/secrets/audit")
    return { uses: secrets.audit(owner), reminders: secrets.reminders(owner, app.store.projects.list(owner).map((p) => p.id)) };
  const list = /^\/api\/secrets\/([a-z0-9-]{1,40})$/.exec(path);
  if (list && request.method === "GET") {
    if (reservedProjectId(list[1]!))
      throw new HttpError(403, "Branch keeps these secrets itself; use them where they are set up.");
    knownProject(app, owner, list[1]!);
    return { project: list[1], secrets: secrets.list(owner, list[1]!) };
  }
  if (request.method === "POST" && path === "/api/secrets") return putSecret(app, request);
  const action = /^\/api\/secrets\/([a-z0-9-]{1,40})\/([A-Z][A-Z0-9_]{0,63})\/(remove|rotate)$/.exec(path);
  if (action && request.method === "POST") return changeSecret(app, request, action as RegExpExecArray);
  throw new HttpError(404, "Endpoint not found");
}

async function putSecret(app: Branch, request: IncomingMessage): Promise<unknown> {
  const owner = app.runtime.owner, secrets = app.store.secrets;
  const body = z.object({ project: z.string(), name: z.string(), value: z.string(), expiresInDays: z.number().optional() })
    .strict().parse(await readJsonBody(request, 64 * 1024));
  if (reservedProjectId(body.project))
    throw new HttpError(403, "Branch keeps these secrets itself; change them where they are set up.");
  knownProject(app, owner, body.project);
  return secrets.put(owner, body.project, body.name, body.value, { expiresInDays: body.expiresInDays ?? 0 });
}

async function changeSecret(app: Branch, request: IncomingMessage, action: RegExpExecArray): Promise<unknown> {
  const owner = app.runtime.owner, secrets = app.store.secrets;
  if (reservedProjectId(action[1]!))
    throw new HttpError(403, "Branch keeps these secrets itself; change them where they are set up.");
  if (action[3] === "remove") {
    z.object({}).strict().parse(await readJsonBody(request));
    return { removed: secrets.remove(owner, action[1]!, action[2]!) };
  }
  const body = z.object({ value: z.string(), expiresInDays: z.number().optional() }).strict()
    .parse(await readJsonBody(request, 64 * 1024));
  knownProject(app, owner, action[1]!);
  return secrets.rotate(owner, action[1]!, action[2]!, body.value, { expiresInDays: body.expiresInDays ?? 0 });
}

import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { createBranch } from "./index.js";
import type { Run } from "./contracts.js";
import type { RunOptions } from "./runtime.js";
import { ShareRequestSchema, ShareLinkSchema } from "./conversation-share.js";
import { audit } from "./audit.js";
import { labelTargets } from "./labels.js";
import { PolicyRememberSchema } from "./policy.js";
import { roleLabels } from "./profile-roles.js";

/**
 * The web routes for sharing, labels and notes, saved workflows, the waiting line for tasks, days
 * off and quiet hours, and the household's profiles. They live here so the main server file only
 * gains one line. Everything reads and writes under whichever profile is in use: the owner's own
 * secrets and projects are refused while somebody else's profile is switched on.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
type ReadBody = (maximumBytes?: number) => Promise<unknown>;
/** Marks a path this file does not serve, so the main server can carry on looking. */
export const notCollab = Symbol("not a collaboration route");

const idPattern = "[a-f0-9-]{36}";
const projectId = z.object({ project: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/) }).strict();

/** Everything the Sharing, Workflows, Waiting line, Days off and People panels show. */
export function collabState(app: Branch): unknown {
  const owner = app.runtime.owner, profiles = app.store.profiles, scope = profiles.scope();
  const person = { active: profiles.active(), all: profiles.list(), isOwner: profiles.isOwner() };
  // Shared copies, saved workflows, the waiting line and days off are the owner's, so a screen
  // opened under somebody else's profile shows their labels and nothing of the owner's.
  if (!profiles.isOwner())
    return { profile: person, labels: app.store.labels.catalog(scope), shares: [], workflows: [],
      queue: { waiting: [], recent: [], settings: app.runQueue.settings(owner) },
      calendar: { settings: app.calendar.settings(owner), countries: [] } };
  return {
    profile: person,
    labels: app.store.labels.catalog(scope),
    shares: app.store.shares.list(owner),
    workflows: app.workflows.list(owner),
    queue: { waiting: app.runQueue.list(owner), recent: app.runQueue.recent(owner), settings: app.runQueue.settings(owner) },
    calendar: { settings: app.calendar.settings(owner), countries: app.calendar.countries() },
  };
}

export async function collabApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody):
  Promise<unknown | typeof notCollab> {
  const get = request.method === "GET", post = request.method === "POST";
  if (get && path === "/api/collab") return collabState(app);
  const shared = await sharingApi(app, request, path, body);
  if (shared !== notCollab) return shared;
  const labelled = await labelsApi(app, request, path, body);
  if (labelled !== notCollab) return labelled;
  const flow = await workflowsApi(app, request, path, body);
  if (flow !== notCollab) return flow;
  const queued = await queueApi(app, request, path, body);
  if (queued !== notCollab) return queued;
  // Days off and quiet hours are the owner's settings and affect everything the app sends.
  if (get && path === "/api/calendar") {
    app.store.profiles.requireOwner("Days off and quiet hours");
    return { settings: app.calendar.settings(app.runtime.owner), countries: app.calendar.countries() };
  }
  if (post && path === "/api/calendar") {
    app.store.profiles.requireOwner("Days off and quiet hours");
    return app.calendar.configure(app.runtime.owner, await body());
  }
  return profilesApi(app, request, path, body);
}

/** A conversation as a page: the file itself, or a read-only link with a code and an expiry. */
async function sharingApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody): Promise<unknown | typeof notCollab> {
  // Shared copies belong to whoever is using the app: somebody else's profile must not be able to
  // mint a link to a conversation of the owner's, nor see the links the owner has handed out.
  const owner = app.store.profiles.scope();
  const share = new RegExp(`^/api/sessions/(${idPattern})/share$`).exec(path);
  if (share && request.method === "POST") {
    const input = ShareLinkSchema.parse({ ...(await body() as object), sessionId: share[1]! });
    if (!app.store.ownsSession(owner, input.sessionId)) throw new Error("Conversation not found");
    return app.store.shares.create(owner, input, app.store.messages(input.sessionId));
  }
  if (request.method === "GET" && path === "/api/shares") return { shares: app.store.shares.list(owner) };
  const revoke = new RegExp(`^/api/shares/(${idPattern})/revoke$`).exec(path);
  if (revoke && request.method === "POST") { await body(); return app.store.shares.revoke(owner, revoke[1]!); }
  return notCollab;
}

async function labelsApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody): Promise<unknown | typeof notCollab> {
  const scope = app.store.profiles.scope(), labels = app.store.labels;
  const get = request.method === "GET", post = request.method === "POST";
  if (get && path === "/api/labels") {
    const target = new URL(request.url ?? "/", "http://local").searchParams.get("target");
    const chosen = labelTargets.find((kind) => kind === target);
    return { catalog: labels.catalog(scope, chosen), labels: labels.list(scope, chosen) };
  }
  if (post && path === "/api/labels") return labels.add(scope, await body());
  if (post && path === "/api/labels/remove") return labels.remove(scope, await body());
  if (get && path === "/api/projects/notes") {
    const { project } = projectId.parse({ project: new URL(request.url ?? "/", "http://local").searchParams.get("project") ?? "default" });
    return { project, notes: labels.comments(scope, project) };
  }
  if (post && path === "/api/projects/notes") return labels.comment(scope, await body());
  const remove = new RegExp(`^/api/projects/notes/(${idPattern})/remove$`).exec(path);
  if (remove && post) { await body(); return labels.removeComment(scope, remove[1]!); }
  return notCollab;
}

async function workflowsApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody): Promise<unknown | typeof notCollab> {
  const owner = app.runtime.owner, workflows = app.workflows;
  if (!path.startsWith("/api/workflows")) return notCollab;
  // A workflow's steps use tools with the owner's full run of the app, so only the owner may see
  // one or set one going.
  app.store.profiles.requireOwner("Saved workflows");
  if (request.method === "GET" && path === "/api/workflows") return { workflows: workflows.list(owner) };
  if (request.method === "POST" && path === "/api/workflows") return workflows.create(owner, await body());
  const match = new RegExp(`^/api/workflows/(${idPattern})(?:/(run|pause|resume|remove))?$`).exec(path);
  if (!match) return notCollab;
  if (request.method === "GET" && !match[2]) return workflows.view(owner, match[1]!);
  if (request.method !== "POST") return notCollab;
  const sent = await body();
  if (match[2] === "run") return workflows.run(owner, match[1]!);
  if (match[2] === "pause") return workflows.pause(owner, match[1]!);
  if (match[2] === "resume") {
    // Carrying on a workflow that stopped to ask is the owner saying yes, from their own screen.
    // They may say it just for this workflow (the default) or keep it as a standing rule.
    const remember = PolicyRememberSchema.safeParse((sent as { remember?: unknown } | null)?.remember);
    return workflows.resume(owner, match[1]!, remember.success ? { remember: remember.data } : {});
  }
  if (match[2] === "remove") return workflows.remove(owner, match[1]!);
  return notCollab;
}

async function queueApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody): Promise<unknown | typeof notCollab> {
  const owner = app.runtime.owner, queue = app.runQueue;
  if (!path.startsWith("/api/queue")) return notCollab;
  // A task from the waiting line runs with the owner's own run of the app, so somebody else's
  // profile may not put one in it. They can still start a task the ordinary way.
  app.store.profiles.requireOwner("The waiting line");
  if (request.method === "GET" && path === "/api/queue")
    return { waiting: queue.list(owner), recent: queue.recent(owner), settings: queue.settings(owner) };
  if (request.method === "POST" && path === "/api/queue") return queue.submit(owner, await body());
  if (request.method === "POST" && path === "/api/queue/settings") return queue.configure(owner, await body());
  const cancel = new RegExp(`^/api/queue/(${idPattern})/cancel$`).exec(path);
  if (cancel && request.method === "POST") { await body(); return queue.cancel(owner, cancel[1]!); }
  return notCollab;
}

async function profilesApi(app: Branch, request: IncomingMessage, path: string, body: ReadBody): Promise<unknown | typeof notCollab> {
  const profiles = app.store.profiles;
  if (request.method === "GET" && path === "/api/profiles")
    return { profiles: profiles.list(), active: profiles.active(), isOwner: profiles.isOwner(),
      // Batch 26 (wave 8): what each person may have Branch do, for the card beside their name.
      roles: app.runtime.roles.all(profiles.list().map((profile) => profile.id)), roleLabels };
  if (request.method === "POST" && path === "/api/profiles") {
    profiles.requireOwner("Adding somebody to this computer");
    return profiles.create(await body());
  }
  if (request.method === "POST" && path === "/api/profiles/switch") {
    const switched = profiles.switch(await body());
    // Batch 20 (wave 8): who is using the computer decides whose records are reachable, so every
    // switch is written down — the move back to the owner included.
    audit(app.store, app.runtime.owner, {
      action: "profile.switched", actor: switched.active?.name ?? app.runtime.owner,
      subject: switched.active ? `${switched.active.name}'s profile` : "back to you",
      reason: "Somebody switched who is using this computer", outcome: "switched",
    });
    return switched;
  }
  // The role and grant on one profile. Only the owner may set what anybody else is allowed to do.
  const role = new RegExp(`^/api/profiles/(${idPattern})/role$`).exec(path);
  if (role && request.method === "POST") {
    profiles.requireOwner("Deciding what somebody here may do");
    return app.runtime.roles.save(role[1]!, await body());
  }
  if (role && request.method === "GET") return app.runtime.roles.get(role[1]!);
  const remove = new RegExp(`^/api/profiles/(${idPattern})/remove$`).exec(path);
  if (remove && request.method === "POST") {
    profiles.requireOwner("Removing somebody from this computer");
    await body();
    return profiles.remove(remove[1]!);
  }
  return notCollab;
}

/** Everything the assistant's share request needs checked before a page is written. */
export const shareRequest = ShareRequestSchema;

/**
 * Runs a task for whoever is using the app. The assistant always works as the owner, so a second
 * person's conversation is lent to it for the length of the task and handed straight back, and the
 * finished conversation stays in their list rather than the owner's.
 */
export async function runForCurrentPerson(app: Branch, options: RunOptions): Promise<Run> {
  const profiles = app.store.profiles;
  if (profiles.isOwner()) return app.runtime.run(options);
  const scope = profiles.scope();
  if (options.sessionId && !app.store.ownsSession(scope, options.sessionId))
    throw new Error("Conversation not found");
  if (options.sessionId) app.store.reassignSession(options.sessionId, app.runtime.owner);
  try {
    const run = await app.runtime.run(options);
    app.store.reassignSession(run.sessionId, scope);
    return run;
  } catch (error) {
    if (options.sessionId) app.store.reassignSession(options.sessionId, scope);
    throw error;
  }
}

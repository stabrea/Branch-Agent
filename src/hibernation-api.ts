import { z } from "zod";
import { HibernationStore, OperationNotFoundError, OperationStateError, WorkspaceChangedError, hibernationSettings, saveHibernationSettings, type SettingsStore } from "./hibernation.js";

/**
 * The web routes for src/hibernation.ts: the configured serverless environment, starting an
 * operation, running it forward, suspending it, and resuming it. Modelled on the learning core's
 * routes in src/fly-core-api.ts.
 *
 *   GET  /api/hibernation                 the configured environment
 *   POST /api/hibernation/settings        { environment: "local" }
 *   GET  /api/hibernation/operations      every operation on file, oldest first
 *   POST /api/hibernation/start           { steps: ["…", "…"] } → an operation
 *   POST /api/hibernation/advance         { id } → runs the next step
 *   POST /api/hibernation/suspend         { id } → freezes the workspace, stops the compute
 *   POST /api/hibernation/resume          { id, acceptChanges? } → checks the workspace, continues from
 *                                         its step; a changed workspace is refused (409) unless acceptChanges
 *   GET  /api/hibernation/{id}            the operation as it stands (an id is always a uuid)
 *
 * Every one of these is the owner's: a short-lived key is refused the changes by the fail-closed rule
 * and the reads by ownerOnlyReads (src/short-lived-keys.ts).
 *
 * Only the local adapter is real (see HibernationStore). A cloud provider such as Fly Machines or
 * Cloud Run needs a paid account and its own API client, so it is out of scope here; the seam is
 * `HibernationDeps.hibernation`, which a real provider's adapter would implement the same shape of.
 */
export class HibernationApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const IdSchema = z.object({ id: z.string().trim().min(1).max(80) }).strict();
const ResumeSchema = z.object({ id: z.string().trim().min(1).max(80), acceptChanges: z.boolean().optional() }).strict();
const StartSchema = z.object({ steps: z.array(z.string().trim().min(1).max(200)).min(1).max(50) }).strict();

export interface HibernationDeps {
  store: SettingsStore;
  owner: string;
  hibernation: HibernationStore;
}

export const handlesHibernationPath = (path: string): boolean =>
  path === "/api/hibernation" || path.startsWith("/api/hibernation/");

/** The store's own refusals, as the status a client can act on. */
async function answered(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OperationNotFoundError) throw new HibernationApiError(404, error.message);
    if (error instanceof OperationStateError || error instanceof WorkspaceChangedError) throw new HibernationApiError(409, error.message);
    throw error;
  }
}

async function withId(body: () => Promise<unknown>, run: (id: string) => Promise<unknown>): Promise<unknown> {
  const parsed = IdSchema.safeParse(await body());
  if (!parsed.success) throw new HibernationApiError(400, "Say { \"id\": \"…\" } naming the operation.");
  return answered(() => run(parsed.data.id));
}

export async function hibernationApi(deps: HibernationDeps, method: string, path: string, body: () => Promise<unknown>): Promise<unknown> {
  if (method === "GET" && path === "/api/hibernation") return hibernationSettings(deps.store, deps.owner);
  if (method === "POST" && path === "/api/hibernation/settings") return saveHibernationSettings(deps.store, deps.owner, await body());
  if (method === "GET" && path === "/api/hibernation/operations") return deps.hibernation.list();
  if (method === "POST" && path === "/api/hibernation/start") {
    const parsed = StartSchema.safeParse(await body());
    if (!parsed.success) throw new HibernationApiError(400, "Say { \"steps\": [\"…\"] } naming the operation's work.");
    const settings = hibernationSettings(deps.store, deps.owner);
    return deps.hibernation.start(settings.environment, parsed.data.steps);
  }
  if (method === "POST" && path === "/api/hibernation/advance") return withId(body, (id) => deps.hibernation.advance(id));
  if (method === "POST" && path === "/api/hibernation/suspend") return withId(body, (id) => deps.hibernation.suspend(id));
  if (method === "POST" && path === "/api/hibernation/resume") {
    const parsed = ResumeSchema.safeParse(await body());
    if (!parsed.success) throw new HibernationApiError(400, "Say { \"id\": \"…\" } naming the operation, and \"acceptChanges\": true to continue with a changed workspace.");
    const { id, acceptChanges } = parsed.data;
    return answered(() => deps.hibernation.resume(id, { acceptChanges: acceptChanges === true }));
  }
  // Only an id the store could have made is looked up; the address is never decoded into a path.
  const one = method === "GET" ? /^\/api\/hibernation\/([a-f0-9-]{36})$/.exec(path) : null;
  if (one) return answered(() => deps.hibernation.read(one[1]!));
  throw new HibernationApiError(404, "Endpoint not found");
}

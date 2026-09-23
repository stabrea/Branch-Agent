import { z } from "zod";
import { HibernationStore, OperationNotFoundError, hibernationSettings, saveHibernationSettings, type SettingsStore } from "./hibernation.js";

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
 *   POST /api/hibernation/resume          { id } → checks the workspace, continues from its step
 *   GET  /api/hibernation/{id}            the operation as it stands
 *
 * Only the local adapter is real (see HibernationStore). A cloud provider such as Fly Machines or
 * Cloud Run needs a paid account and its own API client, so it is out of scope here; the seam is
 * `HibernationDeps.hibernation`, which a real provider's adapter would implement the same shape of.
 */
export class HibernationApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const IdSchema = z.object({ id: z.string().trim().min(1).max(80) }).strict();
const StartSchema = z.object({ steps: z.array(z.string().trim().min(1).max(200)).min(1).max(50) }).strict();

export interface HibernationDeps {
  store: SettingsStore;
  owner: string;
  hibernation: HibernationStore;
}

export const handlesHibernationPath = (path: string): boolean =>
  path === "/api/hibernation" || path.startsWith("/api/hibernation/");

async function withId(body: () => Promise<unknown>, run: (id: string) => Promise<unknown>): Promise<unknown> {
  const parsed = IdSchema.safeParse(await body());
  if (!parsed.success) throw new HibernationApiError(400, "Say { \"id\": \"…\" } naming the operation.");
  try {
    return await run(parsed.data.id);
  } catch (error) {
    if (error instanceof OperationNotFoundError) throw new HibernationApiError(404, error.message);
    throw error;
  }
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
  if (method === "POST" && path === "/api/hibernation/resume") return withId(body, (id) => deps.hibernation.resume(id));
  if (method === "GET" && path.startsWith("/api/hibernation/") && path !== "/api/hibernation/") {
    const id = decodeURIComponent(path.slice("/api/hibernation/".length));
    try {
      return await deps.hibernation.read(id);
    } catch (error) {
      if (error instanceof OperationNotFoundError) throw new HibernationApiError(404, error.message);
      throw error;
    }
  }
  throw new HibernationApiError(404, "Endpoint not found");
}

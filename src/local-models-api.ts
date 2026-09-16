import { z } from "zod";
import { localModelName } from "./local-models.js";
import { classifyTask, routeForTask, routingSettings, saveRoutingSettings } from "./local-routing.js";
import type { LocalRuntimes } from "./local-runtimes.js";
import type { ModelRouter } from "./models.js";
import type { Store } from "./store.js";

/**
 * The `/api/local-models/*` family: what is on this computer, what this computer could run,
 * downloading and removing a model, and the per-task routing rules. Kept out of src/server.ts so
 * the route table there stays one short block.
 */
const modelBody = z.object({ model: localModelName }).strict();
const previewBody = z.object({
  prompt: z.string().trim().min(1).max(8000),
  toolCount: z.number().int().min(0).max(500).default(0),
  localUp: z.boolean().default(true),
}).strict();

export interface LocalModelsDeps {
  runtimes: LocalRuntimes;
  store: Store;
  models: ModelRouter;
  owner: string;
}

export async function localModelsApi(
  deps: LocalModelsDeps, method: string, path: string, body: () => Promise<unknown>,
): Promise<unknown> {
  const { runtimes, store, models, owner } = deps;
  if (method === "GET" && path === "/api/local-models") return overview(deps);
  if (method === "GET" && path === "/api/local-models/downloads") return { downloads: runtimes.progress() };
  if (method === "GET" && path === "/api/local-models/routing") return routingSettings(store, owner);
  if (method === "POST" && path === "/api/local-models/routing") return saveRoutingSettings(store, owner, await body());
  if (method === "POST" && path === "/api/local-models/routing/preview") {
    const input = previewBody.parse(await body());
    const shape = classifyTask(input.prompt, input.toolCount);
    return { shape, choice: routeForTask(store, models, owner, input) };
  }
  if (method === "POST" && path === "/api/local-models/pull")
    return runtimes.start(modelBody.parse(await body()).model);
  if (method === "POST" && path === "/api/local-models/stop")
    return runtimes.stop(modelBody.parse(await body()).model);
  if (method === "POST" && path === "/api/local-models/remove")
    return runtimes.remove(modelBody.parse(await body()).model);
  if (method === "POST" && path === "/api/local-models/details")
    return runtimes.details(modelBody.parse(await body()).model);
  if (method === "POST" && path === "/api/local-models/load")
    return runtimes.lmStudio.load(modelBody.parse(await body()).model);
  throw new Error("That is not something Branch can do with models on this computer");
}

/** Everything the "Models on this computer" card shows in one request. */
async function overview(deps: LocalModelsDeps) {
  const [inventory, advice] = await Promise.all([deps.runtimes.inventory(), deps.runtimes.recommendations()]);
  return {
    ...inventory,
    hardware: advice.hardware,
    recommendations: advice.models,
    suggested: advice.suggested,
    downloads: deps.runtimes.progress(),
    routing: routingSettings(deps.store, deps.owner),
    lastError: deps.runtimes.lastError,
  };
}

import { adaptFor, continuationFor } from "./host.js";
import { adaptMode, saveAdaptSettings } from "./settings.js";
import type { PressContext } from "../local-one-button.js";
import type { Store } from "../store.js";

/**
 * mac7/adapt: the `/api/adapt` family. Looking describes and changes nothing; the rest is the
 * owner's own step in the app window, which is why every one of these is "owner POST" in the table
 * of what a short-lived key may reach.
 */
export const handlesAdaptPath = (path: string): boolean => path === "/api/adapt" || path.startsWith("/api/adapt/");

export interface AdaptApiDeps {
  store: Store;
  owner: string;
  requireOwner: (what: string) => void;
}

export async function adaptApi(
  deps: AdaptApiDeps, method: string, path: string, body: () => Promise<unknown>, context: PressContext = {},
): Promise<unknown> {
  const { store, owner } = deps;
  if (method === "GET" && path === "/api/adapt")
    return { mode: adaptMode(store, owner), stops: adaptFor(store, owner).stops.waiting() };
  if (method === "POST" && path === "/api/adapt/switch") {
    deps.requireOwner("the /adapt switch");
    return saveAdaptSettings(store, owner, await body());
  }
  if (method === "POST" && path === "/api/adapt/stopped") return adaptFor(store, owner).record(await body());
  if (method === "POST" && path === "/api/adapt/plan") return adaptFor(store, owner).look(await body(), context);
  if (method === "POST" && path === "/api/adapt/go") {
    deps.requireOwner("/adapt");
    const answer = await adaptFor(store, owner).go(await body(), context);
    return { ...answer, carryOn: answer.done && answer.stop ? continuationFor(answer.stop, answer.gained) : "" };
  }
  throw new Error("That is not something Branch can do with /adapt");
}

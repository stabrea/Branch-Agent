import { z } from "zod";
import type { Store } from "./store.js";

/**
 * Issue #105: whether KeepOak shows inside Branch. Off as it ships: no KeepOak entry, no KeepOak
 * window, and nothing is ever sent to keepoak.com. The window itself is the desktop app's
 * (src/desktop/keepoak-view.ts), which asks this before it opens.
 */
export const keepOakKey = "keepoak";
const KeepOakSchema = z.object({ on: z.boolean().default(false) }).strict();

export function keepOakOn(store: Pick<Store, "get">, owner: string): boolean {
  const saved = KeepOakSchema.safeParse(store.get("settings", owner, keepOakKey)?.data ?? {});
  return saved.success ? saved.data.on : false;
}

/** `GET|POST /api/keepoak`: the owner's alone, checked here so the guard moves with the route. */
export async function keepOakRoute(store: Store, owner: string, method: string, body: () => Promise<unknown>): Promise<{ on: boolean }> {
  store.profiles.requireOwner("KeepOak inside Branch");
  if (method === "POST") {
    const { on } = KeepOakSchema.parse(await body());
    store.save("settings", owner, keepOakKey, { on });
    return { on };
  }
  if (method !== "GET") throw new Error("Use GET or POST");
  return { on: keepOakOn(store, owner) };
}

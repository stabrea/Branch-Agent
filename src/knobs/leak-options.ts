import type { Store } from "../store.js";
import type { LeakOptions } from "../leak-guard.js";
import { readKnobs } from "./settings.js";

/** R17-S14: the leak guard's options from the owner's card. A private key is never let through. */
export function leakOptions(store: Pick<Store, "get">, owner: string): LeakOptions {
  const knobs = readKnobs(store, owner, "leakGuard");
  const except = new Set(knobs.exceptions.filter((kind) => kind !== "private key"));
  return { ...(knobs.sensitivity === "strict" ? { strict: true } : {}), ...(except.size ? { except } : {}) };
}

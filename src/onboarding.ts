import type { Store } from "./store.js";
import { demoProviderName } from "./demo.js";
import { noModelProviderName } from "./no-model.js";

/**
 * Dogfood B7: "How should Branch think?" is shown once, and never again once a model works. The owner's "Done" ends
 * it, and so does the first answer from a real model, so the card cannot come back over a conversation with a model
 * that is plainly answering. Neither the stand-in that refuses while no model is set up nor the tests' scripted
 * fixture is a real model, so neither ends it.
 */
export function finishSetupOnFirstAnswer(store: Pick<Store, "get" | "save">, owner: string, provider: string): boolean {
  if (provider === demoProviderName || provider === noModelProviderName) return false;
  const saved = store.get("settings", owner, "onboarding")?.data as { done?: unknown } | undefined;
  if (saved?.done === true) return true;
  try { store.save("settings", owner, "onboarding", { done: true, completedAt: new Date().toISOString() }); return true; }
  catch { return false; } // a refused write leaves the card to the owner's own Done; the answer still stands
}

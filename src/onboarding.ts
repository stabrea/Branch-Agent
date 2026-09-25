import type { Store } from "./store.js";

/**
 * Dogfood B7: "How should Branch think?" is shown once, and never again once a model works. The owner's "Done" ends
 * it, and so does the first answer from a real model (not the offline demonstration), so the card cannot come back
 * over a conversation with a model that is plainly answering.
 */
export function finishSetupOnFirstAnswer(store: Pick<Store, "get" | "save">, owner: string, provider: string): boolean {
  if (provider === "offline-demo-fixture") return false;
  const saved = store.get("settings", owner, "onboarding")?.data as { done?: unknown } | undefined;
  if (saved?.done === true) return true;
  try { store.save("settings", owner, "onboarding", { done: true, completedAt: new Date().toISOString() }); return true; }
  catch { return false; } // a refused write leaves the card to the owner's own Done; the answer still stands
}

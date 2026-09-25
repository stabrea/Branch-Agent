import type { Store } from "./store.js";

const demo = "offline-demo-fixture";

/**
 * Dogfood B7: "How should Branch think?" is shown once, and never again once a model works. The owner's "Done" ends
 * it, and so does the first answer from a real model (not the offline demonstration), so the card cannot come back
 * over a conversation with a model that is plainly answering.
 */
export function finishSetupOnFirstAnswer(store: Pick<Store, "get" | "save">, owner: string, provider: string): boolean {
  if (provider === demo) return false;
  const saved = store.get("settings", owner, "onboarding")?.data as { done?: unknown } | undefined;
  if (saved?.done === true) return true;
  try { store.save("settings", owner, "onboarding", { done: true, completedAt: new Date().toISOString() }); return true; }
  catch { return false; } // a refused write leaves the card to the owner's own Done; the answer still stands
}

/**
 * Dogfood B15: the card came back after an update. An older build left a model that had long been answering but no
 * Done, and B7 only ends setup at the next answer, so the updated window opened on the card. At start, one of the
 * owner's recent finished tasks answered by a real model ends setup the same way (never the offline demonstration).
 */
export function finishSetupFromHistory(store: Pick<Store, "get" | "save" | "runs" | "events">, owner: string): boolean {
  const saved = store.get("settings", owner, "onboarding")?.data as { done?: unknown } | undefined;
  if (saved?.done === true) return true;
  try {
    const answered = store.runs(owner).some((run) => run.status === "completed" && store.events(run.id)
      .some((event) => event.kind === "model.completed" && typeof event.data.provider === "string" && event.data.provider !== demo));
    return answered && finishSetupOnFirstAnswer(store, owner, "history");
  } catch {
    // NAS 82ed54b: a damaged task record never stops Branch from opening; the card shows, and the owner's Done ends it.
    return false;
  }
}

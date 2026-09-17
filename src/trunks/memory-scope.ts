/**
 * R17-004 (T-04): memory per Trunk.
 *
 * Branch's memory already has scopes (src/memory.ts): a fact is private to the owner, shared, or
 * kept for one agent (`agent:<id>`). A Trunk's turn runs with `agent` set to `trunkAgent(id)`, so
 * what it saves is its own and it never reads the owner's private facts. Shared facts are read too,
 * unless the owner switched that off for the Trunk; this list is how src/memory.ts knows.
 *
 * This file imports nothing, so src/memory.ts can read it without a cycle.
 */
const keepsToItself = new Set<string>();

export const trunkAgent = (id: string): string => `trunk:${id}`;

/** Called whenever a Trunk is saved: whether it reads the owner's shared facts. */
export function setSharedFacts(agent: string, reads: boolean): void {
  if (reads) keepsToItself.delete(agent);
  else keepsToItself.add(agent);
}

/**
 * Integrator (R17-A): a Trunk never writes into the shared facts — what it learns is always its own,
 * so nothing it was told can reach the owner's other Trunks and specialists that way.
 */
export function writesSharedFacts(agent: string): boolean {
  return !agent.startsWith("trunk:");
}

/** True when this agent may read a fact the owner marked as shared. */
export function readsSharedFacts(agent: string): boolean {
  return !keepsToItself.has(agent);
}

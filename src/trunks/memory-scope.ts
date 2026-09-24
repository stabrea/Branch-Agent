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

/**
 * FQ-routing.isolated-agents: whose memory a turn reads and writes. `agent` stays the specialist's own id,
 * so everything that looks a specialist up by name still finds it; but a specialist working for a Trunk
 * (`trunk` is carried from the Trunk's turn through every delegation) keeps its facts under that Trunk,
 * `trunk:<id>:<specialist>`, so two Trunks' hand-offs to one specialist never share them. A Trunk's own
 * turn, the owner's specialists and the owner's own turn keep exactly the key they had.
 */
export function memoryAgent(context: { agent?: string | undefined; trunk?: string | undefined }): string | undefined {
  const { agent, trunk } = context;
  // Work a Trunk set going without a turn of its own (a workflow or flow step) remembers as that Trunk.
  if (!agent) return trunk ? trunkAgent(trunk) : undefined;
  if (!trunk || agent.startsWith("trunk:")) return agent;
  return `${trunkAgent(trunk)}:${agent}`;
}

/**
 * Q123: who a look into the owner's conversations, lists and history is for: the turn's own agent, or, for work a
 * Trunk set going without a turn of its own (a workflow's tool step, a flow box), that Trunk. Undefined is the owner.
 */
export function accessAgent(context: { agent?: string | undefined; trunk?: string | undefined }): string | undefined {
  return context.agent ?? (context.trunk ? trunkAgent(context.trunk) : undefined);
}

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
  // A Trunk's specialist (`trunk:<id>:<specialist>`) follows its Trunk's setting.
  return !keepsToItself.has(/^trunk:[^:]+/.exec(agent)?.[0] ?? agent);
}

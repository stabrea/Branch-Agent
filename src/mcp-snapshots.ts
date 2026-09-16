/**
 * A record of exactly what another AI tool was shown.
 *
 * When a client asks for the tool list, Branch can write down the list and the full shape of every
 * tool in it, with a fingerprint, kept against that connection. If the two of them later disagree
 * about what was on offer — "your tool said it took a folder, not a file" — the snapshot settles
 * it, because the fingerprint changes the moment a single word of a description or a schema does.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";

const prefix = "mcp-snapshot:";
/** How many snapshots one owner keeps; the oldest are dropped past this. */
const keep = 50;

export interface SnapshotTool { name: string; description: string; inputSchema: unknown }
export interface McpSnapshot {
  id: string;
  sessionId: string;
  client: string;
  protocolVersion: string;
  at: string;
  /** A sha-256 over the tool list written the same way every time, so two lists compare exactly. */
  digest: string;
  tools: SnapshotTool[];
}

/** The same list always written the same way: sorted by name, with only the parts that matter. */
export function canonicalTools(tools: readonly SnapshotTool[]): string {
  return JSON.stringify(
    [...tools]
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

/** The fingerprint of a tool list. */
export const digestOf = (tools: readonly SnapshotTool[]): string =>
  createHash("sha256").update(canonicalTools(tools)).digest("hex");

const SnapshotSchema = z.object({
  id: z.string(), sessionId: z.string(), client: z.string(), protocolVersion: z.string(),
  at: z.string(), digest: z.string(), tools: z.array(z.object({
    name: z.string(), description: z.string(), inputSchema: z.unknown(),
  })),
}).loose();

/** Writes down the list a client was shown, and returns the record. */
export function recordSnapshot(
  store: Store, owner: string,
  input: { sessionId: string; client: string; protocolVersion: string; tools: readonly SnapshotTool[] },
): McpSnapshot {
  const tools = input.tools.map((tool) => ({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
  }));
  const snapshot: McpSnapshot = {
    id: `${Date.now().toString(36)}-${input.sessionId.slice(0, 16)}`,
    sessionId: input.sessionId, client: input.client, protocolVersion: input.protocolVersion,
    at: new Date().toISOString(), digest: digestOf(tools), tools,
  };
  store.save("governance", owner, prefix + snapshot.id, snapshot as unknown as Record<string, unknown>);
  prune(store, owner);
  return snapshot;
}

function prune(store: Store, owner: string): void {
  const all = listSnapshots(store, owner);
  for (const old of all.slice(keep)) store.delete("governance", owner, prefix + old.id);
}

/** Every snapshot this owner has, newest first. */
export function listSnapshots(store: Store, owner: string): McpSnapshot[] {
  return store.list("governance", owner)
    .filter((record) => record.id.startsWith(prefix))
    .map((record) => SnapshotSchema.safeParse(record.data))
    .flatMap((parsed) => (parsed.success ? [parsed.data as McpSnapshot] : []))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export interface SnapshotComparison {
  id: string;
  /** True when the list on offer now is word for word the one written down. */
  same: boolean;
  digest: string;
  currentDigest: string;
  added: string[];
  removed: string[];
  changed: string[];
  summary: string;
}

/** Compares a saved snapshot with a tool list as it stands now. */
export function compareSnapshot(
  store: Store, owner: string, id: string, tools: readonly SnapshotTool[],
): SnapshotComparison {
  const saved = listSnapshots(store, owner).find((snapshot) => snapshot.id === id);
  if (!saved) throw new Error(`There is no record of a tool list called ${id}.`);
  const before = new Map(saved.tools.map((tool) => [tool.name, canonicalTools([tool])]));
  const after = new Map(tools.map((tool) => [tool.name, canonicalTools([tool])]));
  const added = [...after.keys()].filter((name) => !before.has(name));
  const removed = [...before.keys()].filter((name) => !after.has(name));
  const changed = [...after.keys()].filter((name) => before.has(name) && before.get(name) !== after.get(name));
  const currentDigest = digestOf(tools);
  const same = currentDigest === saved.digest;
  return {
    id, same, digest: saved.digest, currentDigest, added, removed, changed,
    summary: same
      ? "The tools on offer now are exactly the ones written down."
      : `Since that record: ${added.length} added, ${removed.length} gone, ${changed.length} changed.`,
  };
}

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { redactLeaks } from "./leak-guard.js";
import { layerForKind } from "./memory-layers.js";
import { memoryScope, type MemoryRecord } from "./memory.js";
import { normaliseFact } from "./memory-hygiene.js";
import { hiddenPrefix, ownerWords, preferenceSentences, sessionSources, type SessionSource } from "./learning-more/session-lessons.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";

/**
 * memory.cross-agent: bringing a supported host's own session log in as memory, and reading that
 * memory back the way any host adapter does — through the owner's shared facts, never through a
 * fact kept private to a different host.
 *
 * src/learning-more/session-lessons.ts already learns preferences from Claude Code's and Codex's
 * chat files sitting on this computer, by scanning this computer's own copy of them. A host adapter
 * here takes a session log handed to it directly instead, so a log made on one host reaches Branch
 * wherever it is next reached from — pasted into chat, sent over MCP, read from the CLI — without
 * needing that host's folder to be on this computer at all. It is the same two supported hosts, the
 * same `ownerWords` reader (so tagged program text and compaction summaries are cut the same way),
 * and the same sentence rule for what is worth keeping, and the same guard against a sentence the
 * chat reader already hid a key-like value in.
 *
 * What is ingested is saved shared, because a host adapter is only useful if what it brings in can
 * be read back through a different one; a fact meant to stay private to the owner is saved the
 * usual way, through memory.put, and never reaches here.
 */
export const HostIdSchema = z.enum(sessionSources);
export type HostId = SessionSource;
/** The agent identity a host adapter reads and writes under, so store.searchMemory's own scope
 *  rules (src/memory.ts) decide what is permitted, the same way they already do for a Trunk. */
export const hostAgent = (host: HostId): string => `host:${host}`;
const hostLabel: Record<HostId, string> = { "claude-code": "Claude Code", codex: "Codex" };

export const IngestSchema = z.object({
  host: HostIdSchema,
  /** Names this log for provenance; ingesting the same session again imports nothing new. */
  sessionId: z.string().trim().min(1).max(200),
  /** The session log's own text: Claude Code's or Codex's JSON Lines, exactly as that host writes them. */
  text: z.string().min(1).max(4 * 1024 * 1024),
}).strict();
export interface HostIngestReport { host: HostId; imported: number; duplicates: number }

/** Saves what the owner said in a host's session log that reads as a preference, once each, shared with every host. */
export function ingestSessionLog(store: Store, owner: string, input: z.infer<typeof IngestSchema>): HostIngestReport {
  const { host, sessionId, text } = input;
  const known = new Set((store.list("memory", owner) as MemoryRecord[]).map((record) => normaliseFact(String(record.data.text ?? ""))));
  const seenInThisLog = new Set<string>();
  let imported = 0, duplicates = 0;
  for (const sentence of ownerWords(host, text).words.flatMap(preferenceSentences)) {
    // The chat readers already hide key-like values, so a hidden marker counts as a key too (matches
    // session-lessons.ts's own guard: redactLeaks alone cannot find what a reader already redacted).
    const redacted = redactLeaks(sentence);
    const key = normaliseFact(sentence);
    if (!key || seenInThisLog.has(key) || redacted.kinds.length || sentence.includes(hiddenPrefix)) continue;
    seenInThisLog.add(key);
    if (known.has(key)) { duplicates++; continue; }
    store.save("memory", owner, randomUUID(), {
      text: sentence, kind: "preference", layer: layerForKind("preference"), scope: "shared",
      source: `Ingested from a ${hostLabel[host]} session log (session ${sessionId})`,
    });
    known.add(key); imported++;
  }
  return { host, imported, duplicates };
}

/** The same read every host adapter gives: this owner's shared facts, plus whatever this host kept for itself. */
export function readPermittedMemory(store: Store, owner: string, host: HostId, query: string): MemoryRecord[] {
  return store.searchMemory(owner, query, hostAgent(host)) as MemoryRecord[];
}

export function registerMemoryHosts(registry: ToolRegistry, store: Store): void {
  registry.register({
    name: "memory.ingest_host_log",
    description: "Bring in what the owner said in a supported host's own session log (Claude Code or Codex) that reads as a preference. Saved shared, so any host adapter's memory.host_search can read it back.",
    permission: "memory.write", parameters: IngestSchema,
    execute: async (value, context) => ingestSessionLog(store, memoryScope(store, context), value),
  });
  registry.register({
    name: "memory.host_search",
    description: "Read this owner's memory the way one particular host adapter would: shared facts, plus that host's own.",
    permission: "memory.read",
    parameters: z.object({ host: HostIdSchema, query: z.string().max(200) }).strict(),
    execute: async (value, context) => readPermittedMemory(store, memoryScope(store, context), value.host, value.query),
  });
}

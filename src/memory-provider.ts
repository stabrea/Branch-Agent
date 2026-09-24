import { isIP } from "node:net";
import { z } from "zod";
import { redactLeaksIn } from "./leak-guard.js";
import { SecretName } from "./learning-more/providers.js";
import type { MemoryBackend } from "./memory-backend.js";
import { MemoryDataSchema, visibleTo, type MemoryRecord } from "./memory.js";
import { layerOf } from "./memory-layers.js";
import { isPrivateAddress } from "./network-policy.js";
import type { Store } from "./store.js";

// FQ-memory.providers: an outside memory service the owner can switch on to replace the built-in
// SQLite memory, not only sit beside it. src/memory-backend.ts says what any backend must do;
// this file is the one part of Branch that is allowed to reach off this computer to be one.

/** The owner's choice of where saved facts live, kept per profile like every other memory setting. */
export const MemoryProviderSettingsSchema = z.object({
  /** "built-in" is this computer's database, exactly as Branch has always kept facts. */
  mode: z.enum(["built-in", "outside"]).default("built-in"),
  /** The outside service's address. Required once `mode` is "outside"; ignored otherwise. */
  url: z.string().trim().max(500).default(""),
  /** Longest one request to the outside service may take before it is given up on. */
  timeoutMs: z.number().int().min(500).max(30000).default(8000),
  /** The request header the outside service reads its key from, such as "Authorization" or "X-API-Key". */
  header: z.string().trim().max(64).regex(/^[A-Za-z0-9-]*$/, "A header name is letters, digits and dashes only").default("Authorization"),
  /** The name of a key in the locker, never the key itself; its value is sent in `header` on every request. Empty sends none. */
  secret: SecretName.default(""),
}).strict();
export type MemoryProviderSettings = z.infer<typeof MemoryProviderSettingsSchema>;

const settingsKey = "memory-provider";
type Reader = Pick<Store, "get">;

/** The owner's saved choice, or the built-in default when nothing has been saved yet. */
export function memoryProviderSettings(store: Reader, owner: string): MemoryProviderSettings {
  const saved = MemoryProviderSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : MemoryProviderSettingsSchema.parse({});
}

const localSuffixes = [".local", ".internal", ".lan", ".home.arpa"];
const loopback = (host: string): boolean =>
  host === "localhost" || host.endsWith(".localhost") || (isIP(host) === 4 ? host.startsWith("127.") : host === "::1" || host.startsWith("::ffff:127."));

/**
 * Plain http sends every fact, and the key, in the open. It is kept to this computer, or to another
 * computer on the owner's own network once the owner's network rules allow private addresses;
 * anything further away must use https. Returns the reason for a refusal, or nothing.
 */
export function plainHttpRefusal(url: URL, allowPrivate: boolean): string | undefined {
  if (url.protocol !== "http:") return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (loopback(host)) return undefined;
  const onNetwork = isIP(host) ? isPrivateAddress(host) : localSuffixes.some((suffix) => host.endsWith(suffix));
  if (onNetwork && allowPrivate) return undefined;
  return onNetwork
    ? "Plain http to another computer on your network needs private addresses allowed in your network rules. Otherwise use https."
    : "An outside memory service that is not on this computer must use https, so facts and its key are not sent in the open.";
}

const reservedHeaders = new Set(["host", "content-type", "content-length", "connection", "transfer-encoding", "cookie"]);

/** Saves the owner's choice; fields left out keep what was there. Refuses "outside" with no usable address. */
export function saveMemoryProviderSettings(store: Store, owner: string, input: unknown, allowPrivate = false): MemoryProviderSettings {
  const merged = { ...memoryProviderSettings(store, owner), ...(input && typeof input === "object" ? input : {}) };
  const value = MemoryProviderSettingsSchema.parse(merged);
  if (value.secret && !value.header) throw new Error("Say which header the key is sent in");
  if (reservedHeaders.has(value.header.toLowerCase())) throw new Error(`The key cannot be sent in the ${value.header} header`);
  if (value.mode === "outside") {
    if (!value.url) throw new Error("An outside memory service needs an address before it can be switched on");
    let parsed: URL;
    try { parsed = new URL(value.url); } catch { throw new Error("That is not a usable web address"); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("An outside memory service address must be http or https");
    const refusal = plainHttpRefusal(parsed, allowPrivate);
    if (refusal) throw new Error(refusal);
  }
  store.save("settings", owner, settingsKey, value);
  return value;
}

/** One fact exactly as `src/memory-backend.ts` promises the shape will be, plus nothing else. */
const RemoteRecordSchema = z.object({
  id: z.string().min(1).max(200),
  owner: z.string().min(1).max(200),
  data: MemoryDataSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().positive(),
}).strict();

export interface RemoteMemoryConfig {
  /** The outside service's base address, such as "http://localhost:4600". */
  url: string;
  timeoutMs: number;
  /** Already guarded against the owner's network rules; see `MemoryProvider.guardedFetch` below. */
  fetch: typeof fetch;
  /** Whether the owner's network rules allow private addresses, which is what lets plain http reach the local network. */
  allowPrivate: boolean;
  /** The header the key goes in, and the key itself, read from the locker at the moment of each request. */
  auth?: { header: string; key: () => Promise<string> };
}

/**
 * Talks to an outside memory service over plain HTTP, in place of this computer's database. The
 * contract it expects of that service, all under the base address:
 *
 * - `GET  /memory/<owner>`            → 200, a JSON array of facts, newest change first.
 * - `GET  /memory/<owner>/<id>`       → 200, one fact, or 404 when there is none.
 * - `PUT  /memory/<owner>/<id>`       → the fact's data as the JSON body; 200, the saved fact back,
 *   with `createdAt` kept from the earlier version (when there was one) and `revision` moved on by
 *   one, exactly as `src/memory-backend.ts` requires of every backend.
 * - `DELETE /memory/<owner>/<id>`     → 200, `{ "deleted": true|false }`.
 * - `GET  /memory/<owner>/search?q=<query>` → 200, a JSON array of matching facts.
 *
 * Every fact that comes back is parsed against the same schema a fact saved in SQLite must pass, so
 * a service that hands back something malformed is refused rather than fed to the model. Search
 * results are also filtered against `visibleTo` on this side: the service is never trusted alone to
 * keep a delegated specialist from seeing what it should not.
 */
/** A fact the service sent back must be the one asked for: this owner's, and this identifier when one was named. */
function mine(owner: string, record: MemoryRecord, id?: string): MemoryRecord {
  if (record.owner !== owner) throw new Error("The outside memory service sent back a fact that belongs to someone else, so Branch did not use it");
  if (id !== undefined && record.id !== id) throw new Error("The outside memory service sent back a different fact from the one asked for, so Branch did not use it");
  return record;
}
const parseOne = (value: unknown): MemoryRecord => RemoteRecordSchema.parse(value) as MemoryRecord;
const parseMany = (value: unknown): MemoryRecord[] => z.array(RemoteRecordSchema).parse(value) as MemoryRecord[];

export class RemoteMemoryBackend implements MemoryBackend {
  readonly name = "an outside memory service";
  private writeChains = new Map<string, Promise<MemoryRecord>>(); // (owner,id) -> write chain
  constructor(private readonly config: RemoteMemoryConfig) {}
  private base(): string { return this.config.url.replace(/\/+$/, ""); }
  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${this.base()}${path}`;
    const refusal = plainHttpRefusal(new URL(url), this.config.allowPrivate);
    if (refusal) throw new Error(refusal); // checked before anything, the key included, leaves this computer
    const headers: Record<string, string> = {};
    if (this.config.auth) headers[this.config.auth.header] = await this.config.auth.key();
    const controller = new AbortController();
    const init: RequestInit = { method, redirect: "error", signal: controller.signal, headers };
    if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }

    // Create a timeout promise that aborts the controller
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        controller.abort();
        reject(new Error("Request timeout"));
      }, this.config.timeoutMs);
    });

    try {
      // Race the fetch against the timeout
      return await Promise.race([
        this.config.fetch(url, init),
        timeoutPromise,
      ]);
    } catch (error) {
      throw new Error(`The outside memory service could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private async readResponseWithBytesCap(response: Response, byteCap: number = 1024 * 1024): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) return response.json(); // Fallback if no body reader
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.length;
        if (totalBytes > byteCap) {
          throw new Error(`Response body exceeded ${byteCap} bytes limit`);
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const buffer = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(buffer));
  }
  async read(owner: string, id: string): Promise<MemoryRecord | undefined> {
    const response = await this.request("GET", `/memory/${encodeURIComponent(owner)}/${encodeURIComponent(id)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`The outside memory service refused to read a fact (status ${response.status})`);
    return mine(owner, parseOne(await this.readResponseWithBytesCap(response)), id);
  }
  async list(owner: string): Promise<MemoryRecord[]> {
    const response = await this.request("GET", `/memory/${encodeURIComponent(owner)}`);
    if (!response.ok) throw new Error(`The outside memory service refused to list facts (status ${response.status})`);
    return parseMany(await this.readResponseWithBytesCap(response)).map((record) => mine(owner, record));
  }
  async write(owner: string, id: string, data: Record<string, unknown>): Promise<MemoryRecord> {
    const key = `${owner}:${id}`;
    const doWrite = async (): Promise<MemoryRecord> => {
      const checked = MemoryDataSchema.parse(data); // never sends anything off this computer unvalidated
      const clean = redactLeaksIn(checked).value; // remove any accidental secrets before sending to the outside service
      const response = await this.request("PUT", `/memory/${encodeURIComponent(owner)}/${encodeURIComponent(id)}`, clean);
      if (!response.ok) throw new Error(`The outside memory service refused to save a fact (status ${response.status})`);
      return mine(owner, parseOne(await this.readResponseWithBytesCap(response)), id);
    };
    // Serialize writes per fact id to prevent race conditions
    const previousChain = this.writeChains.get(key) ?? Promise.resolve(undefined as unknown);
    const newChain = previousChain.then(() => doWrite(), () => doWrite());
    this.writeChains.set(key, newChain);
    try {
      return await newChain;
    } finally {
      // Clean up the chain once it settles
      if (this.writeChains.get(key) === newChain) {
        this.writeChains.delete(key);
      }
    }
  }
  async search(owner: string, query: string, agent?: string): Promise<MemoryRecord[]> {
    // Redact any secrets from the search query before sending to the outside service
    const { value: cleanQuery } = redactLeaksIn(query);
    const response = await this.request("GET", `/memory/${encodeURIComponent(owner)}/search?q=${encodeURIComponent(cleanQuery)}`);
    if (!response.ok) throw new Error(`The outside memory service refused to search facts (status ${response.status})`);
    const records = parseMany(await this.readResponseWithBytesCap(response)).map((record) => mine(owner, record));
    return records.filter((record) => visibleTo(record, agent));
  }
  async forget(owner: string, id: string): Promise<boolean> {
    const response = await this.request("DELETE", `/memory/${encodeURIComponent(owner)}/${encodeURIComponent(id)}`);
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`The outside memory service refused to forget a fact (status ${response.status})`);
    const body = await this.readResponseWithBytesCap(response).catch(() => ({})) as { deleted?: boolean };
    return body.deleted ?? true;
  }
  async count(owner: string): Promise<number> { return (await this.list(owner)).length; }
}

/** Refuses an address the owner's network settings do not allow. The same guard every outside call in Branch answers to. */
export interface MemoryProviderGuard {
  assertAllowed(url: URL, description: string): Promise<void>;
  settings(): { allowPrivateAddresses: boolean };
}
/** Reads a named key from the locker at the moment it is needed. */
export type MemoryProviderSecret = (name: string) => Promise<string>;
const noLocker: MemoryProviderSecret = async () => { throw new Error("There is no locker to read the outside memory service's key from"); };

/**
 * What the rest of Branch reaches for instead of `SqliteMemoryBackend` directly: on every call it
 * reads the owner's saved choice fresh, so switching providers takes effect at once and needs no
 * restart, and it hands the call to the outside service when one is switched on or to the built-in
 * database otherwise. This one object is both `memory.backend` (the six-method contract every
 * caller can use without knowing which is behind it) and the settings the Memory screen's "Where
 * facts are kept" card reads and saves.
 */
export class MemoryProvider implements MemoryBackend {
  readonly name = "the owner's chosen memory provider";
  private backendCache = new Map<string, RemoteMemoryBackend>(); // config key -> backend instance
  private updateLocks = new Map<string, Promise<unknown>>(); // (owner:id) -> update lock chain
  constructor(
    private readonly store: Store,
    private readonly builtIn: MemoryBackend,
    private readonly guard: MemoryProviderGuard,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly secret: MemoryProviderSecret = noLocker,
  ) {
    // A fact forgotten here stays forgotten even when the outside service failed to delete it too.
    store.sqlite.exec(`CREATE TABLE IF NOT EXISTS memory_outside_forgotten(owner TEXT NOT NULL, id TEXT NOT NULL,
      forgotten_at TEXT NOT NULL, PRIMARY KEY(owner,id))`);
  }
  /** What is switched on right now ("built-in" or "outside"), and the setting behind it, for the Memory screen. */
  view(owner: string): { settings: MemoryProviderSettings; active: MemoryProviderSettings["mode"] } {
    return { settings: memoryProviderSettings(this.store, owner), active: this.isOutside(owner) ? "outside" : "built-in" };
  }
  configure(owner: string, input: unknown): MemoryProviderSettings {
    const result = saveMemoryProviderSettings(this.store, owner, input, this.guard.settings().allowPrivateAddresses);
    // Clear cache when config changes so old backends are dropped
    this.backendCache.clear();
    return result;
  }
  private guardedFetch(): typeof fetch {
    const guard = this.guard, base = this.fetchImpl;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      await guard.assertAllowed(url, "an outside memory service");
      return base(input as RequestInfo, init);
    }) as typeof fetch;
  }
  private current(owner: string): MemoryBackend {
    const settings = memoryProviderSettings(this.store, owner);
    if (settings.mode !== "outside" || !settings.url) {
      // Clear cache when not using outside provider
      return this.builtIn;
    }
    const allowPrivate = this.guard.settings().allowPrivateAddresses;
    const name = settings.secret;
    const configKey = `${settings.url}|${settings.header}|${name}|${settings.timeoutMs}|${allowPrivate}`;

    // Clear cache if the config has changed (keep only the current backend)
    if (this.backendCache.size > 0 && !this.backendCache.has(configKey)) {
      this.backendCache.clear();
    }

    if (this.backendCache.has(configKey)) return this.backendCache.get(configKey)!;
    const backend = new RemoteMemoryBackend({ url: settings.url, timeoutMs: settings.timeoutMs, fetch: this.guardedFetch(),
      allowPrivate,
      ...(name ? { auth: { header: settings.header, key: () => this.secret(name) } } : {}) });
    this.backendCache.set(configKey, backend);
    return backend;
  }
  async withFactLock<T>(owner: string, id: string, fn: () => Promise<T>): Promise<T> {
    const key = `${owner}:${id}`;
    // Ensure we always have a lock promise for this key, atomically creating one if needed
    if (!this.updateLocks.has(key)) {
      this.updateLocks.set(key, Promise.resolve(undefined));
    }
    const currentLock = this.updateLocks.get(key)!;
    const nextLock = currentLock.then(() => fn(), () => fn());
    this.updateLocks.set(key, nextLock);
    try {
      return await nextLock;
    } finally {
      // Clean up the lock once it settles, only if the stored promise is still the one this call set
      if (this.updateLocks.get(key) === nextLock) {
        this.updateLocks.delete(key);
      }
    }
  }
  async read(owner: string, id: string): Promise<MemoryRecord | undefined> {
    if (!this.isOutside(owner)) return this.builtIn.read(owner, id);
    return this.forgotten(owner).has(id) ? undefined : this.current(owner).read(owner, id);
  }
  async list(owner: string): Promise<MemoryRecord[]> {
    if (!this.isOutside(owner)) return this.builtIn.list(owner);
    return this.remembered(owner, await this.current(owner).list(owner));
  }
  write(owner: string, id: string, data: Record<string, unknown>): Promise<MemoryRecord> { return this.current(owner).write(owner, id, data); }
  async search(owner: string, query: string, agent?: string): Promise<MemoryRecord[]> {
    if (!this.isOutside(owner)) return this.builtIn.search(owner, query, agent);
    return this.remembered(owner, await this.current(owner).search(owner, query, agent));
  }
  /** Forgets one fact. On an outside service it is marked forgotten here first, so it never comes back even if the delete fails. */
  async forget(owner: string, id: string): Promise<boolean> {
    if (!this.isOutside(owner)) return this.builtIn.forget(owner, id);
    this.markForgotten(owner, id);
    return this.current(owner).forget(owner, id);
  }
  async count(owner: string): Promise<number> {
    return this.isOutside(owner) ? (await this.list(owner)).length : this.builtIn.count(owner);
  }
  /** True when the owner has an outside service switched on for this owner right now. */
  isOutside(owner: string): boolean {
    const settings = memoryProviderSettings(this.store, owner);
    return settings.mode === "outside" && !!settings.url;
  }

  /** "Forget this conversation", previewed: its facts on this computer and, when one is on, on the outside service. */
  async forgetPreview(owner: string, sessionId: string) {
    const outside = await this.outsideFacts(owner);
    const preview = this.store.forgetMemoryPreview(owner, sessionId, outside.records);
    return outside.problem ? { ...preview, problem: outside.problem } : preview;
  }
  /**
   * "Forget this conversation": removes its facts here and asks the outside service to delete the
   * ones it holds. `removed` counts only what is really gone; anything the service would not delete
   * is listed in `notRemoved` with a plain `problem`, and is never read back from it again.
   */
  async forgetConversation(owner: string, input: unknown) {
    const outside = await this.outsideFacts(owner);
    const { ids, ...result } = this.store.forgetMemory(owner, input, outside.records);
    const held = new Set(outside.records.map((record) => record.id));
    const notRemoved = await this.forgetOutside(owner, ids.filter((id) => held.has(id)));
    const problems = [outside.problem, notRemoved.length ? stillHeld(notRemoved.length) : undefined].filter(Boolean);
    return { ...result, removed: result.removed - notRemoved.length,
      ...(notRemoved.length ? { notRemoved } : {}), ...(problems.length ? { problem: problems.join(" ") } : {}) };
  }
  /** Clears the notes one job made for itself on the outside service, as `Store.clearTaskScratch` does here. */
  async clearOutsideScratch(owner: string, runId: string): Promise<{ cleared: string[]; notRemoved: { id: string; reason: string }[] }> {
    if (!this.isOutside(owner)) return { cleared: [], notRemoved: [] };
    const scratch = (await this.list(owner))
      .filter((record) => layerOf(record) === "task" && String((record.data as { sourceRunId?: string }).sourceRunId ?? "") === runId)
      .map((record) => record.id);
    const notRemoved = await this.forgetOutside(owner, scratch);
    return { cleared: scratch.filter((id) => !notRemoved.some((entry) => entry.id === id)), notRemoved };
  }
  private async outsideFacts(owner: string): Promise<{ records: MemoryRecord[]; problem?: string }> {
    if (!this.isOutside(owner)) return { records: [] };
    try { return { records: await this.list(owner) }; }
    catch (error) {
      return { records: [], problem: `The outside memory service could not be asked what it keeps, so only facts on this computer were included (${error instanceof Error ? error.message : String(error)}).` };
    }
  }
  private async forgetOutside(owner: string, ids: string[]): Promise<{ id: string; reason: string }[]> {
    const notRemoved: { id: string; reason: string }[] = [];
    for (const id of ids) {
      this.markForgotten(owner, id);
      try { await this.current(owner).forget(owner, id); }
      catch (error) { notRemoved.push({ id, reason: error instanceof Error ? error.message : String(error) }); }
    }
    return notRemoved;
  }
  private markForgotten(owner: string, id: string): void {
    this.store.sqlite.prepare("INSERT OR IGNORE INTO memory_outside_forgotten VALUES(?,?,?)").run(owner, id, new Date().toISOString());
  }
  private forgotten(owner: string): Set<string> {
    return new Set(this.store.sqlite.prepare("SELECT id FROM memory_outside_forgotten WHERE owner=?").all(owner).map((row) => String(row.id)));
  }
  private remembered(owner: string, records: MemoryRecord[]): MemoryRecord[] {
    const forgotten = this.forgotten(owner);
    return records.filter((record) => !forgotten.has(record.id));
  }
}

const stillHeld = (count: number): string => `${count === 1 ? "One fact" : `${count} facts`} could not be deleted from the outside memory service and may still be kept there. Branch will not use ${count === 1 ? "it" : "them"} again.`;

/**
 * Test hook: returns the current sizes of internal maps for mutation testing.
 * NOT for production use; gated by non-null check so tree-shaking removes it.
 */
export function memoryProviderTestHook(provider: MemoryProvider): { updateLocksSize: number; backendCacheSize: number } {
  return {
    updateLocksSize: provider["updateLocks"].size,
    backendCacheSize: provider["backendCache"].size,
  };
}

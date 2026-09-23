import { isIP } from "node:net";
import { z } from "zod";
import { SecretName } from "./learning-more/providers.js";
import type { MemoryBackend } from "./memory-backend.js";
import { MemoryDataSchema, visibleTo, type MemoryRecord } from "./memory.js";
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
  constructor(private readonly config: RemoteMemoryConfig) {}
  private base(): string { return this.config.url.replace(/\/+$/, ""); }
  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${this.base()}${path}`;
    const refusal = plainHttpRefusal(new URL(url), this.config.allowPrivate);
    if (refusal) throw new Error(refusal); // checked before anything, the key included, leaves this computer
    const headers: Record<string, string> = {};
    if (this.config.auth) headers[this.config.auth.header] = await this.config.auth.key();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const init: RequestInit = { method, redirect: "error", signal: controller.signal, headers };
    if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    try {
      return await this.config.fetch(url, init);
    } catch (error) {
      throw new Error(`The outside memory service could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    } finally { clearTimeout(timer); }
  }
  async read(owner: string, id: string): Promise<MemoryRecord | undefined> {
    const response = await this.request("GET", `/memory/${encodeURIComponent(owner)}/${encodeURIComponent(id)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`The outside memory service refused to read a fact (status ${response.status})`);
    return mine(owner, parseOne(await response.json()), id);
  }
  async list(owner: string): Promise<MemoryRecord[]> {
    const response = await this.request("GET", `/memory/${encodeURIComponent(owner)}`);
    if (!response.ok) throw new Error(`The outside memory service refused to list facts (status ${response.status})`);
    return parseMany(await response.json()).map((record) => mine(owner, record));
  }
  async write(owner: string, id: string, data: Record<string, unknown>): Promise<MemoryRecord> {
    const checked = MemoryDataSchema.parse(data); // never sends anything off this computer unvalidated
    const response = await this.request("PUT", `/memory/${encodeURIComponent(owner)}/${encodeURIComponent(id)}`, checked);
    if (!response.ok) throw new Error(`The outside memory service refused to save a fact (status ${response.status})`);
    return mine(owner, parseOne(await response.json()), id);
  }
  async search(owner: string, query: string, agent?: string): Promise<MemoryRecord[]> {
    const response = await this.request("GET", `/memory/${encodeURIComponent(owner)}/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error(`The outside memory service refused to search facts (status ${response.status})`);
    const records = parseMany(await response.json()).map((record) => mine(owner, record));
    return records.filter((record) => visibleTo(record, agent));
  }
  async forget(owner: string, id: string): Promise<boolean> {
    const response = await this.request("DELETE", `/memory/${encodeURIComponent(owner)}/${encodeURIComponent(id)}`);
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`The outside memory service refused to forget a fact (status ${response.status})`);
    const body = await response.json().catch(() => ({})) as { deleted?: boolean };
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
  constructor(
    private readonly store: Store,
    private readonly builtIn: MemoryBackend,
    private readonly guard: MemoryProviderGuard,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly secret: MemoryProviderSecret = noLocker,
  ) {}
  /** What is switched on right now ("built-in" or "outside"), and the setting behind it, for the Memory screen. */
  view(owner: string): { settings: MemoryProviderSettings; active: MemoryProviderSettings["mode"] } {
    return { settings: memoryProviderSettings(this.store, owner), active: this.isOutside(owner) ? "outside" : "built-in" };
  }
  configure(owner: string, input: unknown): MemoryProviderSettings {
    return saveMemoryProviderSettings(this.store, owner, input, this.guard.settings().allowPrivateAddresses);
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
    if (settings.mode !== "outside" || !settings.url) return this.builtIn;
    const name = settings.secret;
    return new RemoteMemoryBackend({ url: settings.url, timeoutMs: settings.timeoutMs, fetch: this.guardedFetch(),
      allowPrivate: this.guard.settings().allowPrivateAddresses,
      ...(name ? { auth: { header: settings.header, key: () => this.secret(name) } } : {}) });
  }
  read(owner: string, id: string): Promise<MemoryRecord | undefined> { return this.current(owner).read(owner, id); }
  list(owner: string): Promise<MemoryRecord[]> { return this.current(owner).list(owner); }
  write(owner: string, id: string, data: Record<string, unknown>): Promise<MemoryRecord> { return this.current(owner).write(owner, id, data); }
  search(owner: string, query: string, agent?: string): Promise<MemoryRecord[]> { return this.current(owner).search(owner, query, agent); }
  forget(owner: string, id: string): Promise<boolean> { return this.current(owner).forget(owner, id); }
  count(owner: string): Promise<number> { return this.current(owner).count(owner); }
  /** True when the owner has an outside service switched on for this owner right now. */
  isOutside(owner: string): boolean {
    const settings = memoryProviderSettings(this.store, owner);
    return settings.mode === "outside" && !!settings.url;
  }
}

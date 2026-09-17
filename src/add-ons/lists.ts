import { createHash, createPublicKey, sign as signBytes, verify as verifyBytes, type KeyObject } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { NetworkPolicy } from "../network-policy.js";
import type { Store } from "../store.js";
import type { AddOnRecord, AddOnShelf } from "./package-shelf.js";
import { slug } from "./formats.js";

/**
 * Bucket 15 (A0022, A2045): add-on lists — the "marketplace", as the owner's own choice of where
 * to look, never a shop Branch opens by itself.
 *
 * A list is one of two things the owner names:
 *   - a web address serving a Branch add-on list: each entry points at one package file with its
 *     fingerprint, and a list may publish a signing key so each entry can be checked;
 *   - a folder on this computer holding a Claude Code or Codex marketplace (`.claude-plugin/marketplace.json`,
 *     `.agents/plugins/marketplace.json` or `marketplace.json`), whose entries point at folders inside it.
 *
 * Looking at a list installs nothing. Installing an entry goes through the same shelf as any package:
 * the fingerprint must match, a signature that does not match stops it, outside servers are looked
 * up in the malware list, and it arrives switched off. Newer versions are only offered; taking one
 * is the owner's action, and the new version arrives switched off too.
 */
const Entry = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000).default(""),
  version: z.string().max(40).default("1"),
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().max(200).optional(),
  changelog: z.string().max(2000).optional(),
}).strict();
export type AddOnListEntry = z.infer<typeof Entry>;
export const AddOnListSchema = z.object({
  format: z.literal("branch-addon-list"),
  version: z.literal(1),
  name: z.string().trim().min(1).max(120),
  publicKey: z.string().max(200).optional(),
  addOns: z.array(Entry).max(500),
}).strict();
export type AddOnList = z.infer<typeof AddOnListSchema>;

export interface ListedAddOn {
  id: string; name: string; description: string; version: string;
  /** "checked" (signed with the list's key), "unsigned", "invalid", or "local" for a folder. */
  signed: "checked" | "unsigned" | "invalid" | "local";
  installable: boolean; note: string;
}
const maxIndexBytes = 512 * 1024, maxPackageBytes = 1024 * 1024;
const localIndexes = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json", "marketplace.json"];

export function listSigningPayload(listName: string, entry: Pick<AddOnListEntry, "id" | "version" | "sha256">): Buffer {
  return Buffer.from(["branch-addon-list", listName, entry.id, entry.version, entry.sha256].join("\n"), "utf8");
}
export function signListEntry(privateKey: KeyObject, listName: string, entry: Pick<AddOnListEntry, "id" | "version" | "sha256">): string {
  return signBytes(null, listSigningPayload(listName, entry), privateKey).toString("base64");
}
export function verifyListEntry(list: AddOnList, entry: AddOnListEntry): "checked" | "unsigned" | "invalid" {
  if (!list.publicKey || !entry.signature) return "unsigned";
  try {
    const key = createPublicKey({ key: Buffer.from(list.publicKey, "base64"), format: "der", type: "spki" });
    return verifyBytes(null, listSigningPayload(list.name, entry), key, Buffer.from(entry.signature, "base64")) ? "checked" : "invalid";
  } catch { return "invalid"; }
}

interface LocalEntry { name: string; description: string; version: string; folder: string | null; note: string }

/** Reads a Claude Code or Codex marketplace in a folder; only entries inside that folder can be installed. */
async function readLocalList(root: string): Promise<{ name: string; entries: LocalEntry[] }> {
  for (const name of localIndexes) {
    const text = await readFile(join(root, name), "utf8").catch(() => null);
    if (text === null) continue;
    const raw = JSON.parse(text) as { name?: unknown; plugins?: unknown };
    const plugins = Array.isArray(raw.plugins) ? raw.plugins.slice(0, 200) as Record<string, unknown>[] : [];
    const entries = await Promise.all(plugins.map((plugin) => localEntry(root, plugin)));
    return { name: typeof raw.name === "string" ? raw.name.slice(0, 120) : root, entries };
  }
  throw new Error("That folder holds no add-on list (.claude-plugin/marketplace.json, .agents/plugins/marketplace.json or marketplace.json).");
}

async function localEntry(root: string, plugin: Record<string, unknown>): Promise<LocalEntry> {
  const name = typeof plugin.name === "string" ? plugin.name.slice(0, 80) : "unnamed";
  const base = { name, description: typeof plugin.description === "string" ? plugin.description.slice(0, 1000) : "",
    version: typeof plugin.version === "string" ? plugin.version.slice(0, 40) : "1" };
  const source = typeof plugin.source === "string" ? plugin.source
    : plugin.source && typeof plugin.source === "object" && (plugin.source as Record<string, unknown>).source === "local"
      ? String((plugin.source as Record<string, unknown>).path ?? "") : null;
  if (!source) return { ...base, folder: null, note: "It is kept somewhere else (a git address). Fetch it yourself and install it from its folder." };
  const folder = resolve(root, source);
  const inside = relative(root, folder);
  if (inside.startsWith("..") || isAbsolute(inside)) return { ...base, folder: null, note: "It points outside the list's folder, so it is not offered." };
  const info = await lstat(folder).catch(() => null);
  if (!info?.isDirectory()) return { ...base, folder: null, note: "Its folder is missing." };
  return { ...base, folder, note: "" };
}

export class AddOnLists {
  constructor(private readonly store: Store, private readonly owner: string, private readonly shelf: AddOnShelf,
    private readonly policy: NetworkPolicy, private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  private key(address: string): string { return `add-on-list:${createHash("sha256").update(address).digest("hex").slice(0, 16)}`; }
  /** The lists the owner has looked at. */
  saved(): { address: string; name: string }[] {
    return this.store.list("settings", this.owner).filter((row) => row.id.startsWith("add-on-list:"))
      .map((row) => row.data as { address: string; name: string });
  }
  forget(address: string): { removed: boolean } { return { removed: this.store.delete("settings", this.owner, this.key(address)) }; }

  private async fetchText(url: string, limit: number): Promise<Buffer> {
    const target = new URL(url);
    if (target.protocol !== "https:") throw new Error("An add-on list on the web must use https.");
    await this.policy.assertAllowed(target, "add-on list address");
    const response = await this.fetchImpl(target, { redirect: "error", signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`The list did not answer (HTTP ${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error("The answer is larger than an add-on list may send.");
    return bytes;
  }
  private async remote(address: string): Promise<AddOnList> {
    return AddOnListSchema.parse(JSON.parse((await this.fetchText(address, maxIndexBytes)).toString("utf8")));
  }

  /** What a list offers. Nothing is installed by looking. */
  async browse(address: string): Promise<{ name: string; address: string; addOns: ListedAddOn[] }> {
    const installed = new Set(this.shelf.list().map((record) => record.id));
    let name: string, addOns: ListedAddOn[];
    if (isAbsolute(address)) {
      const local = await readLocalList(address);
      name = local.name;
      addOns = local.entries.map((entry) => ({ id: entry.name, name: entry.name, description: entry.description, version: entry.version,
        signed: "local", installable: entry.folder !== null && !installed.has(slug(entry.name)), note: entry.note }));
    } else {
      const list = await this.remote(address);
      name = list.name;
      addOns = list.addOns.map((entry) => {
        const signed = verifyListEntry(list, entry);
        return { id: entry.id, name: entry.name, description: entry.description, version: entry.version, signed,
          installable: signed !== "invalid" && !installed.has(entry.id),
          note: signed === "invalid" ? "Its signature does not match the list's key, so it cannot be installed." : signed === "unsigned" ? "It is not signed." : "" };
      });
    }
    this.store.save("settings", this.owner, this.key(address), { address, name });
    return { name, address, addOns };
  }

  /** Fetches and checks one entry, leaving it in a folder or file the shelf can read. */
  private async prepare(address: string, entryId: string): Promise<{ source: string; origin: NonNullable<AddOnRecord["origin"]>; done: () => Promise<void> }> {
    if (isAbsolute(address)) {
      const local = await readLocalList(address);
      const entry = local.entries.find((candidate) => candidate.name === entryId);
      if (!entry?.folder) throw new Error(entry ? entry.note : `The list has no add-on called ${entryId}.`);
      return { source: entry.folder, origin: { list: address, entry: entryId, version: entry.version }, done: async () => undefined };
    }
    const list = await this.remote(address);
    const entry = list.addOns.find((candidate) => candidate.id === entryId);
    if (!entry) throw new Error(`The list "${list.name}" has no add-on called ${entryId}.`);
    if (verifyListEntry(list, entry) === "invalid") throw new Error("The list's signature for this add-on does not match its key, so it was not installed.");
    const bytes = await this.fetchText(entry.url, maxPackageBytes);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error("The package does not match the fingerprint the list published, so it was not installed.");
    const staging = await mkdtemp(join(tmpdir(), "branch-addon-list-"));
    const source = join(staging, "package.zip");
    await writeFile(source, bytes);
    return { source, origin: { list: address, entry: entryId, version: entry.version },
      done: () => rm(staging, { recursive: true, force: true }) };
  }

  /** Installs one entry, switched off, through the shelf. */
  async install(address: string, entryId: string, expectSha256?: string): Promise<AddOnRecord> {
    const prepared = await this.prepare(address, entryId);
    try {
      return await this.shelf.install(prepared.source, { origin: prepared.origin, ...(expectSha256 ? { expectSha256 } : {}) });
    } finally { await prepared.done(); }
  }

  /** Newer versions of installed add-ons, offered and never taken. */
  async updates(): Promise<{ id: string; from: string; to: string; list: string }[]> {
    const found: { id: string; from: string; to: string; list: string }[] = [];
    for (const record of this.shelf.list()) {
      if (!record.origin) continue;
      const listed = await this.browse(record.origin.list).catch(() => null);
      const entry = listed?.addOns.find((candidate) => candidate.id === record.origin!.entry);
      if (entry && entry.signed !== "invalid" && entry.version !== record.origin.version)
        found.push({ id: record.id, from: record.origin.version, to: entry.version, list: listed!.name });
    }
    return found;
  }

  /** Takes the newer version the owner chose: checked first, then the old one goes and the new one arrives switched off. */
  async update(id: string): Promise<AddOnRecord> {
    const record = this.shelf.record(id);
    if (!record?.origin) throw new Error("This add-on did not come from a list.");
    const prepared = await this.prepare(record.origin.list, record.origin.entry);
    try {
      const look = await this.shelf.look(prepared.source);
      if (look.offer.id !== id) throw new Error("The newer version calls itself something else, so nothing was changed.");
      const malware = look.malware.find((verdict) => verdict.refused);
      if (malware) throw new Error(malware.refused!);
      await this.shelf.remove(id);
      return await this.shelf.install(prepared.source, { origin: prepared.origin });
    } finally { await prepared.done(); }
  }
}

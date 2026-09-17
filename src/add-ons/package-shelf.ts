import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Store } from "../store.js";
import type { Plugins } from "../plugins.js";
import { PluginManifestSchema } from "../plugins.js";
import { readOffer, readPackageFolder, readPackageSource, sha256, type AddOnOffer, type AddOnServer } from "./formats.js";
import type { FilterBook } from "./filters.js";

/**
 * Bucket 15: the shelf of add-on packages — looked at first, copied in only on a yes, and switched
 * on only by a second, separate yes.
 *
 *   look      reads the package and says, in plain words, everything it would add and everything it
 *             would need, with each outside server it names looked up in the malware list. Nothing is
 *             copied and nothing is run.
 *   install   copies the files in, with a fingerprint for each, and switches nothing on.
 *   switch on its skills are added (and scanned, as every skill is), its plugin file joins the plugins
 *             list and runs walled (src/add-ons/walled-plugin.ts), its filters arrive switched off,
 *             and its outside servers are handed back as a draft to try in Connections — Branch
 *             never connects one on a package's say-so.
 *   switch off / remove   take it all back out; a plugin file changed by hand is left where it is.
 *
 * A package can only ask; the owner's rules decide. Anything whose fingerprint changed since it was
 * installed is refused, and nothing here is updated or installed by itself.
 */
export interface AddOnRecord {
  id: string; name: string; version: string; format: AddOnOffer["format"]; description: string; author: string;
  source: string; sha256: string; files: Record<string, string>; installedAt: string;
  enabled: boolean;
  skills: { name: string; description: string; skillId?: string }[];
  servers: AddOnServer[];
  plugin: { file: string; sha256: string; permissions: string[]; hosts: string[] } | null;
  filters: string[];
  leftOut: string[];
  /** Where it came from when it was installed from a list (src/add-ons/lists.ts). */
  origin?: { list: string; entry: string; version: string };
  bundled?: boolean;
}
export interface MalwareVerdict { server: string; refused: string | null }
export interface AddOnLook { offer: Omit<AddOnOffer, "plugin"> & { plugin: { file: string; permissions: string[]; hosts: string[] } | null }; needs: string[]; malware: MalwareVerdict[]; refused: string | null }

export interface ShelfOptions {
  store: Store; owner: string; dataDir: string; plugins: Plugins; filters: FilterBook;
  /** The malware check on programs fetched from a package registry (src/security-audit/malware-check.ts). */
  vet: (command: string, args: readonly string[]) => Promise<void>;
  bundledDir?: string;
}

const recordKey = (id: string): string => `add-on:${id}`;
/** Copied next to the built program by scripts/copy-data.mjs, from data/add-ons in the repository. */
export const bundledAddOns = fileURLToPath(new URL("../bundled-add-ons/", import.meta.url));
const serverLine = (server: AddOnServer): string => server.transport === "stdio"
  ? `start the program "${[server.command, ...server.args].join(" ").slice(0, 200)}"${server.envKeys.length ? ` with your ${server.envKeys.join(", ")}` : ""}`
  : `connect to ${server.url}`;

/** Everything a package would add or need, in the sentences the owner reads before saying yes. */
export function needsOf(offer: AddOnOffer): string[] {
  const needs: string[] = [];
  if (offer.skills.length) needs.push(`Adds ${offer.skills.length} skill${offer.skills.length === 1 ? "" : "s"} (${offer.skills.map((s) => s.name).join(", ")}): instructions the assistant reads when a task calls for them. Each is scanned first.`);
  if (offer.plugin) needs.push(`Runs code (${offer.plugin.file}) in its own walled program, never inside Branch. It asks for: ${offer.plugin.permissions.join(", ") || "nothing"}. It may reach: ${offer.plugin.hosts.join(", ") || "no web address"}.`);
  for (const server of offer.servers) needs.push(`Would ${serverLine(server)} as an outside server — only if you add it yourself under Connections.`);
  if (offer.filters.length) needs.push(`Brings ${offer.filters.length} filter${offer.filters.length === 1 ? "" : "s"}, switched off until you switch them on.`);
  if (!needs.length) needs.push("Adds nothing Branch can use.");
  return needs;
}

export class AddOnShelf {
  constructor(private readonly options: ShelfOptions) {}
  private get store(): Store { return this.options.store; }
  private get owner(): string { return this.options.owner; }
  private folder(id: string): string { return join(this.options.dataDir, "add-ons", id); }
  private pluginFile(id: string): string { return join(this.options.dataDir, "plugins", `${id}.mjs`); }

  record(id: string): AddOnRecord | null {
    return (this.store.get("settings", this.owner, recordKey(id))?.data as AddOnRecord | undefined) ?? null;
  }
  private save(record: AddOnRecord): AddOnRecord {
    this.store.save("settings", this.owner, recordKey(record.id), { ...record });
    return record;
  }
  list(): AddOnRecord[] {
    return this.store.list("settings", this.owner).filter((row) => row.id.startsWith("add-on:"))
      .map((row) => row.data as unknown as AddOnRecord).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Each outside server looked up in the malware list; a listed one stops the package. */
  private async malware(servers: readonly AddOnServer[]): Promise<MalwareVerdict[]> {
    const verdicts: MalwareVerdict[] = [];
    for (const server of servers) {
      if (server.transport !== "stdio") { verdicts.push({ server: server.id, refused: null }); continue; }
      const refused = await this.options.vet(server.command, server.args).then(() => null, (error: unknown) => error instanceof Error ? error.message : String(error));
      verdicts.push({ server: server.id, refused });
    }
    return verdicts;
  }

  async look(source: string): Promise<AddOnLook> {
    const offer = readOffer(await readPackageSource(source));
    return this.lookAt(offer);
  }
  private async lookAt(offer: AddOnOffer): Promise<AddOnLook> {
    const malware = await this.malware(offer.servers);
    const listed = malware.find((verdict) => verdict.refused);
    const { plugin, ...rest } = offer;
    return { offer: { ...rest, plugin: plugin ? { file: plugin.file, permissions: plugin.permissions, hosts: plugin.hosts } : null },
      needs: needsOf(offer), malware, refused: listed?.refused ?? this.clash(offer) };
  }
  /** A package may not take the place of an add-on or a plugin that is already there. */
  private clash(offer: AddOnOffer): string | null {
    if (this.record(offer.id)) return `An add-on called ${offer.id} is already installed. Remove it first to install this one.`;
    return null;
  }

  /** Copies the package in, switched off. `expectSha256` must be the fingerprint the owner was shown. */
  async install(source: string, options: { expectSha256?: string; origin?: AddOnRecord["origin"]; bundled?: boolean } = {}): Promise<AddOnRecord> {
    const files = await readPackageSource(source);
    const offer = readOffer(files);
    if (options.expectSha256 && options.expectSha256 !== offer.sha256)
      throw new Error("The package is not the one you were shown, so it was not installed.");
    const look = await this.lookAt(offer);
    if (look.refused) throw new Error(look.refused);
    if (offer.plugin) {
      PluginManifestSchema.shape.id.parse(offer.id);
      const present = await lstat(this.pluginFile(offer.id)).then(() => true, () => false);
      if (present) throw new Error(`There is already a plugin file called ${offer.id}.mjs, so this package was not installed.`);
    }
    await this.writeFiles(offer.id, files);
    if (offer.plugin) await this.writePlugin(offer, source);
    const record: AddOnRecord = {
      id: offer.id, name: offer.name, version: offer.version, format: offer.format, description: offer.description, author: offer.author,
      source, sha256: offer.sha256, files: offer.files, installedAt: new Date().toISOString(), enabled: false,
      skills: offer.skills.map((skill) => ({ name: skill.name, description: skill.description })),
      servers: offer.servers, filters: offer.filters.map((rule) => rule.id), leftOut: offer.leftOut,
      plugin: offer.plugin ? { file: offer.plugin.file, sha256: sha256(offer.plugin.code), permissions: offer.plugin.permissions, hosts: offer.plugin.hosts } : null,
      ...(options.origin ? { origin: options.origin } : {}), ...(options.bundled ? { bundled: true } : {}),
    };
    return this.save(record);
  }
  private async writeFiles(id: string, files: ReadonlyMap<string, string>): Promise<void> {
    const root = this.folder(id);
    await rm(root, { recursive: true, force: true });
    for (const [name, body] of files) {
      const target = join(root, ...name.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body, "utf8");
    }
  }
  private async writePlugin(offer: AddOnOffer, source: string): Promise<void> {
    const plugin = offer.plugin!;
    await mkdir(dirname(this.pluginFile(offer.id)), { recursive: true });
    await writeFile(this.pluginFile(offer.id), plugin.code, { encoding: "utf8", flag: "wx" });
    // The plugin catalog's record, so the security check sees a fingerprinted plugin.
    this.store.save("settings", this.owner, `plugin-catalog:${offer.id}`, { id: offer.id, name: offer.name, description: offer.description,
      version: offer.version, permissions: plugin.permissions, sha256: sha256(plugin.code), source, installedAt: new Date().toISOString() });
  }

  /** Whether a package's copied files are still what was installed. */
  async unchanged(record: AddOnRecord): Promise<boolean> {
    const files = await readPackageFolder(this.folder(record.id)).catch(() => null);
    if (!files || files.size !== Object.keys(record.files).length) return false;
    for (const [name, body] of files) if (record.files[name] !== sha256(body)) return false;
    if (!record.plugin) return true;
    const code = await readFile(this.pluginFile(record.id), "utf8").catch(() => null);
    return code !== null && sha256(code) === record.plugin.sha256;
  }

  /** What the walled loader needs to know about one plugin id. */
  pluginPolicy(id: string): { hosts: string[]; installed: boolean } | null {
    const record = this.record(id);
    return record?.plugin ? { hosts: record.plugin.hosts, installed: true } : null;
  }

  async switchOn(id: string, allow?: readonly string[]): Promise<{ record: AddOnRecord; notes: string[]; serverDrafts: AddOnServer[] }> {
    const record = this.record(id);
    if (!record) throw new Error(`There is no add-on called ${id}.`);
    if (!(await this.unchanged(record))) throw new Error(`The files of ${id} are not what they were when you installed it, so it was not switched on. Remove it and install it again.`);
    const listed = (await this.malware(record.servers)).find((verdict) => verdict.refused);
    if (listed) throw new Error(listed.refused!);
    const files = await readPackageFolder(this.folder(id));
    const offer = readOffer(files);
    const notes = [...record.leftOut];
    const skills = this.addSkills(offer, notes);
    if (record.plugin) {
      // The owner's yes can narrow what the package asked for, never add to it.
      const asked = record.plugin.permissions;
      const summary = await this.options.plugins.enable(id, allow ? allow.filter((permission) => asked.includes(permission)) : asked);
      notes.push(...(summary.leftOut ?? []));
    }
    if (offer.filters.length) this.options.filters.adopt(`add-on:${id}`, offer.filters);
    const next = this.save({ ...record, enabled: true, skills });
    if (record.servers.length) notes.push("Its outside servers are not connected. Try each one in Customize, Connections, and add it there if you want it.");
    return { record: next, notes, serverDrafts: record.servers };
  }
  private addSkills(offer: AddOnOffer, notes: string[]): AddOnRecord["skills"] {
    return offer.skills.map((skill) => {
      try {
        const installed = this.store.skills.install(this.owner, { document: skill.document });
        if (installed.activeVersion === null) notes.push(`The skill ${skill.name} needs your review in Skills before it is used.`);
        return { name: skill.name, description: skill.description, skillId: installed.id };
      } catch (error) {
        notes.push(`The skill ${skill.name} was not added: ${error instanceof Error ? error.message : String(error)}`);
        return { name: skill.name, description: skill.description };
      }
    });
  }

  switchOff(id: string): AddOnRecord {
    const record = this.record(id);
    if (!record) throw new Error(`There is no add-on called ${id}.`);
    if (record.plugin) this.options.plugins.disable(id);
    for (const skill of record.skills) {
      if (!skill.skillId) continue;
      try { this.store.skills.remove(this.owner, skill.skillId, { expectedRevision: this.store.skills.view(this.owner, skill.skillId).revision }); }
      catch { /* already gone */ }
    }
    this.options.filters.forget(`add-on:${id}`);
    return this.save({ ...record, enabled: false, skills: record.skills.map(({ name, description }) => ({ name, description })) });
  }

  async remove(id: string): Promise<{ removed: boolean; kept: string[] }> {
    const record = this.record(id);
    if (!record) return { removed: false, kept: [] };
    this.switchOff(id);
    const kept: string[] = [];
    if (record.plugin) {
      const code = await readFile(this.pluginFile(id), "utf8").catch(() => null);
      if (code !== null && sha256(code) === record.plugin.sha256) await rm(this.pluginFile(id), { force: true });
      else if (code !== null) kept.push(`${id}.mjs was changed after it was installed, so it was left in the plugins folder.`);
      this.store.delete("settings", this.owner, `plugin-catalog:${id}`);
      this.store.delete("settings", this.owner, `plugin:${id}`);
    }
    await rm(this.folder(id), { recursive: true, force: true });
    this.store.delete("settings", this.owner, recordKey(id));
    return { removed: true, kept };
  }

  /** The add-ons that come with Branch, looked at in place; installing one is still a yes. */
  async bundled(): Promise<AddOnLook[]> {
    const root = this.options.bundledDir ?? bundledAddOns;
    const names = await readdir(root).catch(() => [] as string[]);
    const looks: AddOnLook[] = [];
    for (const name of names.sort()) looks.push(await this.look(join(root, name)).catch(() => null) as AddOnLook);
    return looks.filter(Boolean);
  }
  async installBundled(id: string, expectSha256?: string): Promise<AddOnRecord> {
    const root = this.options.bundledDir ?? bundledAddOns;
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(id)) throw new Error("There is no add-on by that name.");
    return this.install(join(root, id), { bundled: true, ...(expectSha256 ? { expectSha256 } : {}) });
  }
}

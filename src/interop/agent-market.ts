import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { agentManifestEntry, exportAgent, importAgent, openAgent, type AgentImportReport, type AgentSection, type OpenedAgent } from "../agent-export.js";
import { audit } from "../audit.js";
import type { WorkspaceFiles } from "../files.js";
import type { NetworkPolicy } from "../network-policy.js";
import { zipWrite } from "../skill-package.js";
import type { Store } from "../store.js";
import { requireInterop } from "./settings.js";

/**
 * Sharing and bringing in whole assistants. A market is a plain JSON list somebody publishes (the
 * owner's own, a team's or a public one) naming assistant files made by "Export the assistant",
 * each with its fingerprint. Browsing installs nothing. Bringing one in fetches its file, checks the
 * fingerprint and every part against the file's own manifest, and brings in only the parts chosen
 * — and only the parts that cannot widen anything: specialists, saved procedures and skills. Rules
 * about what needs a yes, which model does what, and memory never come from a market. Skills that
 * arrive are switched off until the owner switches them on, as they are from a skill registry.
 *
 * Publishing writes the file and the list into a folder in the workspace, ready to be put on any web
 * server; nothing is uploaded from here. The idea is AutoGPT's agent marketplace; this is an
 * independent implementation over Branch's own export format.
 */
export const shareableSections = ["specialists", "procedures", "skills"] as const satisfies readonly AgentSection[];
export type Shareable = (typeof shareableSections)[number];
const maxIndexBytes = 256 * 1024;
const maxPackageBytes = 16 * 1024 * 1024;
const indexesKey = "interop-market-indexes";

const EntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/),
  name: z.string().trim().min(1).max(80),
  summary: z.string().max(500).default(""),
  author: z.string().max(80).default(""),
  version: z.string().max(40).default(""),
  /** Where the file is; relative to the list's own address when it is not a full address. */
  url: z.string().min(1).max(2000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sections: z.array(z.string().max(20)).max(6).default([]),
}).strict();
export const MarketIndexSchema = z.object({
  format: z.literal("branch-agent-market"),
  version: z.literal(1),
  name: z.string().trim().min(1).max(80),
  agents: z.array(EntrySchema).max(500),
}).strict();
export type MarketIndex = z.infer<typeof MarketIndexSchema>;
export type MarketEntry = z.infer<typeof EntrySchema>;

export const PublishSchema = z.object({
  /** A folder inside the workspace, such as "market". */
  folder: z.string().trim().min(1).max(200),
  id: EntrySchema.shape.id,
  name: EntrySchema.shape.name,
  summary: EntrySchema.shape.summary,
  author: EntrySchema.shape.author,
  version: EntrySchema.shape.version,
  sections: z.array(z.enum(shareableSections)).min(1).max(3).default([...shareableSections]),
  marketName: z.string().trim().min(1).max(80).default("My assistants"),
}).strict();

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

/** Only the shareable parts of an exported assistant, as a new file with its own manifest. */
export function shareablePackage(bytes: Buffer, sections: readonly Shareable[]): Buffer {
  const opened = openAgent(bytes);
  const kept = opened.manifest.sections.filter((s) => (sections as readonly string[]).includes(s.name));
  const manifest = { ...opened.manifest, sections: kept, memoryRedacted: false };
  return zipWrite([[agentManifestEntry, JSON.stringify(manifest, null, 1)], ...kept.map((s): [string, string] => [s.file, opened.files.get(s.file)!])]);
}

const tooMuch = (): Error => new Error("The market sent more than an assistant file may be");

/** Reads a response body, stopping as soon as it passes `limit` rather than after holding all of it. */
export async function readCapped(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length") ?? 0) > limit) throw tooMuch();
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    total += part.value.byteLength;
    if (total > limit) { await reader.cancel().catch(() => undefined); throw tooMuch(); }
    chunks.push(Buffer.from(part.value));
  }
  return Buffer.concat(chunks);
}

/**
 * The opened file with every specialist and saved procedure whose id is already one of yours taken
 * out, so a market adds to what you have and never quietly rewrites it. Returns how many were kept.
 */
function withoutYours(store: Store, owner: string, opened: OpenedAgent): { opened: OpenedAgent; kept: number } {
  const files = new Map(opened.files);
  let kept = 0;
  for (const section of opened.manifest.sections) {
    const table = section.name;
    if (table !== "specialists" && table !== "procedures") continue;
    const rows = JSON.parse(files.get(section.file) ?? "[]") as unknown;
    if (!Array.isArray(rows)) continue;
    const fresh = rows.filter((row) => {
      const id = (row as { id?: unknown } | null)?.id;
      const mine = typeof id === "string" && store.get(table, owner, id) !== undefined;
      if (mine) kept++;
      return !mine;
    });
    files.set(section.file, JSON.stringify(fresh));
  }
  return { opened: { ...opened, files }, kept };
}

/**
 * An assistant file that has already been opened (every part checked against its fingerprint),
 * brought in under a market's rules: only specialists, saved procedures and skills, never one of
 * yours rewritten, and every new skill switched off. Also used for an installer's `--assistant` file.
 */
export function bringInShareable(store: Store, owner: string, opened: OpenedAgent, chosen: readonly Shareable[],
  label: { subject: string; from: string }): AgentImportReport[] {
  const sections = shareableSections.filter((name) => chosen.includes(name));
  const before = new Set(store.skills.list(owner).map((s) => s.id));
  const trimmed = withoutYours(store, owner, opened);
  const reports = importAgent(store, owner, trimmed.opened, sections);
  if (trimmed.kept) reports.push({ section: "specialists", brought: 0, note: `kept yours: ${trimmed.kept} with a name you already use were left out` });
  for (const skill of store.skills.list(owner))
    if (!before.has(skill.id) && skill.activeVersion !== null)
      store.skills.disable(owner, skill.id, { expectedRevision: skill.revision });
  audit(store, owner, { action: "data.imported", actor: owner, subject: label.subject,
    reason: `${label.from}: ${sections.join(", ")}; new skills are switched off`, outcome: "saved" });
  return reports.filter((r) => r.note !== "left out");
}

export class AgentMarket {
  constructor(private readonly store: Store, private readonly owner: string, private readonly policy: NetworkPolicy,
    private readonly files: WorkspaceFiles, private readonly appVersion: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  indexes(): string[] {
    const parsed = z.object({ urls: z.array(z.string()).max(10) }).safeParse(this.store.get("settings", this.owner, indexesKey)?.data ?? {});
    return parsed.success ? parsed.data.urls : [];
  }
  setIndexes(urls: unknown): string[] {
    const list = z.array(z.url().max(2000)).max(10).parse(urls);
    this.store.save("settings", this.owner, indexesKey, { urls: [...new Set(list)] });
    return this.indexes();
  }

  private async fetchBytes(url: string, limit: number): Promise<Buffer> {
    const target = new URL(url);
    if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("A market is reached over http or https only");
    await this.policy.assertAllowed(target, "market address");
    const response = await this.fetchImpl(target, { redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`The market did not answer (HTTP ${response.status})`);
    return readCapped(response, limit);
  }
  /** What a market offers. Nothing is installed by looking. */
  async browse(url: string): Promise<MarketIndex> {
    requireInterop(this.store, this.owner, "agent-market");
    return MarketIndexSchema.parse(JSON.parse((await this.fetchBytes(url, maxIndexBytes)).toString("utf8")));
  }
  private async open(url: string, id: string): Promise<{ entry: MarketEntry; opened: OpenedAgent }> {
    const index = await this.browse(url);
    const entry = index.agents.find((a) => a.id === id);
    if (!entry) throw new Error(`The market "${index.name}" has no assistant called ${id}`);
    const bytes = await this.fetchBytes(new URL(entry.url, url).href, maxPackageBytes);
    if (sha256(bytes) !== entry.sha256) throw new Error("The file does not match the fingerprint the market published, so nothing was brought in");
    return { entry, opened: openAgent(bytes) };
  }
  /** What is inside, with the parts a market may never bring marked as such. */
  async preview(url: string, id: string) {
    const { entry, opened } = await this.open(url, id);
    return { entry, sections: opened.manifest.sections.map((s) => ({ name: s.name, summary: s.summary,
      allowed: (shareableSections as readonly string[]).includes(s.name) })) };
  }
  async install(url: string, id: string, chosen: unknown) {
    const sections = z.array(z.enum(shareableSections)).min(1).max(3).parse(chosen);
    const { entry, opened } = await this.open(url, id);
    const reports = bringInShareable(this.store, this.owner, opened, sections,
      { subject: `${entry.name} from ${new URL(url).host}`, from: "Brought in from a market" });
    return { entry, reports };
  }
  /** Writes this assistant's shareable parts and the market list into a workspace folder. */
  async publish(input: unknown) {
    requireInterop(this.store, this.owner, "agent-market");
    const value = PublishSchema.parse(input);
    const whole = await exportAgent(this.store, this.owner, this.appVersion, { memory: false });
    const bytes = shareablePackage(whole.bytes, value.sections);
    const fileName = `${value.id}.branch-agent`;
    const packagePath = await this.files.checkedForWrite(`${value.folder}/${fileName}`);
    const indexPath = await this.files.checkedForWrite(`${value.folder}/market.json`);
    await mkdir(dirname(packagePath), { recursive: true });
    await writeFile(packagePath, bytes, { mode: 0o600 });
    const index = await readFile(indexPath, "utf8").then((text) => MarketIndexSchema.parse(JSON.parse(text)))
      .catch(() => ({ format: "branch-agent-market" as const, version: 1 as const, name: value.marketName, agents: [] }));
    const entry: MarketEntry = { id: value.id, name: value.name, summary: value.summary, author: value.author,
      version: value.version, url: fileName, sha256: sha256(bytes), sections: value.sections };
    const next: MarketIndex = { ...index, agents: [...index.agents.filter((a) => a.id !== value.id), entry] };
    await writeFile(indexPath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    return { entry, folder: value.folder, files: [`${value.folder}/${fileName}`, `${value.folder}/market.json`],
      next: "Put both files on any web server and give people the address of market.json." };
  }
}

/**
 * The model may look at a market and at what an assistant file holds, never bring one in or
 * publish: those two are the owner's, in Customize.
 */
export function registerMarketTool(registry: import("../registry.js").ToolRegistry, market: AgentMarket): void {
  registry.register({
    name: "assistant.market", group: "agents", permission: "web.read",
    description: "Look at a market of shared assistants, or at what one of them holds. Installs nothing.",
    parameters: z.object({
      market: z.url().max(2000),
      /** Leave out to list the market; name one to see what it holds. */
      assistant: EntrySchema.shape.id.optional(),
    }).strict(),
    execute: async (args) => args.assistant ? market.preview(args.market, args.assistant) : market.browse(args.market),
  });
}

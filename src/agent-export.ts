import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import { audit } from "./audit.js";
import { zipRead, zipWrite, type ZipLimits } from "./skill-package.js";
import { recordedWrite } from "./settings-kit/recorded-write.js"; // Q48
import type { ChangeOrigin } from "./settings-kit/history.js";
import { scrubSecrets } from "./locker.js";
import { findLeaks, hiddenMarker } from "./leak-guard.js";

/**
 * Handing the assistant itself to someone else, or to another computer. One file holds the
 * specialists, the saved procedures, the installed skills, which model does what, the approval
 * rules, and — only if it is asked for — what the assistant remembers.
 *
 * Nothing that is a secret ever goes in. Before a part is written every string in it is checked
 * against every value the owner keeps in the locker, in every project, whether or not Branch has used
 * it since it started, and in every form a value takes inside a string (escaped, encoded into an
 * address, or in base64), so a fact that happens to quote a key comes out with the key replaced by its name. Then
 * key-shaped text the locker never held (a key pasted into a fact, say) is hidden the way the leak
 * guard hides it everywhere else. Only strings change, so every part still reads as JSON. The check
 * needs the locker open, so a locked Branch writes no file.
 */
export const agentSections = ["specialists", "procedures", "skills", "routing", "permissions", "memory"] as const;
export type AgentSection = (typeof agentSections)[number];
export const agentManifestEntry = "branch-agent.json";
export const agentZipLimits: ZipLimits = { entries: 12, entryBytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 };

export const AgentManifestSchema = z.object({
  format: z.literal("branch-agent"),
  version: z.literal(1),
  exportedAt: z.iso.datetime(),
  appVersion: z.string().max(40),
  /** What is inside, so the person sees the list before anything is brought in. */
  sections: z.array(z.object({
    name: z.enum(agentSections),
    items: z.number().int().nonnegative(),
    file: z.string().max(80),
    sha256: z.string().length(64),
    /** One line the person can read, such as "3 specialists". */
    summary: z.string().max(200),
  })).max(agentSections.length),
  /** True when the memory section was written with personal details taken out. */
  memoryRedacted: z.boolean().default(false),
}).strict();
export type AgentManifest = z.infer<typeof AgentManifestSchema>;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const settingKeys: Record<"routing" | "permissions", string[]> = {
  routing: ["routing", "model-profiles", "models"],
  permissions: ["policy", "governance", "ask-first"],
};

export interface ExportOptions {
  /** Include what the assistant remembers. Off unless the person asks for it. */
  memory?: boolean;
  /** Take personal details out of remembered facts on the way out. */
  redact?: (text: string) => string;
  /** p17 (whole-agent export from the window): only these sections; every section when left out. */
  sections?: readonly AgentSection[];
}

/** Everything one section holds, as the text that goes into the file. */
function sectionData(store: Store, owner: string, section: AgentSection): { items: number; text: string; summary: string } {
  if (section === "specialists" || section === "procedures") {
    const records = store.list(section, owner).map((record) => ({ id: record.id, data: record.data }));
    return { items: records.length, text: JSON.stringify(records), summary: `${records.length} ${section === "specialists" ? "specialist" : "saved procedure"}${records.length === 1 ? "" : "s"}` };
  }
  if (section === "skills") {
    const skills = store.skills.catalog(owner).map((entry) => ({
      name: entry.name, document: String((store.skills.read(owner, entry.id, { version: entry.version }) as { document?: unknown }).document ?? ""),
    }));
    return { items: skills.length, text: JSON.stringify(skills), summary: `${skills.length} skill${skills.length === 1 ? "" : "s"}` };
  }
  if (section === "memory") {
    // p17: the memory archive keeps its facts under "records" (src/memory.ts); "facts" read nothing.
    const exported = store.exportMemory(owner) as { records?: unknown[]; facts?: unknown[] } | unknown[];
    const facts = Array.isArray(exported) ? exported : (exported.records ?? exported.facts ?? []);
    return { items: facts.length, text: JSON.stringify(facts), summary: `${facts.length} remembered fact${facts.length === 1 ? "" : "s"}` };
  }
  const keys = settingKeys[section];
  const found = keys.map((key) => ({ key, data: store.get("settings", owner, key)?.data ?? null })).filter((entry) => entry.data !== null);
  const what = section === "routing" ? "model choice" : "approval rule";
  return { items: found.length, text: JSON.stringify(found), summary: `${found.length} saved ${what} setting${found.length === 1 ? "" : "s"}` };
}

/**
 * p17 (whole-agent export from the window): what each section would hold, counted and named the way
 * the file's manifest names it, without writing a file or a record. Memory is counted, not read out.
 */
export function agentSummary(store: Store, owner: string): { name: AgentSection; items: number; summary: string }[] {
  return agentSections.map((section) => {
    const { items, summary } = sectionData(store, owner, section);
    return { name: section, items, summary };
  });
}

/** What the export answers while Branch is locked: the check reads the locker, which stays shut until then. */
export const unlockFirst = "Unlock Branch first, so it can check the file for your saved keys.";

/**
 * A value's base64 when it starts `shift` bytes (0, 1 or 2) into a group of three, as it does behind
 * `user:` in a Basic sign-in header: only the characters that come from the value alone, so it is found
 * whatever stands before or after it. Under eight characters it is left out: it would match ordinary text.
 */
function base64Core(value: string, shift: number): string | undefined {
  const encoded = Buffer.concat([Buffer.alloc(shift), Buffer.from(value, "utf8")]).toString("base64");
  const core = encoded.slice(Math.ceil((8 * shift) / 6), Math.floor((8 * (shift + Buffer.byteLength(value, "utf8"))) / 6));
  return core.length >= 8 ? core : undefined;
}

/**
 * The ways a saved value is written inside one string: as it is; escaped the way JSON writes it, once
 * (a string that holds JSON text) and twice (JSON text inside that, such as a tool call's arguments);
 * URL-encoded; form-encoded, where a space becomes "+", both by hand and the way a browser form or
 * URLSearchParams writes it; and in base64, from each of the three places a value can start. A value
 * read from the locker is whole UTF-8 text, so `encodeURIComponent` always takes it.
 */
function writtenForms(value: string): string[] {
  const once = JSON.stringify(value).slice(1, -1), encoded = encodeURIComponent(value);
  const base64 = [0, 1, 2].map((shift) => base64Core(value, shift)).filter((core) => core !== undefined);
  return [value, once, JSON.stringify(once).slice(1, -1), encoded, encoded.replace(/%20/g, "+"),
    new URLSearchParams([["", value]]).toString().slice(1), ...base64];
}

/**
 * Every value the owner keeps in the locker, in each of its written forms, longest first so a value
 * holding another is taken out whole. A value under four characters is left alone, as everywhere
 * else: it would match words.
 */
async function lockerValues(store: Store, owner: string): Promise<[form: string, name: string][]> {
  const secrets = store.secrets;
  try { secrets.gate(); } catch { throw new Error(unlockFirst); }
  const byForm = new Map<string, string>();
  for (const { name, value } of await secrets.valuesToHide(owner)) {
    if (value.length < 4) continue;
    for (const form of writtenForms(value)) byForm.set(form, name);
  }
  return [...byForm].sort(([a], [b]) => b.length - a.length);
}

/**
 * Key-shaped text in one string hidden the way the leak guard hides it, at its default settings. The
 * string is read with the name it sits under in front of it, as the part's text had it, so a value
 * known only by that name (`"password": "…"`) is still found. The front is at least sixteen
 * characters, the shortest text the guard looks at, so a short value is looked at too.
 */
function hideKeyShapes(text: string, name = ""): string {
  const front = (name ? `${name}: ` : "").padStart(16);
  let result = "", at = 0;
  for (const hit of findLeaks(front + text)) {
    const end = hit.end - front.length;
    if (end <= 0) continue; // wholly inside the name, which is never changed
    result += text.slice(at, Math.max(hit.start - front.length, 0)) + hiddenMarker(hit.kind);
    at = end;
  }
  return result + text.slice(at);
}

/** One string: every locker value, in any written form, becomes its name; then this launch's scrubber and the key shapes. */
function cleanedString(store: Store, text: string, values: [form: string, name: string][], name?: string): string {
  let result = text;
  for (const [form, secret] of values) result = scrubSecrets(result, { [secret]: form });
  return hideKeyShapes(store.secrets.scrubber.text(result), name);
}

/**
 * One part's text, cleaned value by value: the part is read back, each string in it is cleaned on its
 * own (see `cleanedString`), and it is written out the way it was written before. Names, numbers,
 * true, false and null are never changed, so the part still reads as JSON whatever the locker holds.
 */
function cleaned(store: Store, text: string, values: [form: string, name: string][]): string {
  const walk = (data: unknown, name?: string): unknown => {
    if (typeof data === "string") return cleanedString(store, data, values, name);
    if (Array.isArray(data)) return data.map((entry) => walk(entry));
    if (data === null || typeof data !== "object") return data;
    return Object.fromEntries(Object.entries(data).map(([key, entry]) => [key, walk(entry, key)]));
  };
  return JSON.stringify(walk(JSON.parse(text)));
}

/**
 * Writes the one file, each part checked first (see `cleaned`). While Branch is locked it refuses
 * with `unlockFirst` before anything is read or written down.
 */
export async function exportAgent(store: Store, owner: string, appVersion: string, options: ExportOptions = {}): Promise<{ bytes: Buffer; manifest: AgentManifest }> {
  const values = await lockerValues(store, owner);
  const entries: [string, string][] = [];
  const sections: AgentManifest["sections"] = [];
  for (const section of agentSections) {
    if (section === "memory" && !options.memory) continue;
    if (options.sections && !options.sections.includes(section)) continue;
    const { items, summary, text: raw } = sectionData(store, owner, section);
    // Personal details are masked after the check, so masking part of a saved value cannot hide the rest of it.
    const checked = cleaned(store, raw, values);
    const text = section === "memory" && options.redact ? options.redact(checked) : checked;
    const file = `${section}.json`;
    entries.push([file, text]);
    sections.push({ name: section, items, file, sha256: sha256(text), summary });
  }
  const manifest: AgentManifest = {
    format: "branch-agent", version: 1, exportedAt: new Date().toISOString(),
    appVersion: appVersion.slice(0, 40), sections, memoryRedacted: !!(options.memory && options.redact),
  };
  // Batch 20 (wave 8): handing the whole assistant to somebody else is the largest export there
  // is, so it is written into the record of what it was allowed to do like every smaller one.
  audit(store, owner, {
    action: "data.exported", actor: owner, subject: "the whole assistant, as one file",
    reason: `${sections.map((section) => section.name).join(", ")}${options.memory ? "" : "; what it remembers was left out"}`,
    outcome: "saved",
  });
  return { bytes: zipWrite([[agentManifestEntry, JSON.stringify(manifest, null, 1)], ...entries]), manifest };
}

export interface OpenedAgent { manifest: AgentManifest; files: Map<string, string> }

/** Opens the file and checks every part against the fingerprint in its manifest. */
export function openAgent(bytes: Buffer): OpenedAgent {
  if (bytes.byteLength > agentZipLimits.totalBytes) throw new Error("That file is larger than an exported assistant may be.");
  const files = zipRead(bytes, agentZipLimits);
  const text = files.get(agentManifestEntry);
  if (!text) throw new Error("That file is not an exported assistant (no branch-agent.json inside).");
  const manifest = AgentManifestSchema.parse(JSON.parse(text));
  for (const section of manifest.sections) {
    const body = files.get(section.file);
    if (body === undefined) throw new Error(`${section.file} is named in the manifest but missing from the file.`);
    if (sha256(body) !== section.sha256) throw new Error(`${section.file} does not match its fingerprint, so nothing was brought in.`);
  }
  return { manifest, files };
}

export interface AgentImportReport { section: AgentSection; brought: number; note: string }

/** How a settings change made by bringing in an assistant file is written down when the caller does not say. */
const importedFrom: ChangeOrigin = { writer: "unknown", source: "import", detail: "an assistant file" };

/**
 * Brings in only the sections that were chosen; anything not chosen is left where it is. `origin`
 * is who brought the file in, for the change record of any Settings setting it replaces (Q48).
 */
export function importAgent(store: Store, owner: string, opened: OpenedAgent, chosen: readonly AgentSection[],
  origin: ChangeOrigin = importedFrom): AgentImportReport[] {
  const wanted = new Set(chosen);
  const reports: AgentImportReport[] = [];
  for (const section of opened.manifest.sections) {
    if (!wanted.has(section.name)) { reports.push({ section: section.name, brought: 0, note: "left out" }); continue; }
    const parsed = JSON.parse(opened.files.get(section.file)!) as unknown;
    reports.push(bringIn(store, owner, section.name, parsed, origin));
  }
  return reports;
}

function bringIn(store: Store, owner: string, section: AgentSection, parsed: unknown, origin: ChangeOrigin): AgentImportReport {
  const rows = Array.isArray(parsed) ? parsed : [];
  if (section === "specialists" || section === "procedures") {
    for (const row of rows.slice(0, 500)) {
      const record = row as { id?: unknown; data?: unknown };
      if (typeof record.id === "string" && record.data && typeof record.data === "object")
        store.save(section, owner, record.id, record.data as Record<string, unknown>);
    }
    return { section, brought: rows.length, note: "added, replacing any with the same name" };
  }
  if (section === "skills") return bringInSkills(store, owner, rows);
  if (section === "memory") {
    // p17: the facts go back in as the memory archive they came out of (src/memory.ts parseMemoryArchive).
    const result = store.importMemory(owner, { format: "branch-agent-memory", version: 1, exportedAt: new Date().toISOString(), records: rows }) as { imported?: number } | undefined;
    return { section, brought: Number(result?.imported ?? rows.length), note: "added to what is already remembered" };
  }
  // Q48: "When to check with me" is a Settings setting, so replacing it is written down like any change.
  recordedWrite(store, owner, origin, ["policy"], () => {
    for (const row of rows.slice(0, 20)) {
      const entry = row as { key?: unknown; data?: unknown };
      if (typeof entry.key === "string" && settingKeys[section as "routing" | "permissions"].includes(entry.key) && entry.data && typeof entry.data === "object")
        store.save("settings", owner, entry.key, entry.data as Record<string, unknown>);
    }
  });
  return { section, brought: rows.length, note: "replaced the settings of the same name" };
}

/** A skill arrives as its own document, so it is installed the ordinary way and scanned as usual. */
function bringInSkills(store: Store, owner: string, rows: unknown[]): AgentImportReport {
  let brought = 0;
  for (const row of rows.slice(0, 50)) {
    const skill = row as { document?: unknown };
    if (typeof skill.document !== "string" || !skill.document.trim()) continue;
    try { store.skills.install(owner, { document: skill.document }); brought++; } catch { /* one bad skill does not stop the rest */ }
  }
  return { section: "skills", brought, note: `${brought} of ${rows.length} installed; each was scanned as usual` };
}

import { basename } from "node:path";
import { parseDocument, stringify } from "yaml";
import { redactText } from "../conversation-share.js";
import { parseSkillDocument, skillDocumentLimit } from "../skill-document.js";
import { describeFindings, scanSkill } from "../skill-scan.js";
import type { SourceTree } from "./source-tree.js";
import {
  clip, itemKey, lockerName, secretLike,
  type FoundItem, type ItemKind, type KeyPrompt, type MovedMessage, type MovedServer, type MoveInSource, type Payload,
} from "./types.js";

/** Anything that looks like a key is blanked out of text before it is kept in Branch. */
export const scrub = (text: string): string =>
  redactText(text, { secrets: true, contactDetails: false, toolResults: false }).text;

/** Every line of a JSON-lines file that parses as an object; broken lines are skipped, not fatal. */
export function jsonLines(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) rows.push(value as Record<string, unknown>);
    } catch { /* a half-written last line is normal for a file another program was still writing */ }
  }
  return rows;
}

export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const asString = (value: unknown): string => (typeof value === "string" ? value : "");
export const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

export function parseJson(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try { return asRecord(JSON.parse(stripJsonComments(text))); } catch { return {}; }
}

/** Removes `//` and `/* *\/` comments and trailing commas outside strings, for `.jsonc` and JSON5-ish files. */
export function stripJsonComments(text: string): string {
  let out = "", inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!, next = text[index + 1];
    if (inString) {
      out += char;
      if (char === "\\") { out += next ?? ""; index++; } else if (char === '"') inString = false;
    } else if (char === '"') { inString = true; out += char; }
    else if (char === "/" && next === "/") { while (index < text.length && text[index] !== "\n") index++; out += "\n"; }
    else if (char === "/" && next === "*") { index = text.indexOf("*/", index + 2); if (index < 0) break; index++; }
    else out += char;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Joins messages that follow each other from the same side, and drops empty ones. */
export function tidyMessages(messages: MovedMessage[]): MovedMessage[] {
  const out: MovedMessage[] = [];
  for (const message of messages) {
    const content = scrub(message.content.trim());
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === message.role) last.content += "\n\n" + content;
    else out.push({ role: message.role, content });
  }
  return out;
}

/** Why a chat cannot come over as it is, or null when it can. The limits are the conversation archive's own. */
export function chatRefusal(messages: MovedMessage[]): string | null {
  if (!messages.length) return "It has no messages in plain words to bring over.";
  if (messages.length > 1000) return `It has ${messages.length} messages; Branch brings over chats of up to 1000.`;
  if (Buffer.byteLength(JSON.stringify(messages)) > 4 * 1024 * 1024 - 4096) return "It is larger than the 4 MB Branch brings over in one chat.";
  return null;
}

/** Text split at paragraph breaks into pieces a saved fact can hold. */
export function splitForMemory(text: string, size = 3800): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\s*\n/)) {
    const block = paragraph.trim();
    if (!block) continue;
    for (let start = 0; start < block.length; start += size) {
      const part = block.slice(start, start + size);
      if (current && current.length + part.length + 2 > size) { pieces.push(current); current = ""; }
      current = current ? `${current}\n\n${part}` : part;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

const slug = (text: string): string =>
  text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** The Branch project a folder from another assistant becomes; the same folder always gives the same id. */
export function projectIdFor(folder: string): string {
  const name = slug(basename(folder.replace(/[\\/]+$/, ""))) || "project";
  return `moved-${name}`.slice(0, 40).replace(/-+$/, "");
}
export const projectNameFor = (folder: string): string =>
  clip(basename(folder.replace(/[\\/]+$/, "")) || folder || "Project", 80);

const keptSkillKeys = new Set(["license", "compatibility", "allowed-tools"]);

/**
 * A SKILL.md from another assistant, reshaped into the fields Branch reads: its name made into
 * lower-case words joined by dashes, a description (the first line of the body when it had none),
 * and only the frontmatter keys Branch knows. Returns why it cannot come when it cannot.
 */
export function normaliseSkill(document: string, folderName: string): { document: string } | { refusal: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(document);
  const body = (match ? match[2]! : document).trim();
  let front: Record<string, unknown> = {};
  if (match) {
    try {
      const parsed = parseDocument(match[1]!);
      if (parsed.errors.length) return { refusal: "Its heading could not be read." };
      front = asRecord(parsed.toJS({ maxAliasCount: 0 }));
    } catch { return { refusal: "Its heading could not be read." }; }
  }
  if (!body) return { refusal: "It has no instructions in it." };
  const name = slug(asString(front.name) || folderName).slice(0, 64).replace(/-+$/, "");
  const description = clip(asString(front.description) || body.split("\n").find((line) => line.trim()) || name, 1000);
  const meta: Record<string, unknown> = { name, description };
  for (const [key, value] of Object.entries(front)) {
    if (!keptSkillKeys.has(key)) continue;
    const text = Array.isArray(value) ? asStrings(value).join(" ") : asString(value);
    if (text) meta[key] = text;
  }
  const rebuilt = `---\n${stringify(meta).trimEnd()}\n---\n\n${body}\n`;
  if (rebuilt.length > skillDocumentLimit) return { refusal: `It is longer than the ${skillDocumentLimit} characters a Branch skill may be.` };
  try { parseSkillDocument(rebuilt); } catch (error) { return { refusal: `Branch could not read it: ${(error as Error).message}` }; }
  const findings = scanSkill(rebuilt);
  if (findings.length) return { refusal: `The safety check held it back: ${describeFindings(findings)}.` };
  return { document: rebuilt };
}

/** Reads every `<name>/SKILL.md` under a folder of the source into skill items. */
export async function skillsIn(
  tree: SourceTree, source: MoveInSource, folder: string, skip: string[] = [], originPrefix = "",
): Promise<FoundItem[]> {
  const items: FoundItem[] = [];
  for (const entry of await tree.list(folder)) {
    if (entry.kind !== "dir" || entry.name.startsWith(".") || skip.includes(entry.name)) continue;
    const origin = `${folder}/${entry.name}/SKILL.md`, text = await tree.read(origin, 256 * 1024);
    if (text === null) continue;
    const others = (await tree.list(`${folder}/${entry.name}`)).filter((file) => file.name !== "SKILL.md").length;
    const shaped = normaliseSkill(text, entry.name);
    const extra = others ? ` ${others} other file${others === 1 ? "" : "s"} beside it stay${others === 1 ? "s" : ""} behind.` : "";
    items.push(found(source, "skill", originPrefix + origin, entry.name,
      "refusal" in shaped ? shaped.refusal : `Its instructions come over.${extra}`,
      "refusal" in shaped ? null : { kind: "skill", document: shaped.document }));
  }
  return items;
}

/** One found item. A null payload means it is shown but cannot be brought over; `detail` says why. */
export function found(
  source: MoveInSource, kind: ItemKind, origin: string, title: string, detail: string,
  payload: Payload | null | (() => Promise<Payload>), needsKeys: string[] = [],
): FoundItem {
  const load = typeof payload === "function" ? payload : async () => {
    if (!payload) throw new Error(detail);
    return payload;
  };
  return { key: itemKey(source, kind, origin), kind, title: clip(scrub(title), 120), detail: scrub(detail), origin, load,
    needsKeys, blocked: payload === null };
}

/**
 * An MCP server entry in the common shape most assistants write (`command`/`args`/`env` or
 * `url`/`headers`), as Branch would reach it. Values of `env` and `headers` are never kept:
 * their names become prompts to add the key in the locker.
 */
export function serverFrom(name: string, raw: Record<string, unknown>, keys: KeyPrompt[]): MovedServer | string {
  const envKeys: string[] = [];
  const why = `the ${name} tool server used it`;
  for (const key of Object.keys(asRecord(raw.env ?? raw.environment))) {
    const locker = lockerName(key);
    if (!locker) continue;
    envKeys.push(locker);
    keys.push({ name: locker, why });
  }
  // An argument such as `--token sk-…` is blanked out: only the shape of the command comes over.
  const command = (Array.isArray(raw.command) ? asStrings(raw.command) : [asString(raw.command), ...asStrings(raw.args)]).map(scrub);
  const url = asString(raw.url ?? raw.serverUrl ?? raw.httpUrl);
  if (command[0]) {
    const cwd = asString(raw.cwd);
    return { transport: "stdio", name, command: command[0], args: command.slice(1, 41), envKeys: envKeys.slice(0, 20),
      ...(cwd ? { cwd } : {}) };
  }
  if (!url) return "It names neither a program nor a web address.";
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) return "Its address is not https, which Branch requires.";
  const headers = asRecord(raw.headers ?? raw.http_headers);
  const bearer = Object.keys(headers).some((key) => key.toLowerCase() === "authorization") || raw.bearer_token !== undefined
    ? lockerName(asString(raw.bearer_token_env_var) || `${name}_TOKEN`) : null;
  if (bearer) keys.push({ name: bearer, why: `the ${name} tool server signed in with it` });
  for (const key of Object.keys(headers)) if (secretLike(key) && key.toLowerCase() !== "authorization") {
    const locker = lockerName(key);
    if (locker) keys.push({ name: locker, why });
  }
  return { transport: "http", name, url: url.split(/[?#]/)[0]!, envKeys: envKeys.slice(0, 20), ...(bearer ? { bearerEnv: bearer } : {}) };
}

/** Every server in an `{ name: entry }` map as MCP items, skipping ones switched off. */
export function serverItems(
  source: MoveInSource, origin: string, servers: Record<string, unknown>, keys: KeyPrompt[],
): FoundItem[] {
  const items: FoundItem[] = [];
  for (const [name, value] of Object.entries(servers)) {
    const raw = asRecord(value);
    if (raw.disabled === true || raw.enabled === false) continue;
    const own: KeyPrompt[] = [];
    const server = serverFrom(name, raw, own);
    keys.push(...own);
    const where = typeof server === "string" ? server
      : server.transport === "stdio" ? `Runs ${clip([server.command, ...server.args].join(" "), 80)}.` : `Reached at ${server.url}.`;
    items.push(found(source, "mcp", `${origin}#${name}`, name, where,
      typeof server === "string" ? null : { kind: "mcp", server }, own.map((key) => key.name)));
  }
  return items;
}

/** Memory or instruction text as one item; long text becomes several facts when it is brought over. */
export function textItem(
  source: MoveInSource, kind: "memory" | "instructions", origin: string, title: string, text: string,
  about: "person" | "world" | "project" = "person", project?: string,
): FoundItem | null {
  const clean = text.trim();
  if (!clean) return null;
  const facts = splitForMemory(clean).length;
  const detail = `${clean.length.toLocaleString("en")} characters, kept as ${facts} saved fact${facts === 1 ? "" : "s"}.`;
  const payload: Payload = kind === "instructions" ? { kind, text: clean }
    : { kind, text: clean, about, ...(project ? { project } : {}) };
  return found(source, kind, origin, title, detail, payload);
}

/** Keeps one prompt per key name, joining the reasons. */
export function mergeKeys(keys: KeyPrompt[]): KeyPrompt[] {
  const merged = new Map<string, Set<string>>();
  for (const key of keys) merged.set(key.name, (merged.get(key.name) ?? new Set()).add(key.why));
  return [...merged].map(([name, why]) => ({ name, why: clip([...why].join("; "), 300) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Names from a `.env` file. The values are read past and never kept. */
export function envNames(text: string | null): string[] {
  if (!text) return [];
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && match[1] && secretLike(match[1])) names.push(match[1]);
  }
  return names;
}

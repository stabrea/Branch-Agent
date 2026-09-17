import { parse as parseYaml } from "yaml";
import {
  asRecord, asString, chatRefusal, envNames, found, mergeKeys, projectNameFor, serverItems, skillsIn, textItem, tidyMessages,
} from "./common.js";
import type { ScanInput } from "./scan.js";
import { openCopy, type OpenedDatabase } from "./sqlite.js";
import { subTree, type SourceTree } from "./source-tree.js";
import { clip, lockerName, type FoundItem, type KeyPrompt, type MovedMessage, type ScanResult } from "./types.js";

/**
 * Hermes Agent keeps everything under `~/.hermes` (or `$HERMES_HOME`; on Windows
 * `%LOCALAPPDATA%\hermes`), or under `profiles/<name>/` when a profile is active: chats in the
 * `state.db` database, memory in `memories/MEMORY.md` and `USER.md` (entries split by a line with
 * `§`), its personality in `SOUL.md`, skills in `skills/<group>/<name>/SKILL.md`, and settings and
 * tool servers in `config.yaml`. Its keys (`.env`, `auth.json`) are never opened for their values:
 * only the names in `.env` are read, to say which keys to add to the locker.
 */
const chatLimit = 2000;

/** The folder the active profile lives in, or the home folder itself. */
async function activeTree(tree: SourceTree): Promise<SourceTree> {
  const name = ((await tree.read("active_profile", 1024)) ?? "").trim();
  if (!name || name === "default" || !/^[A-Za-z0-9._-]+$/.test(name)) return tree;
  return (await tree.list("profiles")).some((entry) => entry.name === name && entry.kind === "dir")
    ? subTree(tree, `profiles/${name}`) : tree;
}

function readConfig(text: string | null, notes: string[]): Record<string, unknown> {
  if (!text) return {};
  try { return asRecord(parseYaml(text, { maxAliasCount: 0 })); }
  catch { notes.push("Hermes's config.yaml could not be read, so its tool servers and model are not listed."); return {}; }
}

function sessionRows(opened: OpenedDatabase) {
  const columns = opened.columns("sessions");
  if (!columns.has("id") || !opened.columns("messages").has("session_id")) return [];
  const pick = (name: string) => (columns.has(name) ? name : `NULL AS ${name}`);
  const hidden = columns.has("hidden") ? "WHERE COALESCE(hidden,0)=0" : "";
  const order = columns.has("started_at") ? "ORDER BY started_at DESC" : "";
  return opened.db.prepare(`SELECT id, ${pick("title")}, ${pick("cwd")}, ${pick("parent_session_id")}
    FROM sessions ${hidden} ${order} LIMIT ${chatLimit}`).all();
}

function messagesOf(opened: OpenedDatabase, session: string): MovedMessage[] {
  const columns = opened.columns("messages");
  const current = columns.has("active") ? "AND COALESCE(active,1)=1" : "";
  return tidyMessages(opened.db.prepare(`SELECT role, content FROM messages
    WHERE session_id=? AND role IN ('user','assistant') ${current} ORDER BY id`).all(session)
    .map((row) => ({ role: row.role === "user" ? "user" as const : "assistant" as const, content: asString(row.content) })));
}

function chatItems(opened: OpenedDatabase, folders: Set<string>): FoundItem[] {
  const items: FoundItem[] = [];
  for (const row of sessionRows(opened)) {
    const id = String(row.id), folder = asString(row.cwd), messages = messagesOf(opened, id);
    if (!messages.length) continue;
    if (folder) folders.add(folder);
    const refusal = chatRefusal(messages);
    const title = asString(row.title) || messages.find((message) => message.role === "user")?.content || "A chat";
    items.push(found("hermes", "chat", `session:${id}`, clip(title, 120),
      refusal ?? `${messages.length} messages${folder ? `, in ${folder}` : ""}.`,
      refusal ? null : async () => ({ kind: "chat", messages: messagesOf(opened, id), folder })));
  }
  return items;
}

function configItems(config: Record<string, unknown>, keys: KeyPrompt[]): FoundItem[] {
  const items = serverItems("hermes", "config.yaml", asRecord(config.mcp_servers), keys);
  const model = typeof config.model === "string" ? config.model
    : asString(asRecord(config.model).default) || asString(asRecord(config.model).model);
  if (model) items.push(found("hermes", "setting", "config.yaml#model", `Model: ${model}`,
    "The model you chose. Branch suggests it when you connect a model.", { kind: "setting", name: "model", value: model }));
  return items;
}

async function textItems(tree: SourceTree): Promise<FoundItem[]> {
  const read = async (path: string) => ((await tree.read(path, 512 * 1024)) ?? "").split(/\n§\n/).join("\n\n");
  return [
    textItem("hermes", "instructions", "SOUL.md", "Its personality (SOUL.md)", await read("SOUL.md")),
    textItem("hermes", "instructions", "AGENTS.md", "Your instructions (AGENTS.md)", await read("AGENTS.md")),
    textItem("hermes", "memory", "memories/USER.md", "What Hermes knew about you", await read("memories/USER.md"), "person"),
    textItem("hermes", "memory", "memories/MEMORY.md", "What Hermes remembered", await read("memories/MEMORY.md"), "world"),
  ].filter((item): item is FoundItem => item !== null);
}

async function skillItems(tree: SourceTree): Promise<FoundItem[]> {
  const items = await skillsIn(tree, "hermes", "skills");
  for (const group of await tree.list("skills"))
    if (group.kind === "dir" && !group.name.startsWith("."))
      items.push(...await skillsIn(tree, "hermes", `skills/${group.name}`));
  return items;
}

export async function scanHermes({ tree: home }: ScanInput): Promise<ScanResult> {
  const tree = await activeTree(home);
  const keys: KeyPrompt[] = [], notes: string[] = [], folders = new Set<string>();
  const items = [...await textItems(tree), ...await skillItems(tree)];
  items.push(...configItems(readConfig(await tree.read("config.yaml", 1024 * 1024), notes), keys));
  for (const name of envNames(await tree.read(".env", 256 * 1024))) {
    const locker = lockerName(name);
    if (locker) keys.push({ name: locker, why: "Hermes kept it in its .env file" });
  }
  const opened = await openCopy(tree, "state.db");
  let chats: FoundItem[];
  // A database Branch cannot read still has its private copy removed before the error is reported.
  try { chats = opened ? chatItems(opened, folders) : []; }
  catch (error) { await opened?.close(); throw error; }
  for (const folder of folders)
    items.push(found("hermes", "project", `project:${folder}`, projectNameFor(folder),
      `Chats in ${folder}. Becomes the project "${projectNameFor(folder)}".`,
      { kind: "project", name: projectNameFor(folder), folder }));
  items.push(...chats);
  const top = await tree.list("");
  if (top.some((entry) => entry.name === "auth.json")) notes.push("Your Hermes sign-ins stay with Hermes. Connect a model under Settings.");
  if (top.some((entry) => entry.name === "cron")) notes.push("Hermes's scheduled jobs are not brought over; set them up again under Schedules.");
  return { items, keys: mergeKeys(keys), notes, ...(opened ? { close: () => opened.close() } : {}) };
}

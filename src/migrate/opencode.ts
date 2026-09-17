import {
  asRecord, asString, chatRefusal, found, mergeKeys, parseJson, projectNameFor, serverItems, skillsIn, textItem, tidyMessages,
} from "./common.js";
import type { ScanInput } from "./scan.js";
import { openCopy, type OpenedDatabase } from "./sqlite.js";
import type { SourceTree } from "./source-tree.js";
import { clip, type FoundItem, type KeyPrompt, type MovedMessage, type ScanResult } from "./types.js";

/**
 * OpenCode keeps its chats in `~/.local/share/opencode` (`$XDG_DATA_HOME`): in `opencode.db`, or in
 * the older `storage/` folder of one JSON file per session, message and part. Its settings, tool
 * servers, instructions (`AGENTS.md`) and skills are in `~/.config/opencode`. Its sign-ins
 * (`auth.json`, `mcp-auth.json`) are never opened, and a part of type `reasoning` never comes over.
 */
const chatLimit = 2000;

interface Chat { id: string; title: string; folder: string }

/** The words of a message's parts: typed text only, not added by OpenCode itself. */
function partWords(parts: Record<string, unknown>[]): string {
  return parts.filter((part) => part.type === "text" && part.synthetic !== true && part.ignored !== true)
    .map((part) => asString(part.text)).join("\n");
}

function databaseChats(opened: OpenedDatabase): { chats: Chat[]; load(id: string): MovedMessage[] } {
  const session = opened.columns("session");
  if (!session.has("id") || !opened.columns("part").has("data") || !opened.columns("message").has("data"))
    return { chats: [], load: () => [] };
  const top = session.has("parent_id") ? "WHERE parent_id IS NULL" : "";
  const order = session.has("time_updated") ? "ORDER BY time_updated DESC" : "";
  const chats = opened.db.prepare(`SELECT id, ${session.has("title") ? "title" : "'' AS title"},
    ${session.has("directory") ? "directory" : "'' AS directory"} FROM session ${top} ${order} LIMIT ${chatLimit}`).all()
    .map((row) => ({ id: String(row.id), title: asString(row.title), folder: asString(row.directory) }));
  const load = (id: string): MovedMessage[] => {
    const parts = opened.db.prepare("SELECT message_id, data FROM part WHERE session_id=? ORDER BY id").all(id);
    return opened.db.prepare("SELECT id, data FROM message WHERE session_id=? ORDER BY id").all(id).map((row) => {
      const role = asRecord(safeJson(row.data)).role === "user" ? "user" as const : "assistant" as const;
      const own = parts.filter((part) => part.message_id === row.id).map((part) => asRecord(safeJson(part.data)));
      return { role, content: partWords(own) };
    });
  };
  return { chats, load };
}

function safeJson(value: unknown): unknown {
  try { return JSON.parse(String(value)); } catch { return {}; }
}

async function jsonFiles(tree: SourceTree, folder: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const entry of await tree.list(folder))
    if (entry.kind === "file" && entry.name.endsWith(".json"))
      out.push(parseJson(await tree.read(`${folder}/${entry.name}`, 16 * 1024 * 1024)));
  return out.sort((a, b) => asString(a.id).localeCompare(asString(b.id)));
}

/** The older layout: `storage/session/<project>/<id>.json`, `storage/message/<session>/…`, `storage/part/<message>/…`. */
async function storageChats(tree: SourceTree): Promise<{ chats: Chat[]; load(id: string): Promise<MovedMessage[]> }> {
  const chats: Chat[] = [];
  for (const project of await tree.list("storage/session"))
    if (project.kind === "dir")
      for (const session of await jsonFiles(tree, `storage/session/${project.name}`))
        if (asString(session.id) && !session.parentID)
          chats.push({ id: asString(session.id), title: asString(session.title), folder: asString(session.directory) });
  const load = async (id: string): Promise<MovedMessage[]> => {
    const messages: MovedMessage[] = [];
    for (const message of await jsonFiles(tree, `storage/message/${id}`)) {
      const parts = await jsonFiles(tree, `storage/part/${asString(message.id)}`);
      messages.push({ role: message.role === "user" ? "user" : "assistant", content: partWords(parts) });
    }
    return messages;
  };
  return { chats: chats.slice(0, chatLimit), load };
}

async function chatItems(tree: SourceTree, folders: Set<string>, closers: (() => Promise<void>)[]): Promise<FoundItem[]> {
  const opened = await openCopy(tree, "opencode.db");
  if (opened) closers.push(() => opened.close());
  const fromDatabase = opened ? databaseChats(opened) : { chats: [], load: () => [] };
  const fromFiles = await storageChats(tree);
  const sources = [
    ...fromDatabase.chats.map((chat) => ({ chat, load: async () => fromDatabase.load(chat.id) })),
    ...fromFiles.chats.map((chat) => ({ chat, load: () => fromFiles.load(chat.id) })),
  ];
  const items: FoundItem[] = [], seen = new Set<string>();
  for (const { chat, load } of sources) {
    if (seen.has(chat.id)) continue;
    seen.add(chat.id);
    const messages = tidyMessages(await load()), refusal = chatRefusal(messages);
    if (chat.folder) folders.add(chat.folder);
    const title = chat.title || messages.find((message) => message.role === "user")?.content || "A chat";
    items.push(found("opencode", "chat", `session:${chat.id}`, clip(title, 120),
      refusal ?? `${messages.length} messages${chat.folder ? `, in ${chat.folder}` : ""}.`,
      refusal ? null : async () => ({ kind: "chat", messages: tidyMessages(await load()), folder: chat.folder })));
  }
  return items;
}

async function configItems(config: SourceTree, keys: KeyPrompt[]): Promise<FoundItem[]> {
  const items: FoundItem[] = [];
  for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
    const settings = parseJson(await config.read(name, 1024 * 1024));
    items.push(...serverItems("opencode", name, asRecord(settings.mcp), keys));
    const model = asString(settings.model);
    if (model) items.push(found("opencode", "setting", `${name}#model`, `Model: ${model}`,
      "The model you chose. Branch suggests it when you connect a model.", { kind: "setting", name: "model", value: model }));
  }
  const instructions = textItem("opencode", "instructions", "config:AGENTS.md", "Your instructions (AGENTS.md)",
    (await config.read("AGENTS.md", 512 * 1024)) ?? "");
  if (instructions) items.push(instructions);
  for (const folder of ["skill", "skills"]) items.push(...await skillsIn(config, "opencode", folder, [], "config:"));
  return items;
}

export async function scanOpenCode(input: ScanInput): Promise<ScanResult> {
  const closers: (() => Promise<void>)[] = [];
  const close = async () => { for (const closer of closers.splice(0)) await closer(); };
  // A database Branch cannot read still has its private copy removed before the error is reported.
  try { return { ...await readOpenCode(input, closers), close }; }
  catch (error) { await close(); throw error; }
}

async function readOpenCode({ tree, extras }: ScanInput, closers: (() => Promise<void>)[]): Promise<ScanResult> {
  const keys: KeyPrompt[] = [], notes: string[] = [], folders = new Set<string>();
  const items = await configItems(extras.config ?? tree, keys);
  const chats = await chatItems(tree, folders, closers);
  for (const folder of folders)
    items.push(found("opencode", "project", `project:${folder}`, projectNameFor(folder),
      `Chats in ${folder}. Becomes the project "${projectNameFor(folder)}".`,
      { kind: "project", name: projectNameFor(folder), folder }));
  items.push(...chats);
  if ((await tree.list("")).some((entry) => entry.name === "auth.json"))
    notes.push("Your OpenCode sign-ins stay with OpenCode. Connect a model under Settings.");
  return { items, keys: mergeKeys(keys), notes };
}

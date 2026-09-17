import { parse as parseYaml } from "yaml";
import {
  asRecord, asString, chatRefusal, envNames, found, jsonLines, mergeKeys,
  serverItems, skillsIn, stripJsonComments, textItem, tidyMessages,
} from "./common.js";
import type { ScanInput } from "./scan.js";
import { openCopy, type OpenedDatabase } from "./sqlite.js";
import { cleanRelative, subTree, type SourceTree } from "./source-tree.js";
import { clip, lockerName, secretLike, type FoundItem, type KeyPrompt, type MovedMessage, type ScanResult } from "./types.js";

/**
 * OpenClaw keeps everything under `~/.openclaw` (or `$OPENCLAW_STATE_DIR`): settings and tool
 * servers in `openclaw.json` (JSON5), the assistant's own files in `workspace/` (`AGENTS.md`,
 * `SOUL.md`, `USER.md`, `MEMORY.md`, `memory/*.md`, `skills/`), and chats per agent in
 * `agents/<id>/agent/openclaw-agent.sqlite` (older copies: `agents/<id>/sessions/*.jsonl`).
 * Its `credentials/` folder, `auth-profiles.json` and `.env` values are never opened.
 */
const chatLimit = 2000;
const leftovers = /\.(deleted|reset|bak)\.|\.checkpoint\./;

/** JSON5 is read as JSON once comments are gone, and as YAML (which takes bare keys) when that fails. */
function readConfig(text: string | null, notes: string[]): Record<string, unknown> {
  if (!text) return {};
  const plain = stripJsonComments(text);
  try { return asRecord(JSON.parse(plain)); } catch { /* try the looser reading */ }
  try { return asRecord(parseYaml(plain, { maxAliasCount: 0 })); }
  catch { notes.push("OpenClaw's openclaw.json could not be read, so its tool servers and model are not listed."); return {}; }
}

/** The words of an OpenClaw transcript entry, or null when it is not something said. */
function said(entry: Record<string, unknown>): MovedMessage | null {
  if (entry.type !== "message") return null;
  const message = asRecord(entry.message), content = message.content;
  const words = typeof content === "string" ? content : Array.isArray(content)
    ? content.map(asRecord).filter((block) => block.type === "text").map((block) => asString(block.text)).join("\n") : "";
  if (message.role === "user") return { role: "user", content: words };
  if (message.role === "assistant") return { role: "assistant", content: words };
  return null;
}

/** The branch of a transcript the owner last saw, walking back along `parentId` from the last message. */
export function readTranscript(entries: Record<string, unknown>[]): { messages: MovedMessage[]; title: string; folder: string } {
  const byId = new Map(entries.filter((entry) => typeof entry.id === "string").map((entry) => [entry.id as string, entry]));
  const last = [...entries].reverse().find((entry) => entry.type === "message");
  const chain: Record<string, unknown>[] = [];
  for (let entry = last; entry && chain.length <= entries.length; entry = byId.get(asString(entry.parentId))) chain.push(entry);
  const messages = tidyMessages(chain.reverse().map(said).filter((message): message is MovedMessage => message !== null));
  const named = [...entries].reverse().find((entry) => entry.type === "session_info");
  const header = entries.find((entry) => entry.type === "session");
  const title = asString(named?.name) || messages.find((message) => message.role === "user")?.content || "A chat";
  return { messages, title: clip(title, 120), folder: asString(header?.cwd) };
}

function databaseChats(opened: OpenedDatabase, agent: string): FoundItem[] {
  if (!opened.columns("transcript_events").has("event_json") || !opened.columns("session_windows").has("session_id")) return [];
  const load = (id: string) => readTranscript(opened.db.prepare(
    "SELECT event_json FROM transcript_events WHERE session_id=? ORDER BY seq").all(id)
    .map((row) => { try { return asRecord(JSON.parse(String(row.event_json))); } catch { return {}; } }));
  const named = opened.columns("session_windows").has("display_name") ? "display_name" : "NULL AS display_name";
  const order = opened.columns("session_windows").has("created_at") ? "ORDER BY created_at DESC" : "";
  return opened.db.prepare(`SELECT session_id, ${named} FROM session_windows ${order} LIMIT ${chatLimit}`).all()
    .map((row) => {
      const id = String(row.session_id), chat = load(id), refusal = chatRefusal(chat.messages);
      return found("openclaw", "chat", `agents/${agent}#${id}`, asString(row.display_name) || chat.title,
        refusal ?? `${chat.messages.length} messages, with the ${agent} agent.`,
        refusal ? null : async () => ({ kind: "chat", messages: load(id).messages, folder: chat.folder }));
    });
}

async function fileChats(tree: SourceTree, agent: string): Promise<FoundItem[]> {
  const folder = `agents/${agent}/sessions`, items: FoundItem[] = [];
  for (const file of (await tree.list(folder)).slice(0, chatLimit)) {
    if (file.kind !== "file" || !file.name.endsWith(".jsonl") || leftovers.test(file.name)) continue;
    const path = `${folder}/${file.name}`;
    const load = async () => readTranscript(jsonLines((await tree.read(path, 64 * 1024 * 1024)) ?? ""));
    const chat = await load(), refusal = chatRefusal(chat.messages);
    items.push(found("openclaw", "chat", `agents/${agent}#${file.name.replace(/\.jsonl$/, "")}`, chat.title,
      refusal ?? `${chat.messages.length} messages, with the ${agent} agent.`,
      refusal ? null : async () => ({ kind: "chat", messages: (await load()).messages, folder: chat.folder })));
  }
  return items;
}

async function chatItems(tree: SourceTree, closers: (() => Promise<void>)[]): Promise<FoundItem[]> {
  const items: FoundItem[] = [], seen = new Set<string>();
  for (const agent of await tree.list("agents")) {
    if (agent.kind !== "dir") continue;
    const opened = await openCopy(tree, `agents/${agent.name}/agent/openclaw-agent.sqlite`);
    if (opened) closers.push(() => opened.close());
    const fromDatabase = opened ? databaseChats(opened, agent.name) : [];
    for (const item of [...fromDatabase, ...await fileChats(tree, agent.name)])
      if (!seen.has(item.key)) { seen.add(item.key); items.push(item); }
  }
  return items;
}

/** The workspace folder, when the settings point at one inside the OpenClaw folder. */
function workspaceOf(tree: SourceTree, config: Record<string, unknown>, notes: string[]): SourceTree {
  const named = asString(asRecord(asRecord(config.agents).defaults).workspace);
  if (!named) return subTree(tree, "workspace");
  const match = /^(?:~[\\/]\.openclaw|\$OPENCLAW_STATE_DIR)[\\/](.+)$/.exec(named);
  const inside = match ? cleanRelative(match[1]!) : null;
  if (inside) return subTree(tree, inside);
  notes.push(`OpenClaw's workspace is kept at ${named}; bring that folder over on its own to include its files.`);
  return subTree(tree, "workspace");
}

async function workspaceItems(workspace: SourceTree): Promise<FoundItem[]> {
  const read = async (path: string) => (await workspace.read(path, 512 * 1024)) ?? "";
  const items = [
    textItem("openclaw", "instructions", "workspace/AGENTS.md", "Your instructions (AGENTS.md)", await read("AGENTS.md")),
    textItem("openclaw", "instructions", "workspace/SOUL.md", "Its personality (SOUL.md)", await read("SOUL.md")),
    textItem("openclaw", "memory", "workspace/USER.md", "What OpenClaw knew about you", await read("USER.md"), "person"),
    textItem("openclaw", "memory", "workspace/MEMORY.md", "What OpenClaw remembered", await read("MEMORY.md"), "world"),
  ];
  for (const note of await workspace.list("memory"))
    if (note.kind === "file" && note.name.endsWith(".md"))
      items.push(textItem("openclaw", "memory", `workspace/memory/${note.name}`, `Notes: ${note.name}`,
        await read(`memory/${note.name}`), "world"));
  return [...items.filter((item): item is FoundItem => item !== null),
    ...await skillsIn(workspace, "openclaw", "skills", [], "workspace/")];
}

function configItems(config: Record<string, unknown>, keys: KeyPrompt[]): FoundItem[] {
  const items = serverItems("openclaw", "openclaw.json", asRecord(asRecord(config.mcp).servers), keys);
  for (const [id, provider] of Object.entries(asRecord(asRecord(config.models).providers))) {
    const locker = asRecord(provider).apiKey !== undefined ? lockerName(`${id}_API_KEY`) : null;
    if (locker) keys.push({ name: locker, why: `OpenClaw used it for ${id}` });
  }
  for (const name of Object.keys(asRecord(asRecord(config.env).vars))) {
    const locker = secretLike(name) ? lockerName(name) : null;
    if (locker) keys.push({ name: locker, why: "OpenClaw passed it to its programs" });
  }
  const chosen = asRecord(asRecord(config.agents).defaults).model;
  const model = typeof chosen === "string" ? chosen : asString(asRecord(chosen).primary);
  if (model) items.push(found("openclaw", "setting", "openclaw.json#model", `Model: ${model}`,
    "The model you chose. Branch suggests it when you connect a model.", { kind: "setting", name: "model", value: model }));
  return items;
}

export async function scanOpenClaw({ tree }: ScanInput): Promise<ScanResult> {
  const keys: KeyPrompt[] = [], notes: string[] = [], closers: (() => Promise<void>)[] = [];
  const config = readConfig(await tree.read("openclaw.json", 4 * 1024 * 1024) ?? await tree.read("clawdbot.json", 4 * 1024 * 1024), notes);
  const items = [...await workspaceItems(workspaceOf(tree, config, notes)), ...await skillsIn(tree, "openclaw", "skills")];
  items.push(...configItems(config, keys));
  for (const name of envNames(await tree.read(".env", 256 * 1024))) {
    const locker = lockerName(name);
    if (locker) keys.push({ name: locker, why: "OpenClaw kept it in its .env file" });
  }
  items.push(...await chatItems(tree, closers));
  if ((await tree.list("")).some((entry) => entry.name === "credentials"))
    notes.push("Your OpenClaw sign-ins and chat-app pairings stay with OpenClaw. Connect them again under Settings.");
  return { items, keys: mergeKeys(keys), notes, close: async () => { for (const close of closers) await close(); } };
}


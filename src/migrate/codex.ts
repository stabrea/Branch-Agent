import {
  asRecord, asString, chatRefusal, found, jsonLines, mergeKeys, projectNameFor,
  serverItems, skillsIn, textItem, tidyMessages,
} from "./common.js";
import type { ScanInput } from "./scan.js";
import type { SourceTree } from "./source-tree.js";
import { parseToml } from "./toml.js";
import { clip, lockerName, type FoundItem, type KeyPrompt, type MovedMessage, type ScanResult } from "./types.js";

/**
 * Codex CLI keeps everything under `~/.codex` (or `$CODEX_HOME`): chats as JSON lines in
 * `sessions/YYYY/MM/DD/rollout-*.jsonl`, their names in `session_index.jsonl`, instructions in
 * `AGENTS.md` (or `AGENTS.override.md`), settings and tool servers in `config.toml`, and skills in
 * `skills/` and `~/.agents/skills/`. Its sign-in (`auth.json`) is never opened, and the model's
 * reasoning in a chat is never brought over.
 */
const chatLimit = 2000, chatBytes = 64 * 1024 * 1024;
/** Text Codex adds to the conversation itself, which the owner never typed. */
const injected = /^\s*(<environment_context>|<user_instructions>|<INSTRUCTIONS>|<turn_aborted>|# AGENTS\.md instructions|<user_shell_command>)/;

function wordsOf(content: unknown): string {
  if (!Array.isArray(content)) return asString(content);
  return content.map(asRecord)
    .filter((part) => part.type === "input_text" || part.type === "output_text" || part.type === "text")
    .map((part) => asString(part.text)).join("\n");
}

export interface CodexChat { id: string; folder: string; messages: MovedMessage[] }

export function readCodexChat(text: string): CodexChat {
  const rows = jsonLines(text);
  const typed = rows.some((row) => row.type === "event_msg" && asRecord(row.payload).type === "user_message");
  const raw: MovedMessage[] = [];
  let id = "", folder = "";
  for (const row of rows) {
    const payload = asRecord(row.payload);
    if (row.type === "session_meta") { id ||= asString(payload.id) || asString(payload.session_id); folder ||= asString(payload.cwd); }
    if (row.type === "event_msg" && payload.type === "user_message" && typed)
      raw.push({ role: "user", content: asString(payload.message) });
    if (row.type !== "response_item" || payload.type !== "message") continue;
    const words = wordsOf(payload.content);
    if (payload.role === "assistant") raw.push({ role: "assistant", content: words });
    if (payload.role === "user" && !typed && !injected.test(words)) raw.push({ role: "user", content: words });
  }
  return { id, folder, messages: tidyMessages(raw) };
}

/** Every rollout file, newest first, walking the dated folders. */
async function rollouts(tree: SourceTree): Promise<{ path: string; modifiedMs: number }[]> {
  const files: { path: string; modifiedMs: number }[] = [];
  const pending = ["sessions"];
  for (let depth = 0; depth < 5 && pending.length; depth++)
    for (const dir of pending.splice(0)) for (const entry of await tree.list(dir)) {
      if (entry.kind === "dir") pending.push(`${dir}/${entry.name}`);
      else if (/^rollout-.*\.jsonl$/.test(entry.name)) files.push({ path: `${dir}/${entry.name}`, modifiedMs: entry.modifiedMs });
    }
  return files.sort((a, b) => b.modifiedMs - a.modifiedMs || b.path.localeCompare(a.path));
}

async function chatItems(tree: SourceTree, folders: Set<string>, notes: string[]): Promise<FoundItem[]> {
  const names = new Map<string, string>();
  for (const row of jsonLines((await tree.read("session_index.jsonl", 16 * 1024 * 1024)) ?? ""))
    if (typeof row.id === "string" && typeof row.thread_name === "string") names.set(row.id, row.thread_name);
  const files = await rollouts(tree), best = new Map<string, { path: string; chat: CodexChat }>();
  if (files.length > chatLimit) notes.push(`${files.length - chatLimit} older Codex chats are not listed; Branch shows the newest ${chatLimit}.`);
  for (const file of files.slice(0, chatLimit)) {
    const text = await tree.read(file.path, chatBytes);
    if (text === null) continue;
    const chat = readCodexChat(text), id = chat.id || file.path;
    // A resumed chat is written again under the same id; the fullest copy is the one to bring.
    if ((best.get(id)?.chat.messages.length ?? -1) < chat.messages.length) best.set(id, { path: file.path, chat });
  }
  return [...best].map(([id, { path, chat }]) => {
    if (chat.folder) folders.add(chat.folder);
    const refusal = chatRefusal(chat.messages);
    const title = names.get(id) || chat.messages.find((message) => message.role === "user")?.content || "A chat";
    return found("codex", "chat", `session:${id}`, clip(title, 120),
      refusal ?? `${chat.messages.length} messages${chat.folder ? `, in ${chat.folder}` : ""}.`,
      refusal ? null : async () => {
        const again = readCodexChat((await tree.read(path, chatBytes)) ?? "");
        return { kind: "chat", messages: again.messages, folder: again.folder };
      });
  });
}

function configItems(config: Record<string, unknown>, keys: KeyPrompt[], folders: Set<string>): FoundItem[] {
  const servers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(asRecord(config.mcp_servers))) {
    const raw = { ...asRecord(value) };
    // Codex names the variables a server reads in `env_vars`; only their names ever come over.
    for (const variable of Array.isArray(raw.env_vars) ? raw.env_vars : []) {
      const locker = typeof variable === "string" ? lockerName(variable) : null;
      if (locker) raw.env = { ...asRecord(raw.env), [locker]: "" };
    }
    servers[name] = raw;
  }
  const items = serverItems("codex", "config.toml", servers, keys);
  const model = asString(config.model);
  if (model) items.push(found("codex", "setting", "config.toml#model", `Model: ${model}`,
    "The model you chose. Branch suggests it when you connect a model.", { kind: "setting", name: "model", value: model }));
  for (const folder of Object.keys(asRecord(config.projects))) folders.add(folder);
  return items;
}

function projectItems(folders: Set<string>, chats: FoundItem[]): FoundItem[] {
  return [...folders].map((folder) => {
    const count = chats.filter((chat) => chat.detail.endsWith(`in ${folder}.`)).length;
    return found("codex", "project", `project:${folder}`, projectNameFor(folder),
      `${count} chat${count === 1 ? "" : "s"} in ${folder}. Becomes the project "${projectNameFor(folder)}".`,
      { kind: "project", name: projectNameFor(folder), folder });
  });
}

export async function scanCodex({ tree, extras }: ScanInput): Promise<ScanResult> {
  const keys: KeyPrompt[] = [], notes: string[] = [], folders = new Set<string>(), items: FoundItem[] = [];
  const override = await tree.read("AGENTS.override.md", 512 * 1024);
  const instructions = textItem("codex", "instructions", override !== null ? "AGENTS.override.md" : "AGENTS.md",
    "Your instructions (AGENTS.md)", override ?? (await tree.read("AGENTS.md", 512 * 1024)) ?? "");
  if (instructions) items.push(instructions);
  const memory = textItem("codex", "memory", "memories/MEMORY.md", "What Codex remembered",
    (await tree.read("memories/MEMORY.md", 512 * 1024)) ?? "");
  if (memory) items.push(memory);
  items.push(...await skillsIn(tree, "codex", "skills", [".system"]));
  if (extras["agents-skills"]) items.push(...await skillsIn(extras["agents-skills"], "codex", "", [], "agents-skills:"));
  const configText = await tree.read("config.toml", 1024 * 1024);
  try { items.push(...configItems(configText ? parseToml(configText) : {}, keys, folders)); }
  catch (error) { notes.push(`${(error as Error).message}. Its tool servers and settings are not listed.`); }
  const chats = await chatItems(tree, folders, notes);
  items.push(...projectItems(folders, chats), ...chats);
  if ((await tree.list("")).some((entry) => entry.name === "auth.json"))
    notes.push("Your ChatGPT or OpenAI sign-in stays with Codex. To use it here, sign in under Settings.");
  return { items, keys: mergeKeys(keys), notes };
}


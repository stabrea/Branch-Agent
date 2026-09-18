import {
  asRecord, asString, chatRefusal, found, jsonLines, mergeKeys, parseJson, projectIdFor, projectNameFor,
  serverItems, skillsIn, textItem, tidyMessages,
} from "./common.js";
import type { ScanInput } from "./scan.js";
import type { SourceTree } from "./source-tree.js";
import { clip, lockerName, secretLike, type FoundItem, type KeyPrompt, type MovedMessage, type ScanResult } from "./types.js";

/**
 * Claude Code keeps everything under `~/.claude` (or `$CLAUDE_CONFIG_DIR`): chats as JSON lines in
 * `projects/<folder>/<id>.jsonl`, per-folder memory in `projects/<folder>/memory/`, instructions in
 * `CLAUDE.md`, skills in `skills/<name>/SKILL.md`, and settings in `settings.json`. Tool servers are
 * in `~/.claude.json`, beside the folder. Its sign-in (`.credentials.json`) is never opened.
 */
export const chatLimit = 2000;
const chatBytes = 64 * 1024 * 1024;
const noise = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/;

/** The text of a Claude message: plain text blocks only; thinking, tool use and pictures are left out. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(asRecord).filter((block) => block.type === "text").map((block) => asString(block.text)).join("\n");
}

const cleanUserText = (text: string): string =>
  text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/^\s*<user_query>([\s\S]*)<\/user_query>\s*$/, "$1");

/** The line of the conversation the owner last saw: walk back from the last message along `parentUuid`. */
function activeBranch(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const byId = new Map(rows.filter((row) => typeof row.uuid === "string").map((row) => [row.uuid as string, row]));
  const talk = rows.filter((row) => row.type === "user" || row.type === "assistant");
  const last = talk[talk.length - 1];
  if (!last || typeof last.uuid !== "string") return talk;
  const chain: Record<string, unknown>[] = [];
  for (let row: Record<string, unknown> | undefined = last; row && chain.length <= rows.length;
    row = byId.get(asString(row.parentUuid))) chain.push(row);
  return chain.reverse().filter((row) => row.type === "user" || row.type === "assistant");
}

export interface ClaudeChat { messages: MovedMessage[]; title: string; folder: string }

export function readClaudeChat(text: string): ClaudeChat {
  const rows = jsonLines(text);
  const titled = [...rows].reverse().find((row) => row.type === "custom-title" || row.type === "ai-title" || row.type === "summary");
  const raw: MovedMessage[] = [];
  let folder = "";
  for (const row of activeBranch(rows)) {
    if (row.isSidechain === true || row.isMeta === true) continue;
    folder ||= asString(row.cwd);
    const message = asRecord(row.message);
    if (message.model === "<synthetic>") continue;
    const words = textOf(message.content);
    if (row.type === "user" && !noise.test(words)) raw.push({ role: "user", content: cleanUserText(words) });
    if (row.type === "assistant") raw.push({ role: "assistant", content: words });
  }
  const messages = tidyMessages(raw);
  const title = asString(titled?.customTitle) || asString(titled?.aiTitle) || asString(titled?.summary)
    || messages.find((message) => message.role === "user")?.content || "A chat";
  return { messages, title: clip(title, 120), folder };
}

async function chatItems(tree: SourceTree, folders: Map<string, string>, notes: string[]): Promise<FoundItem[]> {
  const files: { path: string; modifiedMs: number; size: number; project: string }[] = [];
  for (const project of await tree.list("projects"))
    if (project.kind === "dir")
      for (const file of await tree.list(`projects/${project.name}`))
        if (file.kind === "file" && file.name.endsWith(".jsonl"))
          files.push({ path: `projects/${project.name}/${file.name}`, modifiedMs: file.modifiedMs, size: file.size, project: project.name });
  files.sort((a, b) => b.modifiedMs - a.modifiedMs);
  if (files.length > chatLimit) notes.push(`${files.length - chatLimit} older Claude Code chats are not listed; Branch shows the newest ${chatLimit}.`);
  const items: FoundItem[] = [];
  for (const file of files.slice(0, chatLimit)) {
    const text = await tree.read(file.path, chatBytes);
    if (text === null) {
      items.push(found("claude-code", "chat", file.path, file.path.split("/").pop()!, "It is larger than Branch will read.", null));
      continue;
    }
    const chat = readClaudeChat(text);
    if (chat.folder && !folders.has(file.project)) folders.set(file.project, chat.folder);
    const refusal = chatRefusal(chat.messages);
    const detail = refusal ?? `${chat.messages.length} messages${chat.folder ? `, in ${chat.folder}` : ""}.`;
    items.push(found("claude-code", "chat", file.path, chat.title, detail, refusal ? null : async () => {
      const again = readClaudeChat((await tree.read(file.path, chatBytes)) ?? "");
      return { kind: "chat", messages: again.messages, folder: again.folder };
    }));
  }
  return items;
}

/** Every `.md` file under a project's `memory/` folder, two levels deep, as saved facts about that project. */
async function memoryItems(tree: SourceTree, folders: Map<string, string>): Promise<FoundItem[]> {
  const items: FoundItem[] = [];
  for (const project of await tree.list("projects")) {
    if (project.kind !== "dir") continue;
    const folder = folders.get(project.name) ?? project.name, base = `projects/${project.name}/memory`;
    const pending = [base];
    for (let depth = 0; depth < 3 && pending.length; depth++)
      for (const dir of pending.splice(0)) for (const entry of await tree.list(dir)) {
        const path = `${dir}/${entry.name}`;
        if (entry.kind === "dir") { pending.push(path); continue; }
        if (!entry.name.endsWith(".md")) continue;
        const item = textItem("claude-code", "memory", path, `${projectNameFor(folder)}: ${entry.name}`,
          (await tree.read(path, 512 * 1024)) ?? "", "project", projectIdFor(folder));
        if (item) items.push(item);
      }
  }
  return items;
}

function projectItems(folders: Map<string, string>, chats: FoundItem[]): FoundItem[] {
  return [...folders].map(([encoded, folder]) => {
    const count = chats.filter((chat) => chat.origin.startsWith(`projects/${encoded}/`)).length;
    return found("claude-code", "project", `projects/${encoded}`, projectNameFor(folder),
      `${count} chat${count === 1 ? "" : "s"} in ${folder}. Becomes the project "${projectNameFor(folder)}".`,
      { kind: "project", name: projectNameFor(folder), folder });
  });
}

function settingItems(settings: Record<string, unknown>, keys: KeyPrompt[]): FoundItem[] {
  for (const name of Object.keys(asRecord(settings.env))) {
    const locker = lockerName(name);
    if (locker && secretLike(name)) keys.push({ name: locker, why: "Claude Code passed it to its programs" });
  }
  const model = asString(settings.model);
  return model ? [found("claude-code", "setting", "settings.json#model", `Model: ${model}`,
    "The model you chose. Branch suggests it when you connect a model.", { kind: "setting", name: "model", value: model })] : [];
}

function mcpItems(claudeJson: Record<string, unknown>, keys: KeyPrompt[]): FoundItem[] {
  const items = serverItems("claude-code", ".claude.json", asRecord(claudeJson.mcpServers), keys);
  for (const [folder, project] of Object.entries(asRecord(claudeJson.projects)))
    items.push(...serverItems("claude-code", `.claude.json#${folder}`, asRecord(asRecord(project).mcpServers), keys));
  return items;
}

export async function scanClaudeCode({ tree, extras }: ScanInput): Promise<ScanResult> {
  const keys: KeyPrompt[] = [], notes: string[] = [], folders = new Map<string, string>();
  const items: FoundItem[] = [];
  const instructions = textItem("claude-code", "instructions", "CLAUDE.md", "Your instructions (CLAUDE.md)",
    (await tree.read("CLAUDE.md", 512 * 1024)) ?? "");
  if (instructions) items.push(instructions);
  items.push(...await skillsIn(tree, "claude-code", "skills"));
  const claudeJson = parseJson(await (extras["claude-json"] ?? tree).read(".claude.json", 16 * 1024 * 1024));
  items.push(...mcpItems(claudeJson, keys));
  items.push(...settingItems(parseJson(await tree.read("settings.json", 1024 * 1024)), keys));
  const chats = await chatItems(tree, folders, notes);
  items.push(...await memoryItems(tree, folders), ...projectItems(folders, chats), ...chats);
  if ((await tree.list("")).some((entry) => entry.name === ".credentials.json"))
    notes.push("Your Claude sign-in stays with Claude Code. To use Claude here, connect it under Settings.");
  if ((await tree.list("commands")).length || (await tree.list("agents")).length)
    notes.push("Claude Code's custom commands and subagents are not brought over.");
  return { items, keys: mergeKeys(keys), notes };
}

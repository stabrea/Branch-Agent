import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { hiddenMarker, redactLeaks } from "../leak-guard.js";
import { layerForKind } from "../memory-layers.js";
import type { MemoryRecord } from "../memory.js";
import { readClaudeChat } from "../migrate/claude-code.js";
import { readCodexChat } from "../migrate/codex.js";
import { placesFor, type PlaceInput } from "../migrate/detect.js";
import { folderTree, type SourceTree } from "../migrate/source-tree.js";
import type { Store } from "../store.js";
import { learningSettings, saveLearningSettings } from "./settings.js";

/**
 * R17-057: learning how the owner likes things done from their own past Claude Code and Codex
 * chats. It is off twice over: the part's switch, and one opt-in per assistant, each off. Then:
 *
 * - Only the owner's own chat files are opened: Claude Code's `projects/` and Codex's `sessions/`,
 *   inside that assistant's home folder, through the read-only, link-refusing view move-in uses.
 *   Nothing else in those folders can be reached — not `.credentials.json`, not `auth.json`, not
 *   settings — and a file whose name looks like a sign-in is refused again by name.
 * - Only what the owner typed is read, never the assistants' replies, and only sentences that say
 *   how they like things done ("I prefer…", "always…", "never…", "from now on…").
 * - A sentence has to come up in at least two separate chats. One that held a key-like value is
 *   dropped whole, not shortened.
 * - Nothing is kept on its own. The scan returns exactly what would be remembered; only the
 *   owner's press on chosen items saves them, as preferences.
 *
 * The idea follows Letta Code's history analyser (Apache-2.0); it asks a model, this does not.
 * See THIRD_PARTY_NOTICES.md.
 */
export const sessionSources = ["claude-code", "codex"] as const;
export type SessionSource = (typeof sessionSources)[number];
export const SourcesSchema = z.object({
  "claude-code": z.boolean().default(false),
  codex: z.boolean().default(false),
  /** How many separate chats a preference has to come up in. */
  minChats: z.number().int().min(2).max(20).default(2),
}).strict();
export type SessionSourceSettings = z.infer<typeof SourcesSchema>;
export const sourcesKey = "learning-more-session-sources";
const handledKey = "learning-more-session-handled";
export const KeepSchema = z.object({ ids: z.array(z.string().regex(/^[a-f0-9]{16}$/)).min(1).max(50) }).strict();
export const DeclineSchema = KeepSchema;
export const chatFilesRead = 200;
const chatBytes = 16 * 1024 * 1024;
/** Integration review: the most read from one assistant's chats in one look, all files together. */
export const scanBytes = 256 * 1024 * 1024;
/** "[hidden key-like value", the start of what the leak guard leaves where it hid something. */
export const hiddenPrefix = hiddenMarker("").split(":")[0]!;
const signInName = /(credential|auth\.json|token|secret|\.env|keychain|password)/i;
const preference = /\b(i (?:really |always |usually |generally )?(?:prefer|like|want|love|hate|dislike|don't like|do not like|don't want|do not want)|always|never|from now on|by default|in general|going forward|stop (?:using|adding|writing))\b/i;

export interface Candidate {
  id: string; text: string; source: SessionSource; chats: number;
  seenIn: { file: string; title: string }[];
}
export interface ScanReport { candidates: Candidate[]; read: Record<SessionSource, number>; note: string }

const normal = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const idOf = (source: SessionSource, key: string): string => createHash("sha256").update(`${source}:${key}`).digest("hex").slice(0, 16);

/** Sentences in the owner's own words that say how they like things done. */
export function preferenceSentences(text: string): string[] {
  return text.replace(/```[\s\S]*?```/g, " ").split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim())
    .filter((part) => part.length >= 12 && part.length <= 200 && preference.test(part) && !/[{}<>]|https?:\/\//.test(part));
}

async function chatFiles(tree: SourceTree, source: SessionSource): Promise<{ path: string; modifiedMs: number }[]> {
  const files: { path: string; modifiedMs: number }[] = [];
  const pending = [source === "claude-code" ? "projects" : "sessions"];
  for (let depth = 0; depth < 5 && pending.length; depth++)
    for (const dir of pending.splice(0)) for (const entry of await tree.list(dir)) {
      if (entry.kind === "dir") { if (!(source === "claude-code" && entry.name === "memory")) pending.push(`${dir}/${entry.name}`); }
      else if (entry.name.endsWith(".jsonl") && !signInName.test(entry.name)) files.push({ path: `${dir}/${entry.name}`, modifiedMs: entry.modifiedMs });
    }
  return files.sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, chatFilesRead);
}

/**
 * Integration review: text the assistant's program put in the owner's turn — command output, agent and
 * task notices (`<bash-stdout>`, `<task-notification>` and the like) — is cut out, and a summary a chat
 * was compacted into (`isCompactSummary`) is not the owner's either, so neither can pose as a preference.
 */
const withoutTagged = (text: string): string => text.replace(/<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/g, " ");
const withoutSummaries = (text: string): string =>
  text.split("\n").filter((line) => !/"isCompactSummary"\s*:\s*true/.test(line)).join("\n");

/** The owner's own messages in one chat file, and a title for it. */
export function ownerWords(source: SessionSource, text: string): { title: string; words: string[] } {
  if (source === "claude-code") {
    const chat = readClaudeChat(withoutSummaries(text));
    return { title: chat.title, words: chat.messages.filter((m) => m.role === "user").map((m) => withoutTagged(m.content)) };
  }
  const chat = readCodexChat(text);
  const words = chat.messages.filter((m) => m.role === "user").map((m) => withoutTagged(m.content));
  return { title: (words[0] ?? "A Codex chat").slice(0, 120), words };
}

export class SessionLessons {
  constructor(private readonly store: Store, private readonly place: () => PlaceInput,
    private readonly treeFor: (root: string, only: string[]) => SourceTree = folderTree) {}

  settings(owner: string): SessionSourceSettings { return learningSettings(this.store, owner, sourcesKey, SourcesSchema); }
  configure(owner: string, input: unknown): SessionSourceSettings { return saveLearningSettings(this.store, owner, sourcesKey, SourcesSchema, input); }

  /** Where each assistant's chats would be read from, for the card; nothing is opened. */
  folders(): Record<SessionSource, string> {
    const places = placesFor(this.place());
    return { "claude-code": places.find((p) => p.source === "claude-code")!.root, codex: places.find((p) => p.source === "codex")!.root };
  }

  async scan(owner: string): Promise<ScanReport> {
    const settings = this.settings(owner);
    const chosen = sessionSources.filter((source) => settings[source]);
    if (!chosen.length) throw new Error("Choose which assistant's chats to learn from first. Both are off.");
    const read: Record<SessionSource, number> = { "claude-code": 0, codex: 0 };
    const known = new Set((this.store.list("memory", owner) as MemoryRecord[]).map((record) => normal(String(record.data.text))));
    const handled = this.handled(owner);
    const candidates: Candidate[] = [];
    for (const source of chosen) {
      const found = await this.gather(source, read);
      for (const [key, entry] of found) {
        const id = idOf(source, key);
        if (entry.files.length < settings.minChats || known.has(key) || handled.has(id)) continue;
        candidates.push({ id, text: entry.text, source, chats: entry.files.length, seenIn: entry.files.slice(0, 3) });
      }
    }
    candidates.sort((a, b) => b.chats - a.chats || a.text.localeCompare(b.text));
    return { candidates: candidates.slice(0, 50), read,
      note: "Only what you typed was read, and nothing is kept until you choose it." };
  }

  /** Saves the chosen candidates as preferences, from a fresh scan so only what was shown can be kept. */
  async keep(owner: string, input: unknown): Promise<{ kept: MemoryRecord[] }> {
    const { ids } = KeepSchema.parse(input);
    const shown = new Map((await this.scan(owner)).candidates.map((candidate) => [candidate.id, candidate]));
    if (ids.some((id) => !shown.has(id))) throw new Error("Only a preference from the latest look can be kept. Look again.");
    const kept = ids.map((id) => {
      const candidate = shown.get(id)!;
      const from = candidate.source === "claude-code" ? "Claude Code" : "Codex";
      return this.store.save("memory", owner, randomUUID(), { text: candidate.text, kind: "preference", layer: layerForKind("preference"),
        source: `Learned from your ${from} chats (said in ${candidate.chats} of them); you chose to keep it` }) as MemoryRecord;
    });
    this.remember(owner, ids);
    return { kept };
  }

  /** Candidates the owner does not want are not offered again. */
  decline(owner: string, input: unknown): { declined: number } {
    const { ids } = DeclineSchema.parse(input);
    this.remember(owner, ids);
    return { declined: ids.length };
  }

  private async gather(source: SessionSource, read: Record<SessionSource, number>) {
    const root = this.folders()[source];
    const tree = this.treeFor(root, [source === "claude-code" ? "projects" : "sessions"]);
    const found = new Map<string, { text: string; files: { file: string; title: string }[] }>();
    let bytes = 0;
    for (const file of await chatFiles(tree, source)) {
      const text = await tree.read(file.path, Math.min(chatBytes, scanBytes - bytes));
      if (text === null) continue;
      bytes += Buffer.byteLength(text);
      read[source] += 1;
      const chat = ownerWords(source, text);
      const seen = new Set<string>();
      for (const sentence of chat.words.flatMap(preferenceSentences)) {
        // The chat readers already hide key-like values, so a hidden marker counts as a key too.
        const redacted = redactLeaks(sentence);
        const key = normal(sentence);
        if (redacted.kinds.length || sentence.includes(hiddenPrefix) || !key || seen.has(key)) continue;
        seen.add(key);
        const entry = found.get(key) ?? { text: sentence, files: [] };
        entry.files.push({ file: file.path, title: chat.title.slice(0, 120) });
        found.set(key, entry);
      }
    }
    return found;
  }
  private handled(owner: string): Set<string> {
    return new Set(((this.store.get("settings", owner, handledKey)?.data as { ids?: string[] } | undefined)?.ids) ?? []);
  }
  private remember(owner: string, ids: string[]): void {
    const all = [...new Set([...this.handled(owner), ...ids])].slice(-2000);
    this.store.save("settings", owner, handledKey, { ids: all });
  }
}

import { extname, basename, resolve } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";
import type { ImagePart } from "./contracts.js";
import { parseImages } from "./contracts.js";
import { conversationMarkdown } from "./memory-export.js";
import { tryReadDocument } from "./document-readers.js";
import { knownExtension } from "./document-text.js";
import { estimateCost, formatCost, pricingSettings } from "./pricing.js";
import { policyPresets, readPolicy, savePolicy, type PolicyPresetName } from "./policy.js";
import type { Runtime } from "./runtime.js";

/**
 * The parts of the terminal view that are worth keeping away from the drawing code: the status
 * line's figures, attaching a file to the next message, the approval presets, and writing a
 * conversation out. Each one is a plain function over the runtime, so it can be tested on its own.
 */
export interface SessionTotals {
  input: number;
  output: number;
  cost: string;
}
const short = (count: number): string => (count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count));

/** Tokens used and money spent so far in one conversation, across every task in it. */
export function sessionTotals(runtime: Runtime, sessionId: string | undefined, model: string): SessionTotals {
  let input = 0, output = 0;
  for (const run of sessionId ? runtime.store.runs(runtime.owner).filter((r) => r.sessionId === sessionId) : []) {
    const usage = runtime.store.usage(run.id);
    input += usage.reportedInput || usage.estimatedInput || 0;
    output += usage.reportedOutput || usage.estimatedOutput || 0;
  }
  const { overrides } = pricingSettings(runtime.store, runtime.owner);
  return { input, output, cost: formatCost(estimateCost(model, { input, output }, overrides)) };
}

/**
 * What one answer used and cost on its own. The status line has always carried the running totals
 * for the whole conversation; this is the same reckoning for the task that has just finished, so
 * the terminal says what each answer cost as well as what the conversation has cost so far.
 */
export function runTotals(runtime: Runtime, runId: string, model: string): SessionTotals {
  const usage = runtime.store.usage(runId);
  const input = usage.reportedInput || usage.estimatedInput || 0;
  const output = usage.reportedOutput || usage.estimatedOutput || 0;
  const { overrides } = pricingSettings(runtime.store, runtime.owner);
  return { input, output, cost: formatCost(estimateCost(model, { input, output }, overrides)) };
}
/** The one line printed under an answer; empty when nothing was counted, so nothing is said. */
export function answerLine(totals: SessionTotals): string {
  if (!totals.input && !totals.output) return "";
  return `[this answer: ${short(totals.input)} in / ${short(totals.output)} out · ${totals.cost}]`;
}
/** The model behind a named preset, which is what the prices are looked up under. */
export function activeModel(runtime: Runtime, presetId: string | undefined): string {
  const summary = runtime.models.summary(runtime.owner);
  const active = presetId ?? summary.activePreset ?? summary.defaultPreset;
  return runtime.models.presets.get(active)?.model ?? active;
}

/** The one line that always sits above what the person is typing. */
export function statusLine(runtime: Runtime, sessionId: string | undefined, presetId: string | undefined, width: number): string {
  const summary = runtime.models.summary(runtime.owner);
  const active = presetId ?? summary.activePreset ?? summary.defaultPreset;
  const preset = runtime.models.presets.get(active);
  const totals = sessionTotals(runtime, sessionId, preset?.model ?? active);
  const policy = readPolicy(runtime.store, runtime.owner);
  const label = policyPresets().find((entry) => entry.id === policy.preset)?.label ?? "Rules I set myself";
  const line = `${preset?.name ?? active} · ${short(totals.input)} in / ${short(totals.output)} out · ${totals.cost} · ${label}`;
  return line.length > width ? line.slice(0, Math.max(10, width - 1)) + "…" : line;
}

/** Every approval preset, one line each, with a mark against the one in force. */
export function presetLines(runtime: Runtime): string[] {
  const current = readPolicy(runtime.store, runtime.owner).preset;
  return policyPresets().map((preset) => `${preset.id === current ? "*" : " "} ${preset.id} — ${preset.label}: ${preset.description}`);
}

/** Changes which approval preset is in force, exactly as the app's settings screen does. */
export function choosePreset(runtime: Runtime, name: string): string {
  const known = policyPresets().map((preset) => preset.id);
  if (!known.includes(name as PolicyPresetName)) throw new Error(`Pick one of: ${known.join(", ")}`);
  const saved = savePolicy(runtime.store, runtime.owner, { preset: name });
  const label = policyPresets().find((preset) => preset.id === saved.preset)?.label ?? saved.preset;
  return `[when to check with me: ${label}]`;
}

export interface Attachment {
  name: string;
  /** What kind of file this is, so the terminal and the model treat it right. */
  kind: "image" | "audio" | "video" | "document" | "text";
  /** A picture the model can look at, when the file is one. */
  image?: ImagePart;
  /** The words of a text file, or of a document a reader could lift them out of. */
  text?: string;
  /**
   * The recognised media type, kept for every kind but text (which speaks for itself once read).
   * With `path`, it goes with the message so the model knows what was attached and where it is.
   */
  mediaType?: string;
  /** Where the original file lives on disk, kept for every kind but plain text. */
  path?: string;
  /** What could not be read from a document, or that its words were cut short, in plain words. */
  limits?: string[];
}
const imageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const audioTypes: Record<string, string> = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".flac": "audio/flac" };
const videoTypes: Record<string, string> = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo" };
const documentTypes: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docm": "application/vnd.ms-word.document.macroEnabled.12", ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  ".odt": "application/vnd.oasis.opendocument.text", ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".epub": "application/epub+zip", ".rtf": "application/rtf",
};
const maxAttachedText = 20000;

/**
 * Reads a file to send with the next message: a picture as a picture the model can look at, plain
 * text as words added to the message, a document as its reference plus the words a reader lifts out
 * of it, and a sound or a video as a kept reference — its kind, its media type and its path.
 */
export async function readAttachment(path: string): Promise<Attachment> {
  const full = resolve(path), name = basename(full), ext = extname(full).toLowerCase();
  const imageType = imageTypes[ext];
  if (imageType) {
    const [image] = parseImages([{ mediaType: imageType, data: (await readFile(full)).toString("base64"), name }]);
    return { name, kind: "image", image: image!, mediaType: imageType, path: full };
  }
  const audioType = audioTypes[ext];
  if (audioType) return referenceOnly(full, name, "audio", audioType);
  const videoType = videoTypes[ext];
  if (videoType) return referenceOnly(full, name, "video", videoType);
  const documentMedia = documentTypes[ext];
  if (documentMedia) return readDocumentAttachment(full, name, documentMedia);
  const text = await readFile(full, "utf8");
  if (text.length > maxAttachedText) throw new Error(`${name} is too long to attach; paste the part that matters instead`);
  return { name, kind: "text", text };
}

/**
 * A sound or a video (or a document before its words are read) is kept by reference: its bytes are
 * too big to carry in a message and are not something the model can look at directly. The file is still checked so
 * that attaching one that does not exist fails plainly here, instead of only surfacing later.
 */
async function referenceOnly(path: string, name: string, kind: "audio" | "video" | "document", mediaType: string): Promise<Attachment> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${name} is not a file`);
  return { name, kind, mediaType, path };
}

/**
 * A document keeps its reference and, when a reader exists for its kind, its words too, the way a
 * document was read into the message before it had a kind of its own. A kind with no reader (an
 * old .doc, .xls or .ppt) or a file the reader refuses is still attached, by reference, with the
 * reason said, rather than decoded as garbage or dropped.
 */
async function readDocumentAttachment(path: string, name: string, mediaType: string): Promise<Attachment> {
  const kept = await referenceOnly(path, name, "document", mediaType);
  if (!knownExtension(name)) return { ...kept, limits: ["There is no reader in this build for that kind of file"] };
  const read = tryReadDocument(await readFile(path), name);
  if (!read.document) return { ...kept, limits: [read.reason] };
  const { text, limits } = read.document;
  if (text.length <= maxAttachedText) return { ...kept, text, limits };
  return { ...kept, text: text.slice(0, maxAttachedText),
    limits: [...limits, `Only the first ${maxAttachedText} characters are here; the rest is in the file itself.`] };
}

/**
 * What the attached files add to the message the person typed: one block per file, headed with
 * its kind, name, media type and where it is, then its words when it has any. A picture's bytes
 * go separately as a picture; its block tells the model which file that picture was.
 */
export function attachedText(attachments: Attachment[]): string {
  if (!attachments.length) return "";
  return "\n\n" + attachments.map(attachedBlock).join("\n\n");
}
function attachedBlock(file: Attachment): string {
  if (file.kind === "text") return `--- attached file: ${file.name} ---\n${file.text ?? ""}`;
  const head = `--- attached ${file.kind}: ${file.name} (${file.mediaType ?? "unknown type"}) at ${file.path ?? "unknown place"} ---`;
  const body = file.kind === "image" ? "[sent as a picture with this message]"
    : file.text !== undefined ? file.text
    : `[not read into this message; the file is at the path above]`;
  const limits = (file.limits ?? []).map((limit) => `[${limit}]`);
  return [head, body, ...limits].join("\n");
}

/** The turns of this conversation so far, shortest useful form, newest last. */
export function historyLines(runtime: Runtime, sessionId: string | undefined, limit = 20): string[] {
  if (!sessionId) return ["Nothing yet in this conversation."];
  const turns = runtime.store.messages(sessionId).filter((message) => message.role === "user" || message.role === "assistant");
  if (!turns.length) return ["Nothing yet in this conversation."];
  return turns.slice(-limit).map((turn) => {
    const text = turn.content.replace(/\s+/g, " ").trim();
    return `${turn.role === "user" ? "you" : "assistant"}: ${text.length > 160 ? text.slice(0, 159) + "…" : text}`;
  });
}

/** Writes the conversation out as Markdown and answers with the file it wrote. */
export async function exportConversation(runtime: Runtime, sessionId: string | undefined, target?: string): Promise<string> {
  if (!sessionId) throw new Error("There is nothing to save yet; send a message first");
  const messages = runtime.store.messages(sessionId);
  const path = resolve(target ?? resolve(runtime.workspace, `conversation-${sessionId.slice(0, 8)}.md`));
  await writeFile(path, conversationMarkdown({ sessionId }, messages), { mode: 0o600 });
  return path;
}

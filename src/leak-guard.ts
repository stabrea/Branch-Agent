import type { Message } from "./contracts.js";
import type { PolicyOutcome } from "./policy.js";

/**
 * Keys never leave by accident. The locker's scrubber already takes out every secret Branch looked
 * up itself; this guard catches the ones it never saw — a key printed by a command, pasted into a
 * message or sitting in a file — by their shape. It runs over every tool result before the model
 * reads it and over every request before it goes to a model service, and it only ever hides a
 * value: the record says "a key-like value was hidden" and never what the value was.
 *
 * The shapes follow IronClaw's leak detector (MIT OR Apache-2.0, see THIRD_PARTY_NOTICES.md),
 * without its "any 64-letter hex string" warning, because ordinary hashes must pass untouched.
 */

export interface LeakHit { kind: string; start: number; end: number }
interface Detector {
  kind: string;
  /** Lower-case text that must appear before the pattern is tried at all. */
  hints: string[];
  pattern: RegExp;
  /** Which capture holds the value to hide; 0 means the whole match. */
  group?: number;
  accept?: (value: string) => boolean;
}

const hasDigit = (value: string): boolean => /\d/.test(value);
const mixed = (value: string): boolean => hasDigit(value) && /[A-Za-z]/.test(value);
const placeholder = /^(?:x+|\*+|\.+|pass|password|passwd|secret|token|changeme|redacted|hidden|example|none|null|undefined|your[_-].*|my[_-].*)$/i;

/** A value after `password:` or `Authorization:` that is really a value, not code or prose. */
export function looksLikeSecretValue(value: string): boolean {
  if (value.length < 6 || placeholder.test(value)) return false;
  if (/[(){}<>$`[\]]/.test(value)) return false;
  if (/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(value)) return false;
  // "Reset your password: https://…" names a page, not a password.
  if (/^[a-z][a-z0-9+.-]{0,31}:\/\//i.test(value)) return false;
  return hasDigit(value) || /[^A-Za-z0-9_.-]/.test(value);
}

/** True when a three-part dotted value opens with a real token header (a JSON object naming `alg`). */
export function isJsonWebToken(candidate: string): boolean {
  const parts = candidate.split(".");
  if (parts.length !== 3) return false;
  if (candidate.length > 16384) return true;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as unknown;
    return !!header && typeof header === "object" && !Array.isArray(header)
      && typeof (header as { alg?: unknown }).alg === "string";
  } catch { return false; }
}

const detectors: Detector[] = [
  { kind: "Anthropic key", hints: ["sk-ant-"], pattern: /\bsk-ant-[a-z]{3,6}\d{2}-[A-Za-z0-9_-]{32,}/g },
  { kind: "OpenRouter key", hints: ["sk-or-"], pattern: /\bsk-or-v\d-[A-Fa-f0-9]{40,}/g },
  { kind: "OpenAI key", hints: ["sk-"], pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9]{20,}[A-Za-z0-9_-]*/g, accept: mixed },
  { kind: "Stripe key", hints: ["_live_", "_test_"], pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g, accept: mixed },
  { kind: "AWS access key", hints: ["akia", "asia"], pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "AWS secret key", hints: ["aws_secret"], group: 2,
    pattern: /\b(aws_secret_access_key["']?\s*[:=]\s*["']?)([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi },
  { kind: "GitHub token", hints: ["gh"], pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, accept: mixed },
  { kind: "GitHub token", hints: ["github_pat_"], pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}/g },
  { kind: "Slack token", hints: ["xox"], pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, accept: hasDigit },
  { kind: "Slack webhook", hints: ["hooks.slack.com"], pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g },
  { kind: "Google key", hints: ["aiza"], pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "access token", hints: ["ey"], pattern: /(?<![A-Za-z0-9_-])ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, accept: isJsonWebToken },
  { kind: "sign-in header", hints: ["authorization"], group: 2,
    pattern: /\b(authorization["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token|bot|digest)\s+)?)([^\s"',;]+)/gi, accept: looksLikeSecretValue },
  { kind: "sign-in header", hints: ["bearer"], group: 2, pattern: /\b(Bearer\s+)([A-Za-z0-9._~+/-]{20,}=*)/g, accept: mixed },
  { kind: "password", hints: ["pass", "secret", "key", "token"], group: 2,
    pattern: /\b((?:password|passwd|passphrase|client[_-]?secret|secret[_-]?key|api[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["']?)([^\s"',;]+)/gi,
    accept: looksLikeSecretValue },
  { kind: "key in an address", hints: ["key=", "token=", "secret=", "password=", "passwd="], group: 2,
    pattern: /(?<=[?&#;])((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|client[_-]?secret|secret|password|passwd)=)([^&#\s"'<>]+)/gi,
    accept: (value) => value.length >= 6 && !placeholder.test(value) && !/^[$<{[]/.test(value) },
  { kind: "password in an address", hints: ["://"], group: 2,
    pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]{1,256}:)([^\s@/]{1,256})(?=@)/gi, accept: (value) => value.length >= 3 && !placeholder.test(value) && !/^[$<{*]/.test(value) },
];

// Every pattern stays linear on long hostile text: a start is only tried where the run it scans
// begins (the token look-behind) or the scan is bounded (the address scheme and its parts).
const beginKey = /-----BEGIN ((?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/g;

/** Private key blocks, up to their matching end line or, when that never comes, to the end. */
function privateKeyHits(text: string): LeakHit[] {
  if (!text.includes("-----BEGIN")) return [];
  const hits: LeakHit[] = [];
  for (const match of text.matchAll(beginKey)) {
    const end = `-----END ${match[1]}-----`;
    const found = text.indexOf(end, match.index);
    hits.push({ kind: "private key", start: match.index, end: found < 0 ? text.length : found + end.length });
    // Everything after an unfinished block is already hidden; looking again would only repeat the scan.
    if (found < 0) break;
  }
  return hits;
}

function detectorHits(text: string, lower: string, detector: Detector): LeakHit[] {
  if (!detector.hints.some((hint) => lower.includes(hint))) return [];
  const hits: LeakHit[] = [];
  for (const match of text.matchAll(detector.pattern)) {
    const group = detector.group ?? 0;
    const value = match[group] ?? "";
    if (!value || (detector.accept && !detector.accept(value))) continue;
    const offset = group ? match.slice(1, group).reduce((sum, part) => sum + (part?.length ?? 0), 0) : 0;
    const start = match.index + offset;
    // A trailing backslash stays in the text: inside JSON it escapes the quote that follows.
    let end = start + value.length;
    while (end > start && text[end - 1] === "\\") end--;
    if (end > start) hits.push({ kind: detector.kind, start, end });
  }
  return hits;
}

/** Every key-shaped value in the text, in order, overlaps merged into the first one found. */
export function findLeaks(text: string): LeakHit[] {
  if (text.length < 16) return [];
  const lower = text.toLowerCase();
  const all = [...privateKeyHits(text), ...detectors.flatMap((detector) => detectorHits(text, lower, detector))]
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: LeakHit[] = [];
  for (const hit of all) {
    const last = merged.at(-1);
    if (last && hit.start < last.end) last.end = Math.max(last.end, hit.end);
    else merged.push({ ...hit });
  }
  return merged;
}

export const hiddenMarker = (kind: string): string => `[hidden key-like value: ${kind}]`;

/** The text with every key-shaped value replaced by a plain note, and the kinds that were hidden. */
export function redactLeaks(text: string): { text: string; kinds: string[] } {
  const hits = findLeaks(text);
  if (!hits.length) return { text, kinds: [] };
  let result = "", at = 0;
  for (const hit of hits) {
    result += text.slice(at, hit.start) + hiddenMarker(hit.kind);
    at = hit.end;
  }
  return { text: result + text.slice(at), kinds: [...new Set(hits.map((hit) => hit.kind))] };
}

const maxDepth = 32;
const secretName = /^(?:password|passwd|passphrase|client[_-]?secret|secret[_-]?key|api[_-]?key|access[_-]?token|auth[_-]?token|authorization)$/i;
/** The same through a whole tool result: objects, arrays and nested values; other things untouched. */
export function redactLeaksIn<T>(value: T, kinds: Set<string> = new Set(), depth = 0): { value: T; kinds: Set<string> } {
  if (typeof value === "string") return { value: redactText(value, kinds, depth) as T, kinds };
  if (!value || typeof value !== "object") return { value, kinds };
  if (depth >= maxDepth) return deepFallback(value, kinds);
  if (Array.isArray(value))
    return { value: value.map((entry) => redactLeaksIn(entry, kinds, depth + 1).value) as T, kinds };
  if (Object.getPrototypeOf(value) !== Object.prototype) return { value, kinds };
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    // `{ password: "…" }` is only recognisable with its name beside it, so the pair is looked at too.
    const named = typeof entry === "string" && secretName.test(key) && looksLikeSecretValue(entry);
    if (named) kinds.add("password");
    result[redactText(key, kinds, depth + 1)] = named ? hiddenMarker("password") : redactLeaksIn(entry, kinds, depth + 1).value;
  }
  return { value: result as T, kinds };
}

/**
 * One string. Text that is itself JSON (tool-call arguments, a logged event) is cleaned value by
 * value and written back, so what comes out still parses; anything else is cleaned as text.
 */
function redactText(text: string, kinds: Set<string>, depth = 0): string {
  const done = redactLeaks(text);
  if (!done.kinds.length) return text;
  if (/^\s*[{[]/.test(text) && depth < maxDepth && parses(text) && !parses(done.text)) {
    const cleaned = JSON.stringify(redactLeaksIn(JSON.parse(text) as unknown, kinds, depth + 1).value);
    if (!findLeaks(cleaned).length) return cleaned;
    return JSON.stringify("[hidden: this part held a key-like value]");
  }
  done.kinds.forEach((kind) => kinds.add(kind));
  return done.text;
}

function parses(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}

/** Nesting deeper than anyone writes by hand: checked as a whole and replaced if it holds a key. */
function deepFallback<T>(value: T, kinds: Set<string>): { value: T; kinds: Set<string> } {
  let text: string;
  try { text = JSON.stringify(value) ?? ""; } catch { return { value, kinds }; }
  const hits = findLeaks(text);
  if (!hits.length) return { value, kinds };
  hits.forEach((hit) => kinds.add(hit.kind));
  return { value: "[hidden: this part held a key-like value]" as T, kinds };
}

/** A copy of the request's messages with key-shaped values hidden; pictures and tool names are left alone. */
export function redactMessages(messages: readonly Message[]): { messages: Message[]; kinds: Set<string> } {
  const kinds = new Set<string>();
  const clean = (text: string): string => redactText(text, kinds);
  const copied = messages.map((message) => ({
    ...message,
    content: clean(message.content),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call, arguments: clean(call.arguments) })) } : {}),
  }));
  return { messages: copied, kinds };
}

/**
 * Query names that say the address itself carries a key or a password (after OpenFang's taint
 * check), compared with case, punctuation and brackets taken out: `API-Key`, `api_key[]` and
 * `api%5Fkey` are all `apikey`.
 */
const credentialParameters = new Set(["apikey", "xapikey", "apisecret", "token", "accesstoken", "authtoken",
  "privatetoken", "refreshtoken", "idtoken", "sessiontoken", "secret", "clientsecret", "secretkey", "accesskey",
  "password", "passwd", "pass", "pwd"]);
function credentialName(name: string): boolean {
  let plain = name;
  for (let round = 0; round < 3 && /%[0-9a-f]{2}/i.test(plain); round++) plain = decodeURIComponentSafe(plain);
  return credentialParameters.has(plain.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

/** Which part of an address carries a credential, or null when it carries none. */
export function credentialInUrl(address: string): string | null {
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  if (url.password) return "a password";
  // A name alone before the @ is how a token is often put into an address (https://<token>@host).
  if (url.username) return "a sign-in name";
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  for (const params of [url.searchParams, hash])
    for (const [name, value] of params)
      if (value && credentialName(name)) return `"${name.slice(0, 40)}="`;
  return findLeaks(decodeURIComponentSafe(address)).length ? "a key-like value" : null;
}

function decodeURIComponentSafe(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

export interface LeakNotice { where: "tool result" | "model request"; kinds: string[]; tool?: string; message: string }
type Record_ = (runId: string, kind: string, detail: Record<string, unknown>) => void;

/**
 * What the runtime calls: hides the values and writes one plain line into the task's record. The
 * same finding in a conversation's request is written once per task, not once per round.
 */
export class LeakGuard {
  private readonly told = new Set<string>();
  constructor(private readonly record: Record_) {}
  toolResult<T>(runId: string, tool: string, result: T): T {
    const { value, kinds } = redactLeaksIn(result);
    if (kinds.size) this.tell(runId, { where: "tool result", tool, kinds: [...kinds],
      message: `A key-like value in what ${tool} returned was hidden before the model read it.` }, false);
    return value;
  }
  request(runId: string, messages: Message[]): Message[] {
    const { messages: copied, kinds } = redactMessages(messages);
    if (!kinds.size) return messages;
    this.tell(runId, { where: "model request", kinds: [...kinds],
      message: "A key-like value was hidden before the conversation was sent to the model service." }, true);
    return copied;
  }
  /**
   * An address that carries a key or password is put to the owner before it is fetched, even when
   * the rules would let the call through. A rule that refuses or already asks is left as it is.
   */
  tighten(outcome: PolicyOutcome, args: unknown): PolicyOutcome & { leak?: string } {
    if (outcome.decision !== "allow") return outcome;
    const address = (args as { url?: unknown } | null)?.url;
    const carried = typeof address === "string" ? credentialInUrl(address) : null;
    // The rule that allowed it is set aside, so the yes is for this one address and never a standing one.
    return carried ? { decision: "ask", rule: null, leak: carried } : outcome;
  }
  private tell(runId: string, notice: LeakNotice, once: boolean): void {
    const key = JSON.stringify([runId, notice.where, notice.kinds]);
    if (once && this.told.has(key)) return;
    if (this.told.size > 1000) this.told.clear();
    this.told.add(key);
    try { this.record(runId, "leak.hidden", { ...notice }); } catch { /* the record never stops the task */ }
  }
}

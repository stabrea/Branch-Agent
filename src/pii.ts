import { z } from "zod";

/**
 * Personal details the assistant should not hand out by accident: email addresses, phone numbers,
 * payment card numbers, bank account numbers (IBAN) and national id numbers. Reading your own
 * files is left alone by default; messages the assistant sends out to a chat or mailbox are
 * checked, because that is where personal details leave the computer.
 */
export const PiiKindSchema = z.enum(["email", "phone", "card", "iban", "national-id"]);
export type PiiKind = z.infer<typeof PiiKindSchema>;
export const PiiActionSchema = z.enum(["off", "mask", "warn", "block"]);
export type PiiAction = z.infer<typeof PiiActionSchema>;
export const PiiGuardSchema = z.object({
  /** What to do with personal details in a message the assistant sends out. */
  outbound: PiiActionSchema.default("mask"),
  /** What to do with personal details in something the assistant reads. Off for your own files. */
  inbound: PiiActionSchema.default("off"),
  kinds: z.array(PiiKindSchema).min(1).max(5).default(["email", "phone", "card", "iban", "national-id"]),
}).strict();
export type PiiGuardConfig = z.infer<typeof PiiGuardSchema>;

export interface PiiFinding { kind: PiiKind; hint: string; at: number }
export interface PiiVerdict { text: string; blocked: boolean; findings: PiiFinding[] }

const luhn = (digits: string): boolean => {
  let sum = 0, double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = digits.charCodeAt(index) - 48;
    if (double && (digit *= 2) > 9) digit -= 9;
    sum += digit; double = !double;
  }
  return sum % 10 === 0;
};
const mod97 = (account: string): boolean => {
  const rearranged = account.slice(4) + account.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged)
    remainder = Number(`${remainder}${character >= "0" && character <= "9" ? character : character.charCodeAt(0) - 55}`) % 97;
  return remainder === 1;
};

interface Detector { kind: PiiKind; pattern: RegExp; accept?: (match: string) => boolean }
/** Order matters: the longest, most specific shapes are looked for first. */
const detectors: Detector[] = [
  { kind: "card", pattern: /\b(?:\d[ -]?){12,18}\d\b/g, accept: (match) => { const digits = match.replace(/\D/g, ""); return digits.length >= 13 && digits.length <= 19 && luhn(digits); } },
  { kind: "iban", pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, accept: (match) => mod97(match) },
  { kind: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
  { kind: "national-id", pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  // The look-behind keeps a run of ordinary digits (a build number, a timestamp) from being
  // read as a telephone number: a match has to start where a number starts.
  { kind: "phone", pattern: /(?<![\d)])(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g },
];
const label: Record<PiiKind, string> = {
  email: "email address", phone: "phone number", card: "card number",
  iban: "bank account number", "national-id": "national id number",
};
/** A hint that says what was found without repeating it: the last two characters at most. */
const hint = (kind: PiiKind, match: string): string => `${label[kind]} ending ${match.trim().slice(-2)}`;

/** Every personal detail in the text, without ever repeating the detail itself. */
export function detectPii(text: string, kinds: readonly PiiKind[] = PiiKindSchema.options): PiiFinding[] {
  return spans(text, kinds).map(({ kind, start, match }) => ({ kind, hint: hint(kind, match), at: start }));
}

interface Span { kind: PiiKind; start: number; end: number; match: string }
function spans(text: string, kinds: readonly PiiKind[]): Span[] {
  const taken: Span[] = [];
  for (const detector of detectors) {
    if (!kinds.includes(detector.kind)) continue;
    for (const found of text.matchAll(detector.pattern)) {
      const start = found.index, end = start + found[0].length;
      if (detector.accept && !detector.accept(found[0])) continue;
      if (taken.some((span) => start < span.end && end > span.start)) continue;
      taken.push({ kind: detector.kind, start, end, match: found[0] });
      if (taken.length >= 100) break;
    }
  }
  return taken.sort((a, b) => a.start - b.start);
}

/**
 * Applies the owner's choice: leave the text alone, replace each detail with a plain note, warn
 * without changing anything, or refuse to send the message at all.
 */
export function applyPiiGuard(text: string, action: PiiAction, kinds: readonly PiiKind[] = PiiKindSchema.options): PiiVerdict {
  if (action === "off") return { text, blocked: false, findings: [] };
  const found = spans(text, kinds);
  const findings = found.map(({ kind, start, match }) => ({ kind, hint: hint(kind, match), at: start }));
  if (!found.length) return { text, blocked: false, findings };
  if (action === "block") return { text: "", blocked: true, findings };
  if (action === "warn") return { text, blocked: false, findings };
  let masked = "", cursor = 0;
  for (const span of found) {
    masked += text.slice(cursor, span.start) + `[${label[span.kind]} hidden]`;
    cursor = span.end;
  }
  return { text: masked + text.slice(cursor), blocked: false, findings };
}

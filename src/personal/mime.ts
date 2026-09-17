import { randomUUID } from "node:crypto";

/**
 * R17-C: just enough of the mail format (RFC 5322 and MIME) to write a plain-text draft and to read
 * the parts of a message someone sent, including which files are attached. No library.
 */

/** A header value with no line breaks, so nothing can smuggle in a header of its own. */
export function headerSafe(value: string, what: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`The ${what} cannot contain a line break`);
  return value.trim();
}

/** Non-ASCII header text in the encoded-word form every mail program reads. */
export function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export interface PlainMail { to: string[]; cc?: string[]; subject: string; text: string; inReplyTo?: string; references?: string }

const address = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,190}$/;
function addresses(list: string[], what: string): string {
  for (const item of list) if (!address.test(item)) throw new Error(`${item.slice(0, 80)} is not an email address (${what})`);
  return list.join(", ");
}

/** A whole plain-text message, ready to be handed to a mail service as a draft. */
export function buildPlainMail(mail: PlainMail, now = new Date()): string {
  const lines = [
    `To: ${addresses(mail.to, "to")}`,
    ...(mail.cc?.length ? [`Cc: ${addresses(mail.cc, "copy")}`] : []),
    `Subject: ${encodeHeader(headerSafe(mail.subject, "subject"))}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomUUID()}@branch-agent>`,
    ...(mail.inReplyTo ? [`In-Reply-To: ${headerSafe(mail.inReplyTo, "reply id")}`] : []),
    ...(mail.references ? [`References: ${headerSafe(mail.references, "references")}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(mail.text, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return `${lines.join("\r\n")}\r\n\r\n${body}\r\n`;
}

export interface MimePart { contentType: string; filename: string; disposition: string; body: Buffer }

function headersOf(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of block.replace(/\r\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) map.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return map;
}
/** One parameter of a header, such as boundary or filename, quoted or not. */
export function parameter(header: string, name: string): string {
  const match = new RegExp(`(?:^|;)\\s*${name}\\*?=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i").exec(header);
  const raw = match?.[1] ?? match?.[2] ?? "";
  // RFC 2231: utf-8''name%20with%20spaces
  const extended = /^([\w-]+)''(.*)$/.exec(raw);
  if (!extended) return decodeWords(raw);
  try { return decodeURIComponent(extended[2]!); } catch { return extended[2]!; }
}
/** Decodes =?charset?B?...?= and =?charset?Q?...?= words. */
export function decodeWords(text: string): string {
  return text.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, _charset: string, kind: string, data: string) => {
    if (kind.toUpperCase() === "B") return Buffer.from(data, "base64").toString("utf8");
    return Buffer.from(quotedPrintable(data.replace(/_/g, " "))).toString("utf8");
  });
}
function quotedPrintable(text: string): Buffer {
  const bytes: number[] = [];
  const clean = text.replace(/=\r?\n/g, "");
  for (let i = 0; i < clean.length; i++) {
    const hex = clean.slice(i + 1, i + 3);
    if (clean[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; }
    else bytes.push(...Buffer.from(clean[i]!, "utf8"));
  }
  return Buffer.from(bytes);
}
function decodeBody(body: string, encoding: string): Buffer {
  const kind = encoding.toLowerCase();
  if (kind === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64");
  if (kind === "quoted-printable") return quotedPrintable(body);
  return Buffer.from(body, "utf8");
}

/**
 * Every leaf part of a message, with its decoded bytes. `raw` is the message as the mail socket
 * hands it over (read as UTF-8). Nesting is bounded so a hostile message cannot
 * make this recurse for ever.
 */
export const maxParts = 100;
const maxHeaderBytes = 256 * 1024;
export function mimeParts(raw: string, depth = 0): MimePart[] {
  const split = /\r?\n\r?\n/.exec(raw);
  // Integration review: headers are read only up to a limit, so one endless header line is cheap.
  const head = (split ? raw.slice(0, split.index) : raw).slice(0, maxHeaderBytes);
  const body = split ? raw.slice(split.index + split[0].length) : "";
  const headers = headersOf(head);
  const contentType = headers.get("content-type") ?? "text/plain";
  const boundary = parameter(contentType, "boundary");
  if (/^multipart\//i.test(contentType) && boundary && depth < 6) return multipartParts(body, boundary, depth);
  const disposition = headers.get("content-disposition") ?? "";
  const filename = parameter(disposition, "filename") || parameter(contentType, "name");
  return [{ contentType: contentType.split(";")[0]!.trim().toLowerCase(), filename, disposition: disposition.split(";")[0]!.trim().toLowerCase(),
    body: decodeBody(body, headers.get("content-transfer-encoding") ?? "7bit") }];
}

/** The parts of one multipart body, stopping as soon as there are enough, however many the sender wrote. */
function multipartParts(body: string, boundary: string, depth: number): MimePart[] {
  const found: MimePart[] = [];
  const marker = `--${boundary}`;
  let at = body.indexOf(marker);
  while (at >= 0 && found.length < maxParts) {
    const next = body.indexOf(marker, at + marker.length);
    const piece = body.slice(at + marker.length, next < 0 ? undefined : next);
    if (piece.startsWith("--")) break;
    found.push(...mimeParts(piece.replace(/^\r?\n/, ""), depth + 1).slice(0, maxParts - found.length));
    at = next;
  }
  return found;
}

/** The readable text of a message: its plain part, or its formatted part with the tags taken out. */
export function textOf(parts: MimePart[]): string {
  const plain = parts.find((part) => part.contentType === "text/plain" && !part.filename);
  if (plain) return plain.body.toString("utf8");
  const html = parts.find((part) => part.contentType === "text/html" && !part.filename);
  return html ? stripTags(html.body.toString("utf8")) : "";
}

/** Formatted mail as words: scripts and styles dropped, tags removed, spacing tidied. */
export function stripTags(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

/** The attached files of a message, without their bytes. */
export function attachmentsOf(parts: MimePart[]): { index: number; filename: string; contentType: string; bytes: number }[] {
  return parts.map((part, index) => ({ part, index }))
    .filter(({ part }) => part.filename || part.disposition === "attachment")
    .map(({ part, index }) => ({ index, filename: part.filename || `attachment-${index}`, contentType: part.contentType, bytes: part.body.length }));
}

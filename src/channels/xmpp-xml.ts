/**
 * A small XML reader for an XMPP stream (RFC 6120 section 4 and 11), written for this purpose.
 *
 * An XMPP connection is one long XML document: a `<stream:stream>` opening tag, then one complete
 * element after another (the stanzas), then `</stream:stream>`. The reader is handed the bytes as
 * they arrive and hands back each event once it is whole: the stream opening, every top-level
 * element as a small tree, and the stream closing.
 *
 * RFC 6120 section 11.1 forbids comments, processing instructions (other than the XML declaration),
 * document type declarations and entity references beyond the five predefined ones; this reader
 * refuses them, which is also what keeps "billion laughs" style tricks out.
 */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}
export type XmlEvent =
  | { type: "open"; attrs: Record<string, string> }
  | { type: "element"; element: XmlElement }
  | { type: "close" };

const MAX_PENDING = 1 << 20;
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Turns `&amp;`, `&#65;` and `&#x41;` back into characters; anything else is refused. */
export function decodeEntities(text: string): string {
  return text.replace(/&([^;&]*);?/g, (whole, body: string) => {
    if (!whole.endsWith(";")) throw new Error("The server sent a stray & in its XML");
    if (NAMED[body] !== undefined) return NAMED[body];
    const numeric = /^#(?:x([0-9a-fA-F]{1,6})|([0-9]{1,7}))$/.exec(body);
    if (!numeric) throw new Error("The server used an XML entity XMPP does not allow");
    const code = numeric[1] !== undefined ? parseInt(numeric[1], 16) : parseInt(numeric[2]!, 10);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (code < 0x20 && ![9, 10, 13].includes(code)))
      throw new Error("The server sent a character XML does not allow");
    return String.fromCodePoint(code);
  });
}

/** Characters XML 1.0 cannot carry at all are dropped rather than written. */
function legal(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "").replace(/\p{Cs}/gu, "");
}
/** Escapes text placed between tags. */
export function escapeText(value: string): string {
  return legal(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** Escapes a value placed inside an attribute's quotes, whichever quote is used. */
export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

interface Tag { kind: "start" | "end"; name: string; attrs: Record<string, string>; selfClosing: boolean }

/** Reads one tag's inside (between `<` and `>`), with attributes in either quote style. */
export function parseTag(inside: string): Tag {
  if (inside.startsWith("/")) {
    const name = inside.slice(1).trim();
    if (!/^[^\s<>&"'=/]+$/.test(name)) throw new Error("The server sent a broken closing tag");
    return { kind: "end", name, attrs: {}, selfClosing: false };
  }
  const selfClosing = inside.endsWith("/");
  const body = selfClosing ? inside.slice(0, -1) : inside;
  const head = /^([^\s<>&"'=/]+)/.exec(body);
  if (!head) throw new Error("The server sent a broken tag");
  const attrs: Record<string, string> = {};
  const pattern = /\s+([^\s<>&"'=/]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
  let at = head[1]!.length;
  for (;;) {
    pattern.lastIndex = at;
    const match = pattern.exec(body);
    if (!match) break;
    attrs[match[1]!] = decodeEntities(match[2] ?? match[3] ?? "");
    at = pattern.lastIndex;
  }
  if (body.slice(at).trim()) throw new Error("The server sent a tag with a broken attribute");
  return { kind: "start", name: head[1]!, attrs, selfClosing };
}

/** Where a tag starting at `from` ends (the index of its `>`), honouring quotes; -1 if not yet here. */
function tagEnd(buffer: string, from: number): number {
  let quote = "";
  for (let i = from + 1; i < buffer.length; i++) {
    const c = buffer[i]!;
    if (quote) { if (c === quote) quote = ""; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

export class XmlStreamReader {
  private buffer = "";
  private stack: XmlElement[] = [];
  private opened = false;

  /** Starts over, as a stream restart after STARTTLS or sign-in requires. Unread bytes are kept. */
  reset(): void { this.stack = []; this.opened = false; }
  /** Forgets unread bytes too, for when the connection underneath is replaced. */
  clear(): void { this.reset(); this.buffer = ""; }

  /**
   * Adds what arrived and hands over each event as soon as it is complete, one at a time, so a
   * handler that restarts the stream affects how the rest is read. Throws on forbidden XML.
   */
  push(chunk: string, onEvent: (event: XmlEvent) => void): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_PENDING) throw new Error("The server sent a stanza that is too large");
    for (;;) {
      const step = this.next();
      if (step === null) return;
      if (step !== undefined) onEvent(step);
    }
  }

  /** Reads one piece. Returns null when more bytes are needed, undefined when it produced no event. */
  private next(): XmlEvent | null | undefined {
    const lt = this.buffer.indexOf("<");
    if (lt < 0) return this.text(this.buffer.length, false);
    if (lt > 0) return this.text(lt, true);
    if (this.buffer.startsWith("<?")) return this.declaration();
    if (this.buffer.startsWith("<![CDATA[")) return this.cdata();
    if (this.buffer.startsWith("<!")) {
      if (this.buffer.length < 9 && ("<!--".startsWith(this.buffer) || "<![CDATA[".startsWith(this.buffer))) return null;
      throw new Error("The server sent a comment or a document type, which XMPP does not allow");
    }
    const end = tagEnd(this.buffer, 0);
    if (end < 0) return null;
    const tag = parseTag(this.buffer.slice(1, end));
    this.buffer = this.buffer.slice(end + 1);
    return this.tag(tag);
  }

  /** Text between tags. Text at the top level is only whitespace keepalives, so it is dropped. */
  private text(until: number, complete: boolean): undefined | null {
    if (!complete) {
      if (this.stack.length === 0 && !this.buffer.trim()) this.buffer = "";
      return null;
    }
    const raw = this.buffer.slice(0, until);
    this.buffer = this.buffer.slice(until);
    const top = this.stack.at(-1);
    if (top) top.text += decodeEntities(raw);
    else if (raw.trim()) throw new Error("The server sent text outside any element");
    return undefined;
  }

  private declaration(): undefined | null {
    const end = this.buffer.indexOf("?>");
    if (end < 0) return null;
    if (!/^<\?xml[\s?]/.test(this.buffer) || this.opened) throw new Error("The server sent a processing instruction, which XMPP does not allow");
    this.buffer = this.buffer.slice(end + 2);
    return undefined;
  }

  private cdata(): undefined | null {
    const end = this.buffer.indexOf("]]>");
    if (end < 0) return null;
    const top = this.stack.at(-1);
    if (!top) throw new Error("The server sent text outside any element");
    top.text += this.buffer.slice(9, end);
    this.buffer = this.buffer.slice(end + 3);
    return undefined;
  }

  private tag(tag: Tag): XmlEvent | undefined {
    if (!this.opened) {
      if (tag.kind !== "start" || tag.name !== "stream:stream") throw new Error("The server did not open an XMPP stream");
      this.opened = true;
      return { type: "open", attrs: tag.attrs };
    }
    if (tag.kind === "end") {
      if (this.stack.length === 0) {
        if (tag.name !== "stream:stream") throw new Error("The server closed an element it never opened");
        return { type: "close" };
      }
      const done = this.stack.pop()!;
      if (done.name !== tag.name) throw new Error("The server closed the wrong element");
      return this.finish(done);
    }
    const element: XmlElement = { name: tag.name, attrs: tag.attrs, children: [], text: "" };
    if (this.stack.length > 32) throw new Error("The server sent XML nested too deeply");
    this.stack.at(-1)?.children.push(element);
    if (!tag.selfClosing) { this.stack.push(element); return undefined; }
    return this.finish(element);
  }

  private finish(element: XmlElement): XmlEvent | undefined {
    return this.stack.length === 0 ? { type: "element", element } : undefined;
  }
}

/** The first child with this name (and namespace, when given). */
export function child(element: XmlElement | undefined, name: string, xmlns?: string): XmlElement | undefined {
  return element?.children.find((c) => c.name === name && (xmlns === undefined || c.attrs.xmlns === xmlns));
}

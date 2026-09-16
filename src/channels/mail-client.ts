import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

/**
 * Just enough IMAP and SMTP, over Node's own TLS, to read new mail and answer it: no library, no
 * mailbox syncing, no attachments. The IMAP side logs in, opens the inbox, asks which messages are
 * unread, fetches their headers and text, and marks them read. The SMTP side sends one plain-text
 * message, threading it onto the one it answers.
 */
export interface MailServer {
  host: string;
  port: number;
  user: string;
  password: string;
  /**
   * true (the default) connects with TLS from the start, which is what a hosted mailbox needs.
   * false connects in the clear and upgrades with STARTTLS when the server offers it, which is
   * only sensible for a mail server on this computer or on the same network.
   */
  tls?: boolean;
  /** Set only in tests, where the fake server has a self-signed certificate. */
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
}
export interface MailMessage {
  /** The IMAP sequence number, only meaningful while the mailbox stays open. */
  seq: number;
  from: string;
  fromName: string;
  subject: string;
  messageId: string;
  references: string;
  text: string;
}

/** A socket that speaks in lines and can be read until a caller-chosen point. */
class LineSocket {
  private buffer = "";
  private waiting: (() => void) | undefined;
  private failure: Error | undefined;
  constructor(private socket: Socket | TLSSocket) { this.listen(); }
  private listen(): void {
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => { this.buffer += chunk; this.waiting?.(); });
    this.socket.on("error", (error: Error) => { this.failure = error; this.waiting?.(); });
    this.socket.on("close", () => { this.failure ??= new Error("The mail server closed the connection"); this.waiting?.(); });
  }
  send(line: string): void { this.socket.write(line + "\r\n"); }
  write(raw: string): void { this.socket.write(raw); }
  /** Waits until `end` finds a stopping point in what has arrived, then hands back that much. */
  async until(end: (text: string) => number | null, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = end(this.buffer);
      if (at !== null) { const taken = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at); return taken; }
      if (this.failure) throw this.failure;
      if (Date.now() > deadline) throw new Error("The mail server did not answer in time");
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
        setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now())));
      });
    }
  }
  /** Swaps the plain socket for an encrypted one after STARTTLS. */
  async upgrade(server: MailServer): Promise<void> {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("close");
    const secure = tlsConnect({ socket: this.socket, servername: server.host, rejectUnauthorized: server.rejectUnauthorized ?? true });
    await new Promise<void>((resolve, reject) => { secure.once("secureConnect", resolve); secure.once("error", reject); });
    this.socket = secure;
    this.buffer = "";
    this.listen();
  }
  close(): void { this.socket.destroy(); }
}
/**
 * Opens the connection, giving up on a server that never answers. Without this bound a mail host
 * that swallows the connection would hold up every later look at the inbox for good.
 */
async function open(server: MailServer, secure: boolean): Promise<LineSocket> {
  const socket = secure
    ? tlsConnect({ host: server.host, port: server.port, servername: server.host, rejectUnauthorized: server.rejectUnauthorized ?? true })
    : netConnect({ host: server.host, port: server.port });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`${server.host} did not answer in time`)); }, server.timeoutMs ?? 20000);
    socket.once(secure ? "secureConnect" : "connect", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (error: Error) => { clearTimeout(timer); socket.destroy(); reject(error); });
  });
  return new LineSocket(socket);
}

/**
 * Finds where a tagged IMAP response ends, stepping over literal blocks ("{123}" followed by that
 * many bytes) so text inside a message is never mistaken for the end of the answer.
 */
export function taggedEnd(text: string, tag: string): number | null {
  let at = 0;
  while (at < text.length) {
    const eol = text.indexOf("\r\n", at);
    if (eol === -1) return null;
    const line = text.slice(at, eol);
    at = eol + 2;
    const literal = /\{(\d+)\}$/.exec(line);
    if (literal) { at += Number(literal[1]); if (at > text.length) return null; continue; }
    if (line.startsWith(tag + " ")) return at;
  }
  return null;
}

/** One IMAP conversation: log in, read what is unread, mark it read, log out. */
export class ImapClient {
  private socket: LineSocket | undefined;
  private counter = 0;
  constructor(private readonly server: MailServer) {}
  private get timeout(): number { return this.server.timeoutMs ?? 20000; }
  async connect(): Promise<void> {
    this.socket = await open(this.server, this.server.tls !== false);
    await this.socket.until((text) => (text.includes("\r\n") ? text.indexOf("\r\n") + 2 : null), this.timeout);
    await this.command(`LOGIN ${quote(this.server.user)} ${quote(this.server.password)}`);
    await this.command("SELECT INBOX");
  }
  /** Reads every unread message, marks each read, and returns what was found. */
  async unread(limit = 10): Promise<MailMessage[]> {
    const search = await this.command("SEARCH UNSEEN");
    const ids = (/^\* SEARCH([\d ]*)/m.exec(search)?.[1] ?? "").trim().split(/\s+/).filter(Boolean).map(Number).slice(0, limit);
    const messages: MailMessage[] = [];
    for (const seq of ids) {
      const raw = await this.command(`FETCH ${seq} (BODY.PEEK[HEADER] BODY.PEEK[TEXT])`);
      messages.push(parseFetched(seq, raw));
      await this.command(`STORE ${seq} +FLAGS (\\Seen)`);
    }
    return messages;
  }
  async close(): Promise<void> {
    try { await this.command("LOGOUT"); } catch { /* the server may hang up first, which is fine */ }
    this.socket?.close();
    this.socket = undefined;
  }
  private async command(text: string): Promise<string> {
    if (!this.socket) throw new Error("The mail connection is not open");
    const tag = `b${++this.counter}`;
    this.socket.send(`${tag} ${text}`);
    const answer = await this.socket.until((buffer) => taggedEnd(buffer, tag), this.timeout);
    const status = new RegExp(`^${tag} (OK|NO|BAD)(.*)$`, "m").exec(answer);
    // The command name is kept out of the error so a password never reaches a log.
    if (!status || status[1] !== "OK") throw new Error(`The mail server refused ${text.split(" ")[0]}:${(status?.[2] ?? "").slice(0, 120)}`);
    return answer;
  }
}
const quote = (value: string) => `"${value.replace(/([\\"])/g, "\\$1")}"`;

/** Splits one FETCH answer into the headers we thread on and the plain text body. */
export function parseFetched(seq: number, raw: string): MailMessage {
  const literals = [...raw.matchAll(/\{(\d+)\}\r\n/g)].map((match) => {
    const start = match.index + match[0].length;
    return raw.slice(start, start + Number(match[1]));
  });
  const headers = literals[0] ?? "";
  const body = literals[1] ?? "";
  const header = (name: string) => new RegExp(`^${name}:[ \\t]*([\\s\\S]*?)(?=\\r\\n[^ \\t]|$)`, "im").exec(headers)?.[1]?.replace(/\r\n[ \t]+/g, " ").trim() ?? "";
  const from = header("From");
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from.split(/\s+/).pop() ?? "";
  return {
    seq, from: address.toLowerCase(), fromName: from.replace(/<[^>]*>/, "").replace(/"/g, "").trim() || address,
    subject: header("Subject"), messageId: header("Message-ID"), references: header("References"),
    text: body.replace(/\r\n/g, "\n").trim(),
  };
}

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
  messageId: string;
  date?: Date;
}
/** Sends one plain-text message and hangs up. */
export async function sendMail(server: MailServer, mail: OutgoingMail): Promise<void> {
  const implicit = server.tls !== false;
  const socket = await open(server, implicit);
  const timeout = server.timeoutMs ?? 20000;
  const expect = async (codes: string[]) => {
    const answer = await socket.until(finishedReply, timeout);
    if (!codes.some((code) => answer.startsWith(code))) throw new Error(`The mail server answered ${answer.slice(0, 80).trim()}`);
    return answer;
  };
  try {
    await expect(["220"]);
    socket.send("EHLO branch-agent");
    const greeting = await expect(["250"]);
    // On a plain connection, encrypt as soon as the server says it can.
    if (!implicit && /STARTTLS/i.test(greeting)) {
      socket.send("STARTTLS");
      await expect(["220"]);
      await socket.upgrade(server);
      socket.send("EHLO branch-agent");
      await expect(["250"]);
    }
    await authenticate(socket, server, expect);
    socket.send(`MAIL FROM:<${mail.from}> BODY=8BITMIME`);
    await expect(["250"]);
    socket.send(`RCPT TO:<${mail.to}>`);
    await expect(["250", "251"]);
    socket.send("DATA");
    await expect(["354"]);
    socket.write(messageBody(mail));
    await expect(["250"]);
    socket.send("QUIT");
  } finally { socket.close(); }
}
/** An SMTP reply ends at the first line whose code is followed by a space rather than a dash. */
function finishedReply(text: string): number | null {
  let at = 0;
  while (at < text.length) {
    const eol = text.indexOf("\r\n", at);
    if (eol === -1) return null;
    if (/^\d{3} /.test(text.slice(at, eol))) return eol + 2;
    at = eol + 2;
  }
  return null;
}
async function authenticate(socket: LineSocket, server: MailServer, expect: (codes: string[]) => Promise<string>): Promise<void> {
  const plain = Buffer.from(`\0${server.user}\0${server.password}`, "utf8").toString("base64");
  socket.send(`AUTH PLAIN ${plain}`);
  try { await expect(["235"]); return; } catch { /* some servers only offer AUTH LOGIN */ }
  socket.send("AUTH LOGIN");
  await expect(["334"]);
  socket.send(Buffer.from(server.user, "utf8").toString("base64"));
  await expect(["334"]);
  socket.send(Buffer.from(server.password, "utf8").toString("base64"));
  await expect(["235"]);
}
/** Builds the message, protecting any line that starts with a dot from ending the transmission. */
function messageBody(mail: OutgoingMail): string {
  const headers = [
    `From: ${mail.from}`, `To: ${mail.to}`, `Subject: ${mail.subject}`,
    `Date: ${(mail.date ?? new Date()).toUTCString()}`, `Message-ID: ${mail.messageId}`,
    ...(mail.inReplyTo ? [`In-Reply-To: ${mail.inReplyTo}`] : []),
    ...(mail.references ? [`References: ${mail.references}`] : []),
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit",
  ];
  const body = mail.text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n.\r\n`;
}

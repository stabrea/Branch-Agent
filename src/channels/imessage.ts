import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { InboundMessage } from "./router.js";
import { defineService, PollingChannel } from "./parity-common.js";

/**
 * iMessage, by driving the Messages app on the owner's own Mac. There is no iMessage API: this is
 * the same route BlueBubbles and ZeroClaw take. Replies are sent through AppleScript; new messages
 * are read from the Messages database on this Mac. It works only on a Mac, and only once the owner
 * has given Branch Full Disk Access (to read the database) and allowed it to control Messages.
 *
 * The words and the address are handed to `osascript` as arguments, never written into the script
 * itself, so nothing a person types can become AppleScript. The script is fixed text.
 *
 * Reading the typed-stream `attributedBody` follows the format notes in ZeroClaw's imessage channel
 * (MIT OR Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
export type CommandRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
export interface MessageRow { id: number; sender: string; text: string | null; body: Uint8Array | null; chat: string | null; style: number | null; title: string | null }
/** Returns the rows after `afterId`; with `afterId` null, returns only the newest row, to take stock. */
export type MessageReader = (afterId: number | null) => Promise<MessageRow[]>;

/** Sends to one person (a phone number or Apple ID) or, for a group, to the chat by its id. */
export const sendScript = [
  "on run argv",
  "set targetName to item 1 of argv",
  "set messageText to item 2 of argv",
  "set isGroup to item 3 of argv",
  'tell application "Messages"',
  'if isGroup is "yes" then',
  "send messageText to chat id targetName",
  "else",
  "set targetService to 1st account whose service type = iMessage",
  "send messageText to participant targetName of targetService",
  "end if",
  "end tell",
  "end run",
];

export const realRunner: CommandRunner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 30000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || error.message).split("\n")[0]!.slice(0, 200)));
    else resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});

/** Pulls the plain words out of the typed-stream blob newer macOS versions store instead of `text`. */
export function textFromAttributedBody(blob: Uint8Array | null): string {
  if (!blob) return "";
  const bytes = Buffer.from(blob);
  let at = -1;
  for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 0x01 && bytes[i + 1] === 0x2b) { at = i + 2; break; }
  if (at < 0 || at >= bytes.length) return "";
  const lead = bytes[at]!;
  let length: number, start: number;
  if (lead === 0x81 && at + 3 <= bytes.length) { length = bytes.readUInt16LE(at + 1); start = at + 3; }
  else if (lead === 0x82 && at + 5 <= bytes.length) { length = bytes.readUInt32LE(at + 1); start = at + 5; }
  else if (lead <= 0x7f) { length = lead; start = at + 1; }
  else return "";
  if (start + length > bytes.length) return "";
  return bytes.subarray(start, start + length).toString("utf8");
}

const rowQuery = `SELECT m.ROWID AS id, h.id AS sender, m.text AS text, m.attributedBody AS body,
  c.guid AS chat, c.style AS style, c.display_name AS title
  FROM message m JOIN handle h ON m.handle_id = h.ROWID
  LEFT JOIN chat_message_join j ON j.message_id = m.ROWID LEFT JOIN chat c ON c.ROWID = j.chat_id
  WHERE m.is_from_me = 0 AND m.ROWID > ? ORDER BY m.ROWID ASC LIMIT 50`;

/** Reads the Messages database read-only. A missing permission is said in words the owner can act on. */
export function databaseReader(path: string): MessageReader {
  return async (afterId) => {
    const { DatabaseSync } = await import("node:sqlite");
    try {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        if (afterId !== null) return db.prepare(rowQuery).all(afterId) as unknown as MessageRow[];
        const newest = db.prepare("SELECT MAX(ROWID) AS id FROM message").get() as { id: number | null } | undefined;
        return [{ id: Number(newest?.id ?? 0), sender: "", text: null, body: null, chat: null, style: null, title: null }];
      } finally { db.close(); }
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      if (/authori[sz]|unable to open|not permitted|operation not permitted/i.test(said))
        throw new Error("Branch cannot read your messages yet. Give it Full Disk Access in System Settings, Privacy & Security");
      throw error;
    }
  };
}

export interface IMessageOptions {
  id: string;
  reader: MessageReader;
  runner: CommandRunner;
  /** The owner's own address, shown as the assistant's name. */
  account?: string;
  pollMs?: number;
}

export class IMessageChannel extends PollingChannel {
  readonly kind = "imessage";
  private lastId = 0;
  /** Group chats and the people in them, so a reply goes back to the right place. */
  private readonly groups = new Set<string>();
  constructor(private readonly options: IMessageOptions) {
    super(options.id, options.pollMs ?? 3000);
    this.maxTextLength = 3000;
  }
  botName(): string | null { return this.options.account ?? null; }
  protected async poll(first: boolean): Promise<InboundMessage[]> {
    const rows = await this.options.reader(first ? null : this.lastId);
    const messages: InboundMessage[] = [];
    for (const row of rows) {
      this.lastId = Math.max(this.lastId, Number(row.id));
      if (first) continue;
      const inbound = this.inbound(row);
      if (inbound) messages.push(inbound);
    }
    return messages;
  }
  private inbound(row: MessageRow): InboundMessage | null {
    const text = (row.text && row.text.trim()) ? row.text : textFromAttributedBody(row.body);
    if (!text.trim() || !row.sender) return null;
    const group = row.style === 43 && !!row.chat;
    const chatId = this.ids.short(group ? row.chat! : row.sender, "chat");
    if (group) this.groups.add(chatId);
    const name = (this.options.account ?? "").split("@")[0]!.toLowerCase();
    return {
      channel: this.id, chatId, chatKind: group ? "group" : "direct",
      ...(group ? { chatTitle: row.title || "iMessage group" } : {}),
      senderId: this.ids.short(row.sender, "who"), senderName: row.sender, text,
      addressed: !group || (!!name && text.toLowerCase().includes(name)),
      messageId: String(row.id),
    };
  }
  async send(chatId: string, text: string): Promise<string | undefined> {
    const target = this.ids.long(chatId);
    // osascript reads a leading "-" as one of its own options; no address or chat id starts with one.
    if (target.startsWith("-")) throw new Error("That is not an address Messages can send to");
    const group = this.groups.has(chatId) ? "yes" : "no";
    const args = sendScript.flatMap((line) => ["-e", line]);
    await this.options.runner("/usr/bin/osascript", [...args, target, text.slice(0, this.maxTextLength), group])
      .catch((error: unknown) => {
        throw new Error(`Messages would not send it: ${error instanceof Error ? error.message : String(error)}. Allow Branch to control Messages in System Settings, Privacy & Security, Automation`);
      });
    return undefined;
  }
}

export const imessageService = defineService({
  kind: "imessage", name: "iMessage", docs: "https://support.apple.com/guide/mac-help/control-access-to-files-and-folders-on-mac-mchld5a35146/mac",
  needs: ["A Mac signed in to Messages with your Apple Account",
    "Full Disk Access for Branch, so it can read new messages", "Permission for Branch to control Messages"],
  receives: "polls",
  platforms: ["darwin"],
  settings: z.object({
    /** Your own address in Messages, used as the assistant's name in groups. */
    account: z.string().min(3).max(120).optional(),
    database: z.string().min(3).max(400).optional(),
    pollSeconds: z.number().int().min(2).max(300).default(3),
  }).strict(),
  async build(settings, deps) {
    const database = settings.database ?? join(homedir(), "Library", "Messages", "chat.db");
    return new IMessageChannel({ id: deps.id, reader: databaseReader(database), runner: realRunner,
      pollMs: settings.pollSeconds * 1000, ...(settings.account ? { account: settings.account } : {}) });
  },
});

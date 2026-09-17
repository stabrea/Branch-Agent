import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { reconnectDelay } from "./ws-client.js";
import { defineService, ShortIds } from "./parity-common.js";
import { programInstalled, startProgram, type ProgramStarter, type RunningProgram } from "./local-program.js";

/**
 * Delta Chat (chat over email), through the `deltachat-rpc-server` program the owner installed and
 * set up an account in. It speaks JSON-RPC 2.0, one JSON document per line, over its standard input
 * and output (https://py.delta.chat/jsonrpc/ and the deltachat-jsonrpc crate). The method sequence
 * (`get_all_account_ids`, `start_io`, then waiting for events) and the "anything but Single is a
 * group" rule follow PicoClaw's deltachat channel (MIT). Branch makes no network call of its own
 * here; the program does, with the account the owner configured.
 *
 * Messages that arrive while Branch was not running are fetched when the program starts; anything
 * sent before Branch started is treated as history and left alone.
 */
const SELF_AND_SPECIAL_CONTACTS = 9; // Delta Chat reserves contact ids 1-9 (1 is the account itself).

const eventSchema = z.object({
  contextId: z.number(),
  event: z.object({ kind: z.string(), chatId: z.number().optional(), msgId: z.number().optional() }).passthrough(),
}).passthrough();
const messageSchema = z.object({
  id: z.number(), chatId: z.number(), fromId: z.number(), text: z.string().nullable().optional(),
  timestamp: z.number().optional(), isInfo: z.boolean().optional(),
  sender: z.object({ address: z.string().max(320), displayName: z.string().optional() }).passthrough().optional(),
}).passthrough();
const chatSchema = z.object({
  id: z.number(), name: z.string().optional(), chatType: z.union([z.string(), z.number()]),
  isDeviceChat: z.boolean().optional(), isSelfTalk: z.boolean().optional(),
}).passthrough();
const responseSchema = z.object({
  id: z.number().optional(), result: z.unknown().optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
}).passthrough();

/** One running program and the calls waiting for its answers. */
class RpcProgram {
  private nextId = 0;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly ended: Promise<void>;
  constructor(readonly child: RunningProgram) {
    let finish = () => undefined as void;
    this.ended = new Promise((resolve) => { finish = resolve; });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line: string) => this.onLine(line));
    child.stdin.on("error", () => undefined); // a program that has gone is reported by "exit"
    const end = (reason: string) => { lines.close(); this.failAll(reason); finish(); };
    child.on("exit", () => end("deltachat-rpc-server stopped"));
    child.on("error", (error) => end(`deltachat-rpc-server could not run: ${error.message}`));
  }
  call(method: string, ...params: unknown[]): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  private onLine(line: string): void {
    let parsed: z.infer<typeof responseSchema>;
    try { parsed = responseSchema.parse(JSON.parse(line)); } catch { return; }
    const waiter = parsed.id !== undefined ? this.waiting.get(parsed.id) : undefined;
    if (!waiter) return;
    this.waiting.delete(parsed.id!);
    if (parsed.error) waiter.reject(new Error(`Delta Chat refused: ${parsed.error.message ?? "unknown reason"}`));
    else waiter.resolve(parsed.result);
  }
  failAll(reason: string): void {
    for (const waiter of this.waiting.values()) waiter.reject(new Error(reason));
    this.waiting.clear();
  }
}

export interface DeltaChatOptions {
  id: string;
  path: string;
  /** Where the program keeps its accounts (DC_ACCOUNTS_PATH); the program's own default otherwise. */
  accountsPath?: string;
  accountId?: number;
  startProcess?: ProgramStarter;
  exists?: (path: string) => Promise<boolean>;
  retryBaseMs?: number;
  now?: () => number;
}

export class DeltaChatChannel implements ChannelAdapter {
  readonly id: string;
  readonly kind = "deltachat";
  readonly maxTextLength = 3500;
  private state: ChannelHealth = { state: "reconnecting", reason: "Starting deltachat-rpc-server" };
  private rpc: RpcProgram | null = null;
  private account = 0;
  private address = "";
  private name = "";
  private stopping = false;
  private loop: Promise<void> | null = null;
  private readonly ids = new ShortIds();
  constructor(private readonly options: DeltaChatOptions) { this.id = options.id; }
  botName(): string | null { return this.name || this.address || null; }
  health(): ChannelHealth { return this.state; }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.stopping = false;
    const exists = this.options.exists ?? programInstalled;
    if (!await exists(this.options.path)) {
      this.state = { state: "needs attention", reason: `deltachat-rpc-server is not installed at ${this.options.path}` };
      throw new Error(`Delta Chat needs the deltachat-rpc-server program, and there is nothing at ${this.options.path}. Install it and set up an account first.`);
    }
    this.loop = this.run(onMessage);
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.rpc?.child.kill();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }

  private async run(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt++) {
      const env = this.options.accountsPath ? { DC_ACCOUNTS_PATH: this.options.accountsPath } : undefined;
      const rpc = new RpcProgram((this.options.startProcess ?? startProgram)(this.options.path, [], env));
      this.rpc = rpc;
      try {
        const since = Math.floor((this.options.now ?? Date.now)() / 1000);
        if (!await this.prepare(rpc)) { rpc.child.kill(); return; }
        this.state = { state: "connected" };
        attempt = 0;
        await this.listen(rpc, since, onMessage);
      } catch (error) {
        if (this.stopping) return;
        this.state = { state: "reconnecting", reason: `Delta Chat stopped: ${error instanceof Error ? error.message : String(error)}` };
      }
      rpc.child.kill();
      this.rpc = null;
      if (this.stopping) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.retryBaseMs ?? 1000)));
    }
  }
  /** Picks the account, learns its address, and starts its mail connection. False means "owner must act". */
  private async prepare(rpc: RpcProgram): Promise<boolean> {
    const ids = z.array(z.number()).parse(await rpc.call("get_all_account_ids"));
    const account = this.options.accountId ?? ids[0];
    if (account === undefined || !ids.includes(account)) {
      this.state = { state: "needs attention", reason: "Delta Chat has no account to use yet. Set one up with deltachat-rpc-server (or the Delta Chat app) first" };
      return false;
    }
    this.account = account;
    if (await rpc.call("is_configured", account) !== true) {
      this.state = { state: "needs attention", reason: "The Delta Chat account is not set up yet. Finish setting it up, then switch Delta Chat on again" };
      return false;
    }
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    this.address = text(await rpc.call("get_config", account, "addr")).toLowerCase();
    this.name = text(await rpc.call("get_config", account, "displayname"));
    await rpc.call("start_io", account);
    return true;
  }
  /** Waits for events one at a time until the program ends or Branch stops. */
  private async listen(rpc: RpcProgram, since: number, onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    while (!this.stopping) {
      const next = await Promise.race([rpc.call("get_next_event"), rpc.ended.then(() => null)]);
      if (next === null) throw new Error("deltachat-rpc-server is no longer running");
      const event = eventSchema.safeParse(next);
      if (!event.success || event.data.contextId !== this.account || event.data.event.kind !== "IncomingMsg") continue;
      const inbound = await this.inbound(rpc, event.data.event.msgId ?? 0, since).catch(() => null);
      if (inbound) void onMessage(inbound).catch(() => undefined);
    }
  }
  private async inbound(rpc: RpcProgram, msgId: number, since: number): Promise<InboundMessage | null> {
    const message = messageSchema.parse(await rpc.call("get_message", this.account, msgId));
    const text = message.text ?? "";
    if (message.isInfo || !text.trim() || message.fromId <= SELF_AND_SPECIAL_CONTACTS) return null;
    if ((message.timestamp ?? since) < since) return null; // sent before Branch started: history
    const address = message.sender?.address.toLowerCase() ?? "";
    if (!address || address === this.address) return null;
    const chat = chatSchema.parse(await rpc.call("get_basic_chat_info", this.account, message.chatId));
    if (chat.isDeviceChat || chat.isSelfTalk) return null;
    const group = chat.chatType !== "Single" && chat.chatType !== 100;
    const lower = text.toLowerCase();
    const handles = [this.name, this.address.split("@")[0] ?? ""].filter(Boolean).map((h) => `@${h.toLowerCase()}`);
    const leading = handles.find((h) => lower.startsWith(h));
    const words = leading ? text.slice(leading.length).replace(/^[\s:,]+/, "") : text;
    return {
      channel: this.id, chatId: String(message.chatId), chatKind: group ? "group" : "direct",
      ...(group ? { chatTitle: chat.name || `group ${chat.id}` } : {}),
      senderId: this.ids.short(address, "who"), senderName: message.sender?.displayName || address,
      text: words || text, addressed: !group || handles.some((h) => lower.includes(h)), messageId: String(message.id),
    };
  }

  async send(chatId: string, text: string): Promise<string | undefined> {
    if (!/^\d{1,15}$/.test(chatId)) throw new Error("That is not a Delta Chat chat Branch can send to");
    if (!this.rpc || this.state.state !== "connected") throw new Error("Delta Chat is not running, so the message could not be sent");
    const id = await this.rpc.call("misc_send_text_message", this.account, Number(chatId), text.slice(0, this.maxTextLength));
    return typeof id === "number" ? String(id) : undefined;
  }
}

export const deltachatService = defineService({
  kind: "deltachat", name: "Delta Chat", docs: "https://py.delta.chat/jsonrpc/",
  needs: ["The deltachat-rpc-server program installed on this computer, and its full path",
    "A Delta Chat account for the assistant, already set up in that program (for example on a chatmail server)"],
  receives: "program",
  settings: z.object({
    path: z.string().min(3).max(400).refine((value) => isAbsolute(value), "The deltachat-rpc-server path must be a full path"),
    accountsPath: z.string().min(3).max(400).refine((value) => isAbsolute(value), "The accounts folder must be a full path").optional(),
    accountId: z.number().int().min(1).optional(),
  }).strict(),
  async build(settings, deps) {
    // No network address to check: the program makes its own mail connections.
    return new DeltaChatChannel({ id: deps.id, path: settings.path, exists: (path) => programInstalled(path, deps.platform),
      ...(settings.accountsPath ? { accountsPath: settings.accountsPath } : {}),
      ...(settings.accountId !== undefined ? { accountId: settings.accountId } : {}) });
  },
});

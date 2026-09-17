import { isAbsolute } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { reconnectDelay } from "./ws-client.js";
import { defineService, ShortIds } from "./parity-common.js";
import { realRunner, type CommandRunner } from "./imessage.js";
import { programInstalled, startProgram, type ProgramStarter, type RunningProgram } from "./local-program.js";

/**
 * Keybase chat, through the `keybase` program the owner installed and signed in to themselves,
 * using its documented JSON chat API (https://keybase.io/docs/api/1.0/chat or `keybase chat api
 * --help`): `keybase chat api-listen` writes one JSON document per line for every new message, and
 * `keybase chat api -m <json>` sends one. Branch makes no network call of its own here; the program
 * does, with the account the owner signed in with.
 *
 * The program is looked for before anything runs, and it is always run with an argument list, so
 * nothing a person writes can become a command.
 */
const listenSchema = z.object({
  type: z.string(),
  msg: z.object({
    id: z.number(),
    conversation_id: z.string().min(1).max(128),
    channel: z.object({ name: z.string(), members_type: z.string().optional(), topic_name: z.string().optional() }).passthrough(),
    sender: z.object({ uid: z.string().min(1).max(64), username: z.string().min(1).max(64) }).passthrough(),
    content: z.object({ type: z.string(), text: z.object({ body: z.string() }).passthrough().optional() }).passthrough(),
  }).passthrough(),
}).passthrough();
const sendResult = z.object({
  result: z.object({ id: z.number().optional() }).passthrough().optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
}).passthrough();

export interface KeybaseOptions {
  id: string;
  /** Full path to the keybase program. */
  path: string;
  run?: CommandRunner;
  startProcess?: ProgramStarter;
  exists?: (path: string) => Promise<boolean>;
  retryBaseMs?: number;
}

export class KeybaseChannel implements ChannelAdapter {
  readonly id: string;
  readonly kind = "keybase";
  readonly maxTextLength = 3500;
  private state: ChannelHealth = { state: "reconnecting", reason: "Starting the keybase program" };
  private username: string | null = null;
  private child: RunningProgram | null = null;
  private lines: Interface | null = null;
  private stopping = false;
  private restarts = 0;
  private readonly ids = new ShortIds();
  constructor(private readonly options: KeybaseOptions) { this.id = options.id; }
  botName(): string | null { return this.username; }
  health(): ChannelHealth { return this.state; }
  private get run(): CommandRunner { return this.options.run ?? realRunner; }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.stopping = false;
    const exists = this.options.exists ?? programInstalled;
    if (!await exists(this.options.path)) {
      this.state = { state: "needs attention", reason: `The keybase program is not installed at ${this.options.path}` };
      throw new Error(`Keybase needs the keybase program, and there is nothing at ${this.options.path}. Install Keybase and sign in first.`);
    }
    const who = await this.run(this.options.path, ["whoami"]).catch(() => ({ stdout: "" }));
    this.username = who.stdout.trim().split(/\s+/)[0] || null;
    if (!this.username) {
      this.state = { state: "needs attention", reason: "The keybase program is not signed in. Open Keybase and sign in with the assistant's account" };
      throw new Error("Keybase is not signed in on this computer");
    }
    this.listen(onMessage);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.lines?.close();
    this.child?.kill();
    this.child = null;
  }

  /** Runs `keybase chat api-listen`, and runs it again (waiting longer each time) if it ends. */
  private listen(onMessage: (message: InboundMessage) => Promise<void>): void {
    const child = (this.options.startProcess ?? startProgram)(this.options.path, ["chat", "api-listen"]);
    this.child = child;
    this.state = { state: "connected" };
    const lines = createInterface({ input: child.stdout });
    this.lines = lines;
    lines.on("line", (line: string) => {
      this.restarts = 0;
      const inbound = this.inbound(line);
      if (inbound) void onMessage(inbound).catch(() => undefined);
    });
    let ended = false;
    const again = (reason: string) => {
      if (ended || this.stopping || this.child !== child) return;
      ended = true;
      lines.close();
      this.state = { state: "reconnecting", reason };
      setTimeout(() => { if (!this.stopping) this.listen(onMessage); }, reconnectDelay(++this.restarts, this.options.retryBaseMs ?? 1000));
    };
    child.on("exit", () => again("The keybase program stopped listening; starting it again"));
    child.on("error", (error) => again(`The keybase program could not run: ${error.message}`));
  }

  private inbound(line: string): InboundMessage | null {
    let parsed: z.infer<typeof listenSchema>;
    try { parsed = listenSchema.parse(JSON.parse(line)); } catch { return null; }
    const { msg } = parsed;
    const body = msg.content.type === "text" ? msg.content.text?.body ?? "" : "";
    if (parsed.type !== "chat" || !body.trim() || !this.username) return null;
    if (msg.sender.username.toLowerCase() === this.username.toLowerCase()) return null;
    const people = msg.channel.name.split(",");
    const group = msg.channel.members_type === "team" || people.length > 2;
    const mention = `@${this.username.toLowerCase()}`;
    const lower = body.toLowerCase();
    const text = lower.startsWith(mention) ? body.slice(mention.length).replace(/^[\s:,]+/, "") : body;
    return {
      channel: this.id, chatId: this.ids.short(msg.conversation_id, "chat"), chatKind: group ? "group" : "direct",
      ...(group ? { chatTitle: msg.channel.topic_name ? `${msg.channel.name}#${msg.channel.topic_name}` : msg.channel.name } : {}),
      senderId: msg.sender.uid, senderName: msg.sender.username,
      text: text || body, addressed: !group || lower.includes(mention), messageId: String(msg.id),
    };
  }

  async send(chatId: string, text: string): Promise<string | undefined> {
    const request = { method: "send", params: { options: {
      conversation_id: this.ids.long(chatId), message: { body: text.slice(0, this.maxTextLength) },
    } } };
    const output = await this.run(this.options.path, ["chat", "api", "-m", JSON.stringify(request)]).catch((error: unknown) => {
      throw new Error(`Keybase would not send it: ${error instanceof Error ? error.message : String(error)}`);
    });
    let answer: z.infer<typeof sendResult>;
    try { answer = sendResult.parse(JSON.parse(output.stdout)); } catch { throw new Error("Keybase gave an answer Branch could not read"); }
    if (answer.error) throw new Error(`Keybase would not send it: ${answer.error.message ?? "unknown reason"}`);
    return answer.result?.id !== undefined ? String(answer.result.id) : undefined;
  }
}

export const keybaseService = defineService({
  kind: "keybase", name: "Keybase", docs: "https://keybase.io/docs/api/1.0/chat",
  needs: ["The Keybase app installed on this computer and signed in with the assistant's own account",
    "The full path to the keybase program (for example /usr/local/bin/keybase)"],
  receives: "program",
  settings: z.object({
    path: z.string().min(3).max(400).refine((value) => isAbsolute(value), "The keybase path must be a full path"),
  }).strict(),
  async build(settings, deps) {
    // No network address to check: the keybase program makes its own connections.
    return new KeybaseChannel({ id: deps.id, path: settings.path,
      exists: (path) => programInstalled(path, deps.platform) });
  },
});

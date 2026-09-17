import { z } from "zod";
import type { Store } from "../store.js";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";

/**
 * The owner's switch for each chat service added in wave mac3: on, off, or "when needed". Every one
 * starts off, so a fresh install talks to nobody until the owner says so.
 *
 * - **off**: the connection is never opened. Replies waiting for that chat stay in the waiting line
 *   and are shown under "Messages still to send".
 * - **on**: the connection opens when Branch starts and stays open, as every older channel does.
 * - **when needed**: nothing is held open. The connection opens the moment the assistant has
 *   something to send there (or the service posts a message to this computer), stays open while
 *   messages keep coming, and closes again after a quiet spell.
 *
 * A chat connection has nothing to put in front of the model, so "when needed" is decided by the
 * traffic rather than by the tool tiering in src/tool-loading.ts.
 *
 * mac2/chat-live has its own `FeatureSwitchSchema` with the same three values; the two are kept
 * apart only because that branch has not merged yet. They can be folded into one after it does.
 */
export const ParitySwitchSchema = z.enum(["off", "on", "when-needed"]);
export type ParitySwitch = z.infer<typeof ParitySwitchSchema>;
const kindName = z.string().regex(/^[a-z][a-z0-9-]{1,29}$/);
export const ParitySwitchesSchema = z.record(kindName, ParitySwitchSchema);
export type ParitySwitches = z.infer<typeof ParitySwitchesSchema>;
const settingKey = "channel-parity-switches";

/** Every saved switch. A service that is not named is off. */
export function paritySwitches(store: Store, owner: string): ParitySwitches {
  const parsed = ParitySwitchesSchema.safeParse(store.get("settings", owner, settingKey)?.data ?? {});
  return parsed.success ? parsed.data : {};
}
export function paritySwitch(store: Store, owner: string, kind: string): ParitySwitch {
  return paritySwitches(store, owner)[kind] ?? "off";
}
/** Changes the switches named; the others keep their value. */
export function saveParitySwitches(store: Store, owner: string, input: unknown, known: readonly string[]): ParitySwitches {
  const change = ParitySwitchesSchema.parse(input ?? {});
  const unknown = Object.keys(change).filter((kind) => !known.includes(kind));
  if (unknown.length) throw new Error(`There is no chat service called ${unknown.join(", ")}`);
  const next = { ...paritySwitches(store, owner), ...change };
  store.save("settings", owner, settingKey, next);
  return next;
}

/** A service that is posted to rather than polled: the web address hands the exact bytes over. */
export interface PostedChannel {
  /** False while the owner has the service switched off, so a post is turned away without blame. */
  accepting?(): boolean;
  receivePost(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ accepted: number; reply?: unknown }>;
}
export function isPostedChannel(value: unknown): value is ChannelAdapter & PostedChannel {
  if (value instanceof SwitchedChannel) return isPostedChannel(value.inner);
  return !!value && typeof (value as Partial<PostedChannel>).receivePost === "function";
}

export interface SwitchedOptions {
  /** Read every time it matters, so a change in Customize applies without a restart. */
  read: () => ParitySwitch;
  /** How long "when needed" keeps a connection open after the last message, in milliseconds. */
  idleMs?: number;
  /** What the switch is called on screen, for the health line. */
  where?: string;
}
const fifteenMinutes = 15 * 60 * 1000;

/**
 * Puts one channel behind its switch. The router sees an ordinary channel; whether the real
 * connection is open is this wrapper's business.
 */
export class SwitchedChannel implements ChannelAdapter, PostedChannel {
  readonly id: string;
  readonly kind: string;
  readonly maxTextLength?: number;
  private deliver: ((message: InboundMessage) => Promise<void>) | null = null;
  private open: Promise<void> | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly inner: ChannelAdapter, private readonly options: SwitchedOptions) {
    this.id = inner.id;
    this.kind = inner.kind;
    if (inner.maxTextLength !== undefined) this.maxTextLength = inner.maxTextLength;
  }
  get position(): ParitySwitch { return this.options.read(); }
  botName(): string | null { return this.inner.botName(); }
  health(): ChannelHealth {
    const where = this.options.where ?? "Customize, Chat apps";
    if (this.position === "off") return { state: "needs attention", reason: `Switched off. Turn it on in ${where}.` };
    if (!this.open) return { state: "connected", reason: "Opens the connection when there is something to send" };
    return this.inner.health?.() ?? { state: "connected" };
  }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.deliver = onMessage;
    await this.refresh();
  }
  /** Opens or closes the real connection to match the switch as it is now. */
  async refresh(): Promise<void> {
    const position = this.position;
    if (position === "on") return this.ensureOpen();
    if (position === "off" || !this.idle) await this.close();
  }
  async stop(): Promise<void> {
    this.deliver = null;
    await this.close();
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    await this.wake();
    return this.inner.send(chatId, text, replyToMessageId);
  }
  accepting(): boolean { return this.position !== "off"; }
  async receivePost(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ accepted: number; reply?: unknown }> {
    if (!isPostedChannel(this.inner)) throw new Error("This chat service is not posted to");
    await this.wake();
    return this.inner.receivePost(raw, headers);
  }
  /** Chat-live's optional extras, passed through when the real channel has them. */
  async sendTyping(chatId: string): Promise<void> {
    const inner = this.inner as { sendTyping?(chatId: string): Promise<void> };
    if (this.open && inner.sendTyping) await inner.sendTyping(chatId);
  }
  private async wake(): Promise<void> {
    const position = this.position;
    if (position === "off") throw new Error(`${this.kind} is switched off, so nothing was sent`);
    await this.ensureOpen();
    if (position === "when-needed") this.restartIdle();
  }
  private ensureOpen(): Promise<void> {
    if (!this.open) {
      const deliver = this.deliver ?? (async () => undefined);
      this.open = this.inner.start((message) => {
        if (this.position === "when-needed") this.restartIdle();
        return deliver(message);
      }).catch((error: unknown) => { this.open = null; throw error; });
    }
    return this.open;
  }
  private restartIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.idle = undefined; void this.close(); }, this.options.idleMs ?? fifteenMinutes);
    this.idle.unref?.();
  }
  private async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    if (!this.open) return;
    const was = this.open;
    this.open = null;
    await was.catch(() => undefined);
    await this.inner.stop();
  }
}

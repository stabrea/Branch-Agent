import { randomInt } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";
import type { Runtime } from "../runtime.js";
import type { PolicyRemember } from "../policy.js";
import { Deliveries } from "./deliveries.js";
import { audit } from "../audit.js";
import { decide, readSenderAllowlist } from "./allowlist.js";
import type { Run } from "../contracts.js";
import { LiveStatus, defaultLiveTiming, statusEmoji, type LiveTiming } from "./live-status.js";
import { chatLiveSwitches, saveChatLiveSwitches, type ChatLiveSwitches } from "./chat-live-settings.js";
import { parseChatCommand, runChatCommand, usageFooter, usageShown, type ChatCommand, type ChatTurn } from "./chat-commands.js";

/**
 * Messaging channels (Telegram first) deliver messages from chats into conversations. Each chat
 * keeps its own conversation; unknown senders must pair once with a code the owner approves;
 * group chats answer only when addressed unless configured otherwise. Channel tasks never get
 * host command execution.
 */
export interface InboundMessage {
  channel: string;
  chatId: string;
  chatKind: "direct" | "group";
  chatTitle?: string;
  senderId: string;
  senderName: string;
  text: string;
  addressed: boolean;
  messageId: string;
  /** The message a reaction goes on, where it differs from `messageId` (a Slack thread reply). */
  reactTo?: string;
  /**
   * A voice note, when the person sent one instead of typing. The bytes are fetched only if the
   * message gets as far as being answered, so a stranger cannot make Branch download anything.
   */
  voice?: {
    mediaType: string;
    seconds?: number | undefined;
    bytes: () => Promise<Uint8Array>;
  };
}
/** What a channel says about itself, in words the owner can act on. */
export interface ChannelHealth {
  state: "connected" | "reconnecting" | "needs attention";
  reason?: string;
}
export interface ChannelAdapter {
  readonly id: string;
  readonly kind: string;
  /** Longest single message this channel accepts; the ledger splits replies to fit. */
  readonly maxTextLength?: number;
  /**
   * True when the service will not let the assistant write to anybody outside the owner's own team
   * until that service has reviewed the app. Shown in Connections so it is not a surprise.
   */
  readonly needsAppReview?: boolean;
  botName(): string | null;
  /** Connection state in plain language, shown in Settings -> Channels. */
  health?(): ChannelHealth;
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined>;
  /** Sends a spoken reply, on the channels that accept one. Absent means this channel cannot. */
  sendVoice?(chatId: string, audio: Uint8Array, mediaType: string, replyToMessageId?: string): Promise<string | undefined>;
  /**
   * Sends a question with buttons to press, on the channels that have them. Absent means this
   * channel has none, and the question goes out as words with "reply y / a / n" instead.
   */
  sendButtons?(chatId: string, text: string, buttons: ApprovalButton[], replyToMessageId?: string): Promise<string | undefined>;
  /** Shows "typing…" in the chat for a few seconds, on the apps that have it. See live-status.ts. */
  sendTyping?(chatId: string): Promise<void>;
  /**
   * Puts `emoji` on a message, taking `previous` off first on the apps that keep several side by
   * side. Absent means this app has no reactions and the status shows only as typing and progress.
   */
  react?(chatId: string, messageId: string, emoji: string, previous?: string): Promise<void>;
  /** Replaces the words of a message this adapter sent. Absent means there is no progress message. */
  edit?(chatId: string, messageId: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

/** One answer on an approval question, as a button. `value` is what comes back when it is pressed. */
export interface ApprovalButton {
  label: string;
  value: string;
}

/**
 * The three answers an approval question offers in a chat app, and the letters that stand for them
 * where there are no buttons. "Yes always" is only offered for a task the owner started themselves,
 * the same rule the app's own approval card follows.
 */
export function approvalButtons(fingerprint: string, canAlways: boolean): ApprovalButton[] {
  const answers: [string, string][] = [["Yes", "y"], ...(canAlways ? [["Yes always", "a"] as [string, string]] : []), ["No", "n"]];
  // A button carries its answer and the fingerprint of the exact request, so a yes cannot be
  // replayed against a different one. Telegram allows 64 bytes here and this is at most 34.
  return answers.map(([label, letter]) => ({ label, value: `${letter}:${fingerprint.slice(0, 32)}` }));
}

/** Reads a pressed button, or a typed letter, back into a decision. */
export function readApprovalAnswer(value: string): { decision: "allow" | "deny"; remember: PolicyRemember; fingerprint: string } | null {
  const [letter, fingerprint = ""] = String(value ?? "").trim().toLowerCase().split(":");
  if (letter === "y") return { decision: "allow", remember: "session", fingerprint };
  if (letter === "a") return { decision: "allow", remember: "always", fingerprint };
  if (letter === "n") return { decision: "deny", remember: "session", fingerprint };
  return null;
}

/** The words that go out with the buttons, and on their own where a channel has no buttons. */
export const approvalFallbackNote = "Reply y for yes, a for yes always, or n for no.";
/**
 * A pressed button, as opposed to a typed letter: it carries the fingerprint of the exact request.
 * Pressing the same button again must not become a new task saying "y:8f3a…", so a payload of this
 * shape that answered nothing is answered with words instead of being run.
 *
 * It covers two cases that look the same from here and must not be told apart wrongly: the question
 * has gone, and the button belongs to a different request from the one waiting now. The words
 * therefore promise neither — they say the button no longer fits and what to do next.
 */
const buttonPayload = /^[yan]:[0-9a-f]{1,32}$/;
export const staleButtonNote =
  "That button does not match the question waiting here. Send me a message and I will ask again.";
export const ChannelPolicySchema = z.object({
  activation: z.enum(["mention", "always"]).default("mention"),
  pairing: z.boolean().default(true),
  allowlist: z.array(z.string().min(1).max(64)).max(64).default([]),
}).strict();
export type ChannelPolicy = z.infer<typeof ChannelPolicySchema>;
export type Outcome = "replied" | "ignored" | "pairing" | "rejected" | "failed";
const pairSchema = z.object({
  status: z.enum(["pending", "approved"]), code: z.string().length(6), name: z.string().max(120),
  requestedAt: z.string(), approvedAt: z.string().optional(),
}).strict();
type Pair = z.infer<typeof pairSchema>;

/** One chat's task while it gathers messages and works. */
interface ChatTurnState extends ChatTurn {
  phase: "gathering" | "running";
  dropped: boolean;
  messages: InboundMessage[];
  notes: { text: string; message: InboundMessage; passed?: boolean; late?: boolean }[];
  waiters: ((outcome: Outcome) => void)[];
  live: LiveStatus | null;
}
const chatKey = (message: InboundMessage): string => `${message.channel}\u0001${message.chatId}`;
/** One turn gathers at most this many messages, and never more words than a task may start with. */
const turnMessages = 10, turnCharacters = 12000;
function fitsTurn(messages: InboundMessage[], next: InboundMessage): boolean {
  const size = [...messages, next].reduce((sum, m) => sum + m.text.length + (m.chatTitle?.length ?? 0) + m.senderName.length + 10, 0);
  return messages.length < turnMessages && size <= turnCharacters;
}
/** A note turned back into a message of its own, with the words already written out. */
function withText(message: InboundMessage, text: string): InboundMessage {
  const { voice, ...rest } = message;
  void voice;
  return { ...rest, text };
}

export class ChannelRouter {
  private readonly adapters = new Map<string, { adapter: ChannelAdapter; policy: ChannelPolicy }>();
  readonly deliveries: Deliveries;
  private pump: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> = Promise.resolve();
  /**
   * The last look at a message before it leaves this computer: personal details are hidden and,
   * when the owner has switched it on, the provider's content check runs. `createBranch` connects
   * the real check; on its own this lets everything through unchanged.
   */
  outboundGuard: (text: string) => Promise<{ text: string; blocked: boolean; reason?: string }> =
    async (text) => ({ text, blocked: false });
  /**
   * Batch 26 (wave 8): the ceiling the owner set for one person messaging from outside. `createBranch`
   * connects the real counter; on its own nothing is limited. Somebody who reaches it is told so in
   * one sentence and their message is let go rather than queued behind everybody else's, because a
   * stranger waiting silently for a minute looks exactly like Branch being broken.
   */
  senderCeiling: ((channel: string, senderId: string) => { ok: boolean; reason: string }) | undefined;
  /**
   * Turns a voice note into words. `createBranch` connects the real voice service; on its own this
   * says plainly that nothing is set up, so a voice note is never silently dropped.
   */
  transcribeVoice: (clip: { bytes: Uint8Array; mediaType: string; name: string; seconds?: number | undefined }) => Promise<string> =
    async () => { throw new Error("Voice notes are not set up on this computer yet"); };
  /**
   * Reads a reply aloud so it can be sent back as a voice note, but only when the owner has asked
   * for that. Returning null means "send the words instead", which is what happens by default.
   */
  speakReply: (text: string) => Promise<{ bytes: Uint8Array; mediaType: string } | null> = async () => null;
  /**
   * Messages from one chat that arrive within this many milliseconds of the first become one
   * turn, so a thought typed as three quick messages is answered once.
   */
  mergeWindowMs = 1000;
  /** How often the chat's typing, reaction and progress message are refreshed. */
  liveTiming: LiveTiming = defaultLiveTiming;
  /**
   * Whether typing, reactions and progress messages may be shown at all. `createBranch` turns them
   * off while Lockdown is on, as it does every other outbound message.
   */
  liveAllowed: () => boolean = () => true;
  private readonly turns = new Map<string, ChatTurnState>();
  /** How many chats may have a task working at the same time. */
  maxChatTasks = 4;
  private chatTasks = 0;
  private readonly slotWaiters: (() => void)[] = [];
  constructor(private readonly store: Store, private readonly runtime: Runtime, public pumpMs = 10000) {
    this.deliveries = new Deliveries(store, runtime.owner);
    this.deliveries.splitting = () => this.switches().splitting;
  }
  async attach(adapter: ChannelAdapter, policy: ChannelPolicy): Promise<void> {
    if (this.adapters.has(adapter.id)) throw new Error(`Channel ${adapter.id} is already attached`);
    this.adapters.set(adapter.id, { adapter, policy: ChannelPolicySchema.parse(policy) });
    // This resolves once the message has been dealt with. An adapter that reads messages one by one
    // must not wait for it, or a note sent to a running task could never get through (see telegram.ts).
    await adapter.start((message) => this.handle(message).then(() => undefined));
    if (!this.pump) { this.pump = setInterval(() => void this.flush(), this.pumpMs); this.pump.unref(); }
    await this.flush();
  }
  /** The connected channel with this id, for routes that must hand a request to one. */
  adapter(id: string): ChannelAdapter | undefined { return this.adapters.get(id)?.adapter; }
  async detachAll(): Promise<void> {
    if (this.pump) clearInterval(this.pump);
    this.pump = undefined;
    const stops = [...this.adapters.values()].map(({ adapter }) => adapter.stop());
    this.adapters.clear();
    await Promise.allSettled(stops);
  }
  /** Sends every due chunk on every connected channel, one flush at a time. */
  flush(): Promise<void> {
    return (this.flushing = this.flushing.then(async () => {
      for (const [id, { adapter }] of this.adapters)
        await this.deliveries.flush(id, (chatId, text, replyTo) => adapter.send(chatId, text, replyTo)).catch(() => undefined);
    }));
  }
  /** Outbound messages that are waiting or gave up, for the owner to see and retry. */
  outstanding() {
    return this.deliveries.outstanding().map((d) => ({ id: d.id, channel: d.channel, chatId: d.chatId, status: d.status, attempts: d.attempts,
      lastError: d.lastError, nextAt: d.nextAt, preview: d.text.slice(0, 120), createdAt: d.createdAt }));
  }
  async retryDelivery(id: string) {
    const row = this.deliveries.retry(id);
    await this.flush();
    return this.deliveries.list().find((d) => d.id === row.id) ?? row;
  }
  summary() {
    const owner = this.runtime.owner;
    return {
      channels: [...this.adapters.values()].map(({ adapter, policy }) => ({ id: adapter.id, kind: adapter.kind, botName: adapter.botName(),
        health: adapter.health?.() ?? { state: "connected" as const },
        ...(adapter.needsAppReview ? { needsAppReview: true } : {}), ...policy })),
      pending: this.pairs(owner).filter((p) => p.status === "pending"),
      approved: this.pairs(owner).filter((p) => p.status === "approved"),
      chats: this.chats(owner),
      live: this.switches(),
    };
  }
  /** Changes the chat extras' switches (chat-live-settings.ts); the ones not named stay as they are. */
  setSwitches(input: unknown): ChatLiveSwitches {
    return saveChatLiveSwitches(this.store, this.runtime.owner, input);
  }
  /**
   * Queues text for a chat and sends it if the channel is up. The key makes a repeat call a no-op,
   * so a task finished while the channel was down is delivered once, in order, after reconnect.
   */
  async deliver(channel: string, chatId: string, text: string, key = `delivery:${Date.now()}:${randomInt(1e9)}`, replyTo?: string): Promise<{ messageId?: string | undefined; queued: number }> {
    const target = this.adapters.get(channel);
    if (!target) throw new Error(`Channel ${channel} is not connected`);
    const checked = await this.outboundGuard(text);
    if (checked.blocked) throw new Error(checked.reason ?? "The message was held back before it was sent");
    this.deliveries.enqueue(channel, chatId, checked.text, key, replyTo, target.adapter.maxTextLength);
    await this.flush();
    const now = this.deliveries.list().filter((d) => d.key === key);
    const first = now.find((d) => d.seq === 0);
    if (first?.status === "dead") throw new Error(`Could not deliver to ${channel}: ${first.lastError ?? "unknown error"}`);
    return { messageId: first?.messageId ?? undefined, queued: now.filter((d) => d.status === "pending").length };
  }
  /** Points a chat at an existing conversation so both surfaces share one ordered history. */
  link(owner: string, input: unknown) {
    const { channel, chatId, sessionId } = z.object({ channel: z.string().min(1).max(64), chatId: z.string().min(1).max(64), sessionId: z.string().uuid() }).strict().parse(input);
    if (!this.store.ownsSession(owner, sessionId)) throw new Error("Session not found");
    const key = `channel-session:${channel}:${chatId}`;
    const saved = this.store.get("settings", owner, key)?.data as { title?: string } | undefined;
    this.store.save("settings", owner, key, { sessionId, channel, chatId, title: saved?.title ?? chatId, updatedAt: new Date().toISOString(), linked: true });
    audit(this.store, owner, { action: "channel.paired", actor: owner, subject: `${chatId} on ${channel}`,
      reason: "A chat was pointed at one of your conversations, so both share one history", outcome: "saved" });
    return { channel, chatId, sessionId };
  }
  /** Chats that have talked to the assistant, usable as delivery targets. */
  chats(owner: string) {
    return this.store.list("settings", owner).flatMap((record) => {
      if (!record.id.startsWith("channel-session:")) return [];
      const data = record.data as { channel?: string; chatId?: string; title?: string; updatedAt?: string };
      return data.channel && data.chatId ? [{ channel: data.channel, chatId: data.chatId, title: data.title ?? data.chatId, updatedAt: data.updatedAt ?? record.updatedAt, sessionId: (data as { sessionId?: string }).sessionId ?? null }] : [];
    });
  }
  async handle(message: InboundMessage): Promise<Outcome> {
    const entry = this.adapters.get(message.channel);
    if (!entry) return "ignored";
    const { adapter, policy } = entry;
    if (message.chatKind === "group" && policy.activation === "mention" && !message.addressed) return "ignored";
    const access = this.access(message, policy);
    if (access !== "allowed") {
      const text = access === "pairing"
        ? `I don't know you yet. Ask my owner to approve code ${this.pairingCode(message)} under Settings → Channels, then message me again.`
        : "This assistant is private.";
      await adapter.send(message.chatId, text, message.messageId);
      return access;
    }
    return this.answer(message);
  }
  /**
   * A voice note becomes an ordinary message: the words are written out first, and the transcript
   * is quoted back so the person can see what was heard before reading the answer.
   */
  private async spoken(message: InboundMessage): Promise<string> {
    if (!message.voice) return message.text;
    const bytes = await message.voice.bytes();
    const text = await this.transcribeVoice({
      bytes, mediaType: message.voice.mediaType, name: `voice-note-${message.messageId}`, seconds: message.voice.seconds,
    });
    return [message.text, text].filter(Boolean).join("\n").trim();
  }
  /**
   * Answers a voice note with a voice note, when the owner has switched that on and the channel
   * accepts one. The words have already been sent, so a failure here changes nothing for the person.
   */
  private async voiceReply(message: InboundMessage, text: string): Promise<void> {
    const adapter = this.adapters.get(message.channel)?.adapter;
    if (!adapter?.sendVoice) return;
    const checked = await this.outboundGuard(text);
    if (checked.blocked) return;
    const spoken = await this.speakReply(checked.text);
    if (!spoken) return;
    await adapter.sendVoice(message.chatId, spoken.bytes, spoken.mediaType, message.messageId);
  }
  /** The conversation this chat is carrying on, when there is one. */
  private sessionFor(channel: string, chatId: string): string | undefined {
    const owner = this.runtime.owner;
    const saved = this.store.get("settings", owner, `channel-session:${channel}:${chatId}`)?.data as { sessionId?: string } | undefined;
    return saved?.sessionId && this.store.ownsSession(owner, saved.sessionId) ? saved.sessionId : undefined;
  }

  /**
   * Answers the question a paused task in this chat's conversation stopped on. It is the same
   * approval route the app uses, bound to the same exact-bytes fingerprint, and the record of what
   * the assistant was allowed to do says which chat app the answer came from.
   *
   * Returns null when this chat has nothing waiting, so an ordinary message that happens to be the
   * single letter "n" is still an ordinary message.
   */
  async answerApproval(channel: string, chatId: string, value: string): Promise<{ decision: string; tool: string } | null> {
    const read = readApprovalAnswer(value);
    if (!read) return null;
    const sessionId = this.sessionFor(channel, chatId);
    if (!sessionId || !this.runtime.waitingApprovals(sessionId).length) return null;
    const result = this.runtime.approve(sessionId, read.decision, read.remember,
      read.fingerprint || undefined, channel);
    return { decision: result.decision, tool: result.tool };
  }

  /**
   * Puts a paused task's question to the chat, with buttons where the channel has them and the
   * words "reply y / a / n" where it has not. Sent directly rather than through the waiting line,
   * because the waiting line only knows how to send plain words.
   */
  private async askInChat(message: InboundMessage, question: string, sessionId: string): Promise<void> {
    const adapter = this.adapters.get(message.channel)?.adapter;
    if (!adapter) return;
    const waiting = this.runtime.waitingApprovals(sessionId).at(-1);
    const checked = await this.outboundGuard(question);
    if (checked.blocked) return;
    const canAlways = waiting?.source === "owner";
    const buttons = approvalButtons(waiting?.fingerprint ?? "", canAlways);
    if (adapter.sendButtons) {
      await adapter.sendButtons(message.chatId, checked.text, buttons, message.messageId).catch(() => undefined);
      return;
    }
    await this.deliver(message.channel, message.chatId, `${checked.text}\n\n${approvalFallbackNote}`,
      `ask:${waiting?.runId ?? message.messageId}`, message.messageId).catch(() => undefined);
  }

  private async answer(message: InboundMessage): Promise<Outcome> {
    const command = this.commandIn(message);
    if (command) return this.command(message, command);
    // A bare "y", "a" or "n" answers whatever this chat's conversation is waiting on, rather than
    // starting a new task. Anything longer is an ordinary message, whatever it happens to say.
    const answered = await this.answerApproval(message.channel, message.chatId, message.text.trim()).catch(() => null);
    if (answered) {
      await this.deliver(message.channel, message.chatId,
        answered.decision === "allow"
          ? `Noted. Send your next message and I will carry on.`
          : `Noted. I will not do that.`,
        `answered:${message.messageId}`, message.messageId).catch(() => undefined);
      return "replied";
    }
    // A button pressed twice, pressed after the question went away, or carrying the fingerprint of
    // some other request: say so rather than treating the button's own value as something the
    // person typed and running it as a task.
    if (buttonPayload.test(message.text.trim().toLowerCase())) {
      await this.deliver(message.channel, message.chatId, staleButtonNote,
        `stale:${message.messageId}`, message.messageId).catch(() => undefined);
      return "replied";
    }
    const turn = this.turns.get(chatKey(message));
    if (turn) return this.joinTurn(turn, message);
    return this.startTurn([message]);
  }
  /** The owner's on / off / when-needed switches for the chat extras (chat-live-settings.ts). */
  switches(): ChatLiveSwitches {
    return chatLiveSwitches(this.store, this.runtime.owner);
  }
  /** The command a message is, if commands are switched on for this moment. */
  private commandIn(message: InboundMessage): ChatCommand | null {
    const setting = this.switches().commands;
    if (setting === "off" || message.voice) return null;
    const command = parseChatCommand(message.text);
    if (!command || setting === "on") return command;
    // "When needed": only the commands for a task that is working, and only while one is.
    const busy = this.turns.has(chatKey(message));
    return busy && ["stop", "status", "btw", "help"].includes(command.name) ? command : null;
  }
  /** What a task started from a chat may use. See `answer` for why each one is left out. */
  private chatPermissions(): string[] {
    // A message from a chat app can read and change the local copy, but never publish it, and
    // never send to somebody else's chat: a paired person in one group must not be able to
    // make the assistant write to every chat it is linked to.
    return this.runtime.registry.permissions().filter((p) => !["shell.execute", "remote.execute", "git.remote", "github.manage", "channels.send"].includes(p));
  }
  // ---- chat-live (wave mac2): one task per chat, notes steer it, commands control it ----------
  /** Carries out a chat command and sends its answer back. */
  private async command(message: InboundMessage, command: ChatCommand): Promise<Outcome> {
    const { channel, chatId } = message;
    const turn = this.turns.get(chatKey(message));
    const reply = await runChatCommand(command, {
      runtime: this.runtime, channel, chatId, turn,
      sessionId: this.sessionFor(channel, chatId), permissions: this.chatPermissions(),
      dropWaiting: () => {
        if (!turn || turn.runId) return false;
        turn.dropped = true;
        return true;
      },
      forget: () => this.forgetSession(channel, chatId),
    });
    await this.deliver(channel, chatId, reply, `command:${chatId}:${message.messageId}`, message.messageId).catch(() => undefined);
    return "replied";
  }
  /** Keeps the chat in the list of chats, but pointed at no conversation. */
  private forgetSession(channel: string, chatId: string): void {
    const owner = this.runtime.owner, key = `channel-session:${channel}:${chatId}`;
    const saved = this.store.get("settings", owner, key)?.data as { title?: string } | undefined;
    this.store.save("settings", owner, key, { channel, chatId, title: saved?.title ?? chatId, updatedAt: new Date().toISOString() });
  }
  /**
   * A message for a chat that already has a task going. While the task is still gathering, the
   * message joins it as part of the same turn. Once it is working, the message is passed to it as a
   * note it reads before its next step (the same path as the app's "steer" button).
   */
  private async joinTurn(turn: ChatTurnState, message: InboundMessage): Promise<Outcome> {
    // A service that hands over the same message twice gets one answer.
    if ([...turn.messages, ...turn.notes.map((note) => note.message)].some((m) => m.messageId === message.messageId)) return "ignored";
    const steering = this.switches().steering;
    if (steering === "off") {
      // Not steering: the message waits for the task to finish and is then answered on its own.
      await new Promise<void>((resolve) => turn.waiters.push(() => resolve()));
      const next = this.turns.get(chatKey(message));
      return next ? this.joinTurn(next, message) : this.startTurn([message]);
    }
    if (turn.phase === "gathering" && fitsTurn(turn.messages, message)) {
      turn.messages.push(message);
      return new Promise((resolve) => turn.waiters.push(resolve));
    }
    let heard: string;
    try {
      heard = (await this.spoken(message)).trim();
    } catch {
      return "failed";
    }
    if (!heard) return "ignored";
    turn.notes.push({ text: heard, message });
    if (turn.runId) this.passNotes(turn);
    const adapter = this.adapters.get(message.channel)?.adapter;
    if (adapter?.react && this.liveOn() && this.switches().liveStatus !== "off") await adapter.react(message.chatId, message.reactTo ?? message.messageId, statusEmoji.queued).catch(() => undefined);
    else await this.deliver(message.channel, message.chatId, "Noted. I will take that into account as I go.",
      `noted:${message.chatId}:${message.messageId}`, message.messageId).catch(() => undefined);
    return "replied";
  }
  /** Hands the waiting notes to the running task; a note it can no longer take waits for the next turn. */
  private passNotes(turn: ChatTurnState): void {
    for (const note of turn.notes) {
      if (note.passed || note.late) continue;
      try {
        this.runtime.steer(turn.runId!, note.text);
        note.passed = true;
        turn.passed++;
      } catch {
        note.late = true;
      }
    }
  }
  /**
   * Notes the task never read: sent too late, or passed just as it wrote its last answer. They
   * become the next turn rather than being lost.
   */
  private unreadNotes(turn: ChatTurnState): ChatTurnState["notes"] {
    const read = turn.runId ? this.store.events(turn.runId).filter((e) => e.kind === "run.steer_applied")
      .reduce((sum, e) => sum + Number(e.data.notes ?? 0), 0) : 0;
    const passed = turn.notes.filter((note) => note.passed);
    return [...passed.slice(read), ...turn.notes.filter((note) => !note.passed)];
  }
  /** Opens a turn for a chat, waits briefly for more messages, then runs them as one task. */
  private async startTurn(all: InboundMessage[], followUp = false): Promise<Outcome> {
    const first = all[0]!, key = chatKey(first);
    // Notes left over from the last task become this one; what does not fit is passed in as notes.
    const messages = followUp ? all.filter((m, index) => index === 0 || fitsTurn(all.slice(0, index), m)) : all;
    const notes = all.filter((m) => !messages.includes(m)).map((message) => ({ text: message.text, message }));
    const turn: ChatTurnState = { phase: "gathering", runId: null, startedAt: Date.now(), passed: 0, dropped: false,
      messages, notes, waiters: [], live: this.liveFor(first) };
    this.turns.set(key, turn);
    turn.live?.start();
    if (this.mergeWindowMs > 0 && this.switches().steering === "on")
      await new Promise((resolve) => setTimeout(resolve, this.mergeWindowMs).unref());
    let outcome: Outcome = "ignored";
    try {
      // A dropped message only gets the "Dropped that" words; nothing more is shown for it.
      if (turn.dropped) turn.live?.cancel();
      else { turn.phase = "running"; outcome = await this.withSlot(() => this.runTurn(turn)); }
    } finally {
      this.turns.delete(key);
      for (const resolve of turn.waiters) resolve(outcome);
    }
    const unread = turn.dropped ? [] : this.unreadNotes(turn);
    if (unread.length) void this.startTurn(unread.map((note) => withText(note.message, note.text)), true).catch(() => undefined);
    return outcome;
  }
  /** Runs one turn's messages as a task and sends the answer, showing progress while it works. */
  private async runTurn(turn: ChatTurnState): Promise<Outcome> {
    const message = turn.messages[0]!, live = turn.live;
    const heard = await this.heardAll(turn.messages);
    if (typeof heard === "string") { live?.cancel(); return this.voiceFailed(message, heard); }
    const off = this.store.onEvent((runId, kind, data) => { if (runId === turn.runId) live?.event(kind, data); });
    try {
      const sessionId = this.sessionFor(message.channel, message.chatId);
      const run = await this.runtime.run({
        prompt: heard.prompt, ...(sessionId ? { sessionId } : {}), permissions: this.chatPermissions(),
        onStarted: (started) => {
          turn.runId = started.id;
          turn.startedAt = Date.now();
          live?.thinking();
          if (turn.dropped) this.runtime.cancel(started.id);
          this.passNotes(turn);
        },
        onTextDelta: (delta) => live?.text(delta), // stream so a silent model is noticed
      });
      return await this.finishTurn(turn, run, heard.quoted);
    } catch (error) {
      await live?.finish("error");
      await this.deliver(message.channel, message.chatId, "Something went wrong on my side; the owner can see the details in Activity.", `reply-error:${message.channel}:${message.messageId}`, message.messageId).catch(() => undefined);
      void error;
      return "failed";
    } finally {
      off();
    }
  }
  /**
   * The words of every message in the turn, voice notes written out first. A voice note that cannot
   * be made out ends the turn with the reason, as a single message always did.
   */
  private async heardAll(messages: InboundMessage[]): Promise<{ prompt: string; quoted: string } | string> {
    const parts: string[] = [], spokenParts: string[] = [];
    for (const message of messages) {
      let heard: string;
      try {
        heard = await this.spoken(message);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      if (message.voice) spokenParts.push(heard);
      parts.push(message.chatKind === "group" ? `[${message.senderName} in ${message.chatTitle ?? "a group"}] ${heard}` : heard);
    }
    const quoted = spokenParts.length ? `You said (from your voice note): "${spokenParts.join(" ")}"\n\n` : "";
    return { prompt: parts.join("\n"), quoted };
  }
  private async voiceFailed(message: InboundMessage, reason: string): Promise<Outcome> {
    await this.deliver(message.channel, message.chatId, `I could not make out that voice note: ${reason}`,
      `voice-failed:${message.channel}:${message.messageId}`, message.messageId).catch(() => undefined);
    return "failed";
  }
  /** Writes down which conversation the chat is on, then sends the answer or the question. */
  private async finishTurn(turn: ChatTurnState, run: Run, quoted: string): Promise<Outcome> {
    const message = turn.messages[0]!, live = turn.live;
    this.store.save("settings", this.runtime.owner, `channel-session:${message.channel}:${message.chatId}`, { sessionId: run.sessionId, channel: message.channel, chatId: message.chatId,
      title: message.chatKind === "group" ? (message.chatTitle ?? message.chatId) : message.senderName, updatedAt: run.updatedAt });
    const said = run.status === "completed" ? run.output || "(no reply)" : run.status === "needs_input" ? run.output
      : run.status === "cancelled" ? "Stopped." : `I could not finish that (${run.status}).`;
    // A task that stopped to ask goes out as a question with buttons, not as words to read.
    if (run.status === "needs_input" && this.runtime.waitingApprovals(run.sessionId).length) {
      await live?.finish("done");
      await this.askInChat(message, quoted + said, run.sessionId);
      return "replied";
    }
    const footer = usageShown(this.runtime, message.channel, message.chatId) ? usageFooter(this.runtime, run.id) : null;
    const text = quoted + said + (footer ? `\n\n${footer}` : "");
    const ok = run.status === "completed" || run.status === "needs_input";
    await this.sendReply(message, run.id, text, await live?.finish(ok ? "done" : "error", text) ?? null);
    if (message.voice) await this.voiceReply(message, said).catch(() => undefined);
    return ok ? "replied" : "failed";
  }
  /**
   * Batch 20 (wave 8): the message going back out is the last step of the task, so it hangs off the
   * same trace even though the task itself has already settled. When the progress message already
   * became the reply, it is only written down.
   */
  private async sendReply(message: InboundMessage, runId: string, text: string, placed: { messageId: string; text: string } | null): Promise<void> {
    const span = this.runtime.tracer.startAfter(runId, "delivery", `branch.delivery ${message.channel}`, {
      "branch.channel": message.channel, "branch.delivery.characters": text.length,
    });
    if (placed) {
      this.deliveries.recordSent(message.channel, message.chatId, placed.text, `reply:${runId}`, placed.messageId, message.messageId);
      span?.end("ok", "", { "branch.delivery.queued": 0 });
      return;
    }
    await this.deliver(message.channel, message.chatId, text, `reply:${runId}`, message.messageId)
      .then((sent) => span?.end("ok", "", { "branch.delivery.queued": sent.queued }))
      .catch((error) => span?.end("error", error instanceof Error ? error.message : String(error)));
  }
  /**
   * At most `maxChatTasks` chats have a task working at once. No adapter waits for one message
   * before reading the next, so this is what keeps a burst of messages from many chats from
   * starting a task for each of them at the same moment. The rest wait their turn.
   */
  private async withSlot<T>(work: () => Promise<T>): Promise<T> {
    while (this.chatTasks >= this.maxChatTasks) await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    this.chatTasks++;
    try {
      return await work();
    } finally {
      this.chatTasks--;
      this.slotWaiters.shift()?.();
    }
  }
  /** Whether a chat may be shown typing, reactions and progress right now. */
  private liveOn(): boolean {
    return this.liveAllowed() && !this.deliveries.holdUntil(new Date());
  }
  private liveFor(message: InboundMessage): LiveStatus | null {
    const adapter = this.adapters.get(message.channel)?.adapter, setting = this.switches().liveStatus;
    if (!adapter || setting === "off" || !this.liveOn() || (!adapter.sendTyping && !adapter.react && !adapter.edit)) return null;
    return new LiveStatus({ adapter, chatId: message.chatId, messageId: message.messageId, reactTo: message.reactTo },
      (text) => this.outboundGuard(text), this.liveTiming, setting === "when-needed");
  }
  private access(message: InboundMessage, policy: ChannelPolicy): "allowed" | "pairing" | "rejected" {
    // Batch 20 (wave 8): the one list for every chat app is read first, so "never this person"
    // holds everywhere at once. A channel's own list still works and is read after it.
    const list = readSenderAllowlist(this.store, this.runtime.owner);
    const said = decide(list, message.channel, message.senderId);
    if (said === "block") return "rejected";
    if (said === "allow") return "allowed";
    if (policy.allowlist.includes(message.senderId)) return "allowed";
    if (this.pair(message.channel, message.senderId)?.status === "approved") return "allowed";
    if (list.unknown === "block") return "rejected";
    return policy.pairing ? "pairing" : "rejected";
  }
  private pairingCode(message: InboundMessage): string {
    const existing = this.pair(message.channel, message.senderId);
    if (existing?.status === "pending") return existing.code;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.store.save("settings", this.runtime.owner, `channel-pair:${message.channel}:${message.senderId}`,
      { status: "pending", code, name: message.senderName.slice(0, 120), requestedAt: new Date().toISOString() } satisfies Pair);
    return code;
  }
  /** The owner approves a pending sender by typing the code the sender was shown. */
  approve(owner: string, input: unknown) {
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).strict().parse(input);
    const match = this.pairs(owner).find((p) => p.status === "pending" && p.code === code);
    if (!match) throw new Error("No pending request has that code");
    const approved: Pair = { status: "approved", code: match.code, name: match.name, requestedAt: match.requestedAt, approvedAt: new Date().toISOString() };
    this.store.save("settings", owner, `channel-pair:${match.channel}:${match.senderId}`, approved);
    audit(this.store, owner, { action: "channel.paired", actor: owner, subject: `${match.name} on ${match.channel}`,
      reason: "You approved this sender, so their messages now reach the assistant", outcome: "allowed" });
    return { ...approved, channel: match.channel, senderId: match.senderId };
  }
  remove(owner: string, input: unknown) {
    const { channel, senderId } = z.object({ channel: z.string().min(1).max(64), senderId: z.string().min(1).max(64) }).strict().parse(input);
    const removed = this.store.delete("settings", owner, `channel-pair:${channel}:${senderId}`);
    if (removed) audit(this.store, owner, { action: "channel.paired", actor: owner, subject: `${senderId} on ${channel}`,
      reason: "You disconnected this sender, so their messages no longer reach the assistant", outcome: "refused" });
    return { removed };
  }
  private pair(channel: string, senderId: string): Pair | undefined {
    const parsed = pairSchema.safeParse(this.store.get("settings", this.runtime.owner, `channel-pair:${channel}:${senderId}`)?.data);
    return parsed.success ? parsed.data : undefined;
  }
  private pairs(owner: string) {
    return this.store.list("settings", owner).flatMap((record) => {
      if (!record.id.startsWith("channel-pair:")) return [];
      const parsed = pairSchema.safeParse(record.data);
      if (!parsed.success) return [];
      const [, channel, ...rest] = record.id.split(":");
      return [{ ...parsed.data, channel: channel!, senderId: rest.join(":") }];
    });
  }
}

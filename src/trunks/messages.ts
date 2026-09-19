import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import type { FollowUpCarry, Runtime } from "../runtime.js";
import type { Store } from "../store.js";
import { runOrigin, startedFromChat } from "../key-context.js";
import type { Trunk, TrunkRecords } from "./record.js";
import { isPass } from "./room-plan.js";
import { requireTrunkPart } from "./settings.js";

/**
 * R17-010 (T-10): `trunk.message`, a direct message from one Trunk to another.
 *
 * After Hermes Bot Mode's `message_agent` (hermes-agent `bot-mode.md`, "Bot-to-bot messaging", MIT):
 * - it works only in a Trunk's own conversation, never in a room or an ordinary conversation;
 * - the target is checked against the roster (its @name first, so another Trunk's title cannot
 *   take it over, and a name two Trunks share is refused with the roster);
 * - the sender is written on the message by Branch, not by the model;
 * - delivery is fire-and-forget: the message waits in the target's conversation until it is free,
 *   and the answer comes back to the sender's conversation later;
 * - a failed answer is tried once more, and only when trying again can help;
 * - every message has a receipt, so the owner can see what was sent and what came of it.
 * Branch adds a depth limit, so two Trunks cannot keep each other talking for ever.
 */
export const maxMessageDepth = 3;
/**
 * Integrator (R17-A): the depth alone bounds how long a chain gets, not how wide. One task may send
 * only a few messages, and the whole roster only so many an hour, so a fan-out cannot run up a bill.
 */
export const maxMessagesPerTask = 3;
export const maxMessagesPerHour = 30;
const depthEvent = "trunk.message.depth";
const maxReceipts = 100;
const receiptsKey = "trunk-receipts";
const transient = /time(d)? ?out|rate.?limit|\b429\b|\b5\d\d\b|overloaded|temporar|unavailable|ECONN|network|socket/i;

export interface Receipt {
  id: string;
  kind: "message" | "reply" | "failure";
  from: string;
  to: string;
  /** Where it was delivered, and the exact words, so the task that reads it can be matched. */
  sessionId: string;
  prompt: string;
  /** "waiting": the task that read it stopped to ask the owner a question (mac7/residuals); the next task in that conversation carries it on. */
  status: "queued" | "delivered" | "waiting" | "answered" | "failed";
  depth: number;
  attempts: number;
  runId: string | null;
  /**
   * The task that sent it (for the cap per task); for a reply, the task that answered. The task that
   * reads it carries that task on: its origin and no more than its tools (mac7/outside-review).
   */
  fromRunId?: string | null;
  reply: string | null;
  error: string | null;
  at: string;
  updatedAt: string;
}

export const MessageSchema = z.object({
  to: z.string().trim().min(1).max(80).describe("The other Trunk's @name, or its name"),
  message: z.string().trim().min(1).max(4000).describe("What you want to say, in your own words"),
}).strict();

export type MessageRuntime = Pick<Runtime, "followUp">;

export class TrunkMessages {
  private readonly stopListening: () => void;
  constructor(private readonly store: Store, private readonly owner: string, private readonly records: TrunkRecords,
    private readonly runtime: MessageRuntime) {
    this.stopListening = store.onEvent((runId, kind, data) => this.observe(runId, kind, data));
  }
  close(): void { this.stopListening(); }

  receipts(trunkId?: string): Receipt[] {
    const all = ((this.store.get("settings", this.owner, receiptsKey)?.data as { items?: Receipt[] } | undefined)?.items ?? []);
    return (trunkId ? all.filter((r) => r.from === trunkId || r.to === trunkId) : all).slice().reverse();
  }
  private save(items: Receipt[]): void {
    this.store.save("settings", this.owner, receiptsKey, { items: items.slice(-maxReceipts) });
  }
  private update(id: string, change: Partial<Receipt>): Receipt | undefined {
    const items = this.receipts().reverse();
    const index = items.findIndex((r) => r.id === id);
    if (index < 0) return undefined;
    items[index] = { ...items[index]!, ...change, updatedAt: new Date().toISOString() };
    this.save(items);
    return items[index];
  }

  /** The tool's work: check who is sending and to whom, write the sender on it, and queue it. */
  send(context: ToolContext, input: z.infer<typeof MessageSchema>): { queued: true; receipt: string; to: string; note: string } {
    requireTrunkPart(this.store, this.owner, "messages");
    const sender = this.senderOf(context);
    const target = this.records.resolve(input.to);
    if (target.id === sender.id) throw new Error("A Trunk cannot send a message to itself");
    const depth = this.depthOf(context.runId);
    if (depth >= maxMessageDepth)
      throw new Error(`These Trunks have already passed messages ${maxMessageDepth} deep. Answer in your own words instead of sending another.`);
    this.checkRate(context.runId);
    const prompt = `Message from ${sender.name} (@${sender.handle}):\n${input.message}`;
    const receipt = this.deliver("message", sender, target, prompt, depth + 1, context.runId);
    return { queued: true, receipt: receipt.id, to: `@${target.handle}`,
      note: `Sent. @${target.handle} will read it when it is free, and its answer will arrive in this conversation later. Do not wait for it.` };
  }
  /** Only a Trunk's own conversation may send: not a room, not an ordinary conversation. */
  private senderOf(context: ToolContext): Trunk {
    const id = context.agent?.startsWith("trunk:") ? context.agent.slice(6) : "";
    const sender = id ? this.records.find(id) : undefined;
    const run = context.runId ? this.store.run(context.runId) : undefined;
    if (!sender || !run || run.sessionId !== sender.chatSessionId)
      throw new Error("trunk.message works only in a Trunk's own conversation");
    // mac7/chat-source: a chat may be linked to a Trunk's conversation, but whoever is typing there is
    // not the owner, so they cannot set the owner's Trunks talking to each other.
    if (startedFromChat(context, this.store))
      throw new Error("A message from a chat app cannot send between the owner's Trunks. Ask the owner to do it in Branch.");
    return sender;
  }
  private checkRate(runId: string): void {
    const sent = this.receipts().filter((r) => r.kind === "message");
    if (sent.filter((r) => r.fromRunId === runId).length >= maxMessagesPerTask)
      throw new Error(`A Trunk may send at most ${maxMessagesPerTask} messages in one task. Answer with what you have.`);
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    if (sent.filter((r) => r.at >= hourAgo).length >= maxMessagesPerHour)
      throw new Error(`The Trunks have sent ${maxMessagesPerHour} messages to each other in the last hour, which is the most allowed. Answer in your own words instead.`);
  }
  /** The receipt says how deep the task that read it is; the task's own record keeps it once the receipt is gone. */
  private depthOf(runId: string): number {
    const kept = this.store.events(runId).find((event) => event.kind === depthEvent)?.data.depth;
    return this.receipts().find((r) => r.runId === runId)?.depth ?? (typeof kept === "number" ? kept : 0);
  }
  private deliver(kind: Receipt["kind"], from: Trunk, to: Trunk, prompt: string, depth: number, fromRunId: string | null = null): Receipt {
    const now = new Date().toISOString();
    const receipt: Receipt = { id: randomUUID(), kind, from: from.id, to: to.id, sessionId: to.chatSessionId, prompt, status: "queued",
      depth, attempts: 1, runId: null, fromRunId, reply: null, error: null, at: now, updatedAt: now };
    this.save([...this.receipts().reverse(), receipt]);
    this.runtime.followUp(to.chatSessionId, prompt, null, this.carryFrom(fromRunId));
    return receipt;
  }
  /**
   * mac7/outside-review: a message one Trunk queues for another starts as the task that queued it, not
   * as the owner's own. A task from outside (a schedule, another program, a chat) stays held as that,
   * and a Trunk kept to fewer tools cannot reach more through another Trunk. A task with no record of
   * its tools passes on none.
   */
  private carryFrom(runId: string | null | undefined): FollowUpCarry {
    if (!runId) return {};
    return { originFrom: runId, permissions: runOrigin(this.store, runId).permissions ?? [] };
  }

  /** Follows the task that reads each message, and sends its answer back. */
  private observe(runId: string, kind: string, data: Record<string, unknown>): void {
    if (kind !== "run.started" && kind !== "run.finished") return;
    const run = this.store.run(runId);
    if (!run) return;
    if (kind === "run.started") {
      const waiting = this.receipts().reverse().find((r) => r.status === "queued" && r.sessionId === run.sessionId && r.prompt === run.prompt)
        ?? this.receipts().find((r) => r.status === "waiting" && r.sessionId === run.sessionId && r.runId !== runId);
      if (!waiting) return;
      this.update(waiting.id, { status: "delivered", runId });
      this.store.event(runId, depthEvent, { depth: waiting.depth });
      return;
    }
    const receipt = this.receipts().find((r) => r.runId === runId && r.status === "delivered");
    if (receipt) this.finished(receipt, String(data.status ?? run.status), String(data.output ?? run.output ?? ""));
  }
  private finished(receipt: Receipt, status: string, output: string): void {
    // mac7/residuals: a task that stopped to ask the owner has not failed. It waits for a yes, and the
    // answer goes back once the next task in that conversation (the one after the owner's answer) ends.
    if (status === "needs_input") {
      this.update(receipt.id, { status: "waiting" });
      return;
    }
    if (status === "completed") {
      this.update(receipt.id, { status: "answered", reply: output.slice(0, 4000) });
      if (receipt.kind === "message" && !isPass(output)) this.answerBack(receipt, "reply", output);
      return;
    }
    if (receipt.attempts < 2 && transient.test(output)) {
      this.update(receipt.id, { status: "queued", attempts: receipt.attempts + 1, runId: null, error: output.slice(0, 500) });
      this.runtime.followUp(receipt.sessionId, receipt.prompt, null, this.carryFrom(receipt.fromRunId)); // mac7/outside-review
      return;
    }
    this.update(receipt.id, { status: "failed", error: output.slice(0, 500) });
    if (receipt.kind === "message") this.answerBack(receipt, "failure", output);
  }
  private answerBack(receipt: Receipt, kind: "reply" | "failure", output: string): void {
    const from = this.records.find(receipt.to), to = this.records.find(receipt.from);
    if (!from || !to || receipt.depth >= maxMessageDepth) return;
    const prompt = kind === "reply"
      ? `Reply from ${from.name} (@${from.handle}) to your message:\n${output.slice(0, 4000)}`
      : `Your message to @${from.handle} could not be answered: ${output.slice(0, 300)}`;
    this.deliver(kind, from, to, prompt, receipt.depth, receipt.runId); // mac7/outside-review: as the task that answered
  }
}

export function registerTrunkMessage(registry: ToolRegistry, messages: TrunkMessages): void {
  registry.register({
    name: "trunk.message", permission: "trunks.message", group: "trunks", parameters: MessageSchema,
    description: "Send a message to another of the owner's Trunks by its @name. Only in a Trunk's own conversation. The answer arrives later in this conversation; do not wait for it.",
    target: (args) => `@${args.to.replace(/^@/, "")}`,
    execute: async (args, context) => messages.send(context, args),
  });
}

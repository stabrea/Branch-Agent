import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Run } from "../contracts.js";
import type { Store } from "../store.js";
import { fingerprintOf, type Ledger } from "./ledger.js";
import { narrowed, type Runner } from "./runner.js";
import { quoteLine } from "./settings.js";
import { nextDue, StartSchema, startsAfter, startWords } from "./timing.js";

/**
 * R17-016: standing orders — a named programme the owner hands over for good, with what it may do,
 * when it starts, what needs the owner's yes first, and when to stop and ask.
 *
 * - An order is made only by the owner: either typed in Automations, or proposed by the assistant and
 *   accepted in Inbox › Needs you. The assistant can never make one directly.
 * - Each turn is a bounded task (src/autonomy/runner.ts) with at most the permissions written on the
 *   order, cut down to what the owner holds now, and the owner's approval rules still apply.
 * - The order tells the assistant to reply starting with "ESCALATE:" when one of its escalation rules
 *   applies. That reply pauses the order and puts the question in Needs you; a yes carries on.
 *
 * The anatomy (authority, trigger, approval gate, escalation, what not to do, and "try at most three
 * times, then report") is from OpenClaw's `docs/automation/standing-orders.md` (MIT). OpenClaw keeps
 * orders as Markdown the model reads; here they are records Branch enforces.
 */
export const OrderSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** What the assistant may do under this order. */
  authority: z.string().trim().min(1).max(2000),
  steps: z.string().trim().max(2000).default(""),
  /** What must wait for the owner's yes even under this order. */
  approval: z.string().trim().max(1000).default(""),
  /** When to stop and ask. */
  escalation: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  notDo: z.string().trim().max(1000).default(""),
  start: StartSchema,
  permissions: z.array(z.string().max(100)).max(50).optional(),
  perDay: z.number().int().min(1).max(24).default(4),
}).strict();
export type OrderInput = z.input<typeof OrderSchema>;
export type Order = z.infer<typeof OrderSchema>;

export interface OrderState {
  id: string;
  order: Order;
  status: "active" | "paused";
  pausedBecause: string;
  nextDueAt: string | null;
  sessionId: string | null;
  runs: number;
  lastRun: { runId: string; status: string; at: string; escalated: boolean } | null;
  createdAt: string;
}

const prefix = "autonomy-order:";
export const maxOrders = 20;
const escalate = /^\s*ESCALATE:\s*([\s\S]*)/i;

/** The words a turn of this order is started with. The order's own text is the owner's. */
export function orderPrompt(order: Order): string {
  const lines = [
    `Carry out the standing order "${quoteLine(order.name, 80)}" now.`,
    `What you may do: ${order.authority}`,
    order.steps && `Steps: ${order.steps}`,
    order.approval && `Ask the owner before: ${order.approval}`,
    order.notDo && `Do not: ${order.notDo}`,
    order.escalation.length ? `Stop and ask when any of these holds:\n${order.escalation.map((rule) => `- ${quoteLine(rule)}`).join("\n")}` : "",
    "If one of those holds, or you cannot go on, reply starting with \"ESCALATE:\" and say what you need. " +
      "Try a failing step at most three times, then report what happened; never fail silently.",
  ];
  return lines.filter(Boolean).join("\n");
}

export interface OrdersDeps {
  store: Store; owner: string; runner: Runner; ledger: Ledger;
  /** The permissions the owner holds right now. */
  held: () => string[];
  now?: () => Date;
}

export class Orders {
  constructor(private readonly deps: OrdersDeps) {}
  private get now(): Date { return (this.deps.now ?? (() => new Date()))(); }

  list(): OrderState[] {
    return this.deps.store.list("settings", this.deps.owner)
      .filter((record) => record.id.startsWith(prefix)).map((record) => record.data as unknown as OrderState);
  }
  get(id: string): OrderState {
    const found = this.deps.store.get("settings", this.deps.owner, prefix + id)?.data as OrderState | undefined;
    if (!found) throw new Error("There is no standing order with that id.");
    return found;
  }
  private save(state: OrderState): OrderState {
    this.deps.store.save("settings", this.deps.owner, prefix + state.id, { ...state });
    return state;
  }

  /** The owner's own yes: the order is made and starts on its clock. */
  create(input: unknown): OrderState {
    const order = OrderSchema.parse(input);
    if (this.list().length >= maxOrders) throw new Error(`At most ${maxOrders} standing orders.`);
    return this.save({ id: randomUUID(), order, status: "active", pausedBecause: "", nextDueAt: nextDue(order.start, this.now),
      sessionId: null, runs: 0, lastRun: null, createdAt: this.now.toISOString() });
  }

  /** The assistant's proposal: waits in Needs you, and is never made without the owner's yes. */
  propose(input: unknown): { waiting: boolean; id?: string } {
    const order = OrderSchema.parse(input);
    const entry = this.deps.ledger.ask({ kind: "order", from: "assistant", fingerprint: fingerprintOf("order", order.name.toLowerCase(), order.authority),
      title: `Standing order: ${quoteLine(order.name, 80)}`, detail: `Would run ${startWords(order.start)}: ${quoteLine(order.authority, 200)}`,
      payload: { order } });
    return entry ? { waiting: true, id: entry.id } : { waiting: false };
  }

  setPaused(id: string, paused: boolean, because = ""): OrderState {
    const state = this.get(id);
    return this.save({ ...state, status: paused ? "paused" : "active", pausedBecause: paused ? because || "Paused by you." : "",
      nextDueAt: paused ? state.nextDueAt : nextDue(state.order.start, this.now) });
  }

  remove(id: string): { removed: boolean } {
    this.get(id);
    this.deps.store.delete("settings", this.deps.owner, prefix + id);
    this.deps.ledger.withdraw((entry) => entry.payload.orderId === id);
    return { removed: true };
  }

  /** Every active order whose clock has come round. */
  async tick(): Promise<void> {
    for (const state of this.list()) {
      if (state.status !== "active" || !state.nextDueAt || state.nextDueAt > this.now.toISOString()) continue;
      this.save({ ...state, nextDueAt: nextDue(state.order.start, this.now) });
      await this.fire(state.id).catch(() => undefined);
    }
  }

  /** Orders that start when one of the owner's own tasks finishes. */
  async afterTask(prompt: string): Promise<void> {
    for (const state of this.list())
      if (state.status === "active" && startsAfter(state.order.start, prompt)) await this.fire(state.id).catch(() => undefined);
  }

  /** One turn now. The owner may press this for a manual order, or to try one. */
  async fire(id: string): Promise<{ ran: boolean; reason?: string; runId?: string }> {
    const state = this.get(id);
    if (state.status !== "active") return { ran: false, reason: state.pausedBecause || "The order is paused." };
    const outcome = await this.deps.runner.turn({
      key: `order:${id}`, prompt: orderPrompt(state.order), permissions: narrowed(state.order.permissions, this.deps.held()),
      perDay: state.order.perDay, gapMs: 5 * 60_000, ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    });
    if (!outcome.ran) return { ran: false, reason: outcome.reason };
    this.settle(id, outcome.run);
    return { ran: true, runId: outcome.run.id };
  }

  private settle(id: string, run: Run): void {
    const state = this.get(id);
    const said = escalate.exec(run.output);
    const next: OrderState = { ...state, runs: state.runs + 1, sessionId: run.sessionId,
      lastRun: { runId: run.id, status: run.status, at: this.now.toISOString(), escalated: !!said } };
    if (said) {
      Object.assign(next, { status: "paused", pausedBecause: "It stopped to ask you something (see Inbox, Needs you)." });
      this.deps.ledger.ask({ kind: "escalation", from: "order", fingerprint: fingerprintOf("escalation", id, run.id),
        title: `The standing order "${quoteLine(state.order.name, 80)}" asks you`, detail: quoteLine(said[1] ?? "", 600) || "It needs you to look.",
        payload: { orderId: id, runId: run.id, sessionId: run.sessionId } });
    }
    this.save(next);
  }

  /** What the assistant is told about the orders in the owner's own conversations. */
  summary(full: boolean): string {
    const active = this.list().filter((state) => state.status === "active");
    if (!active.length) return "";
    if (!full) return `The owner has ${active.length} standing order${active.length === 1 ? "" : "s"}; read them with orders.list when the work touches one.`;
    return `Standing orders the owner has given (each runs on its own; do not start one yourself):\n${
      active.map((state) => `- ${quoteLine(state.order.name, 80)}: ${quoteLine(state.order.authority, 200)}`).join("\n")}`;
  }
}

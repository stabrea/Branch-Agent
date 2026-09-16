import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { LockerKeySource } from "./locker.js";

/**
 * Receipts prove that a recorded tool success is the one the runtime observed. Each successful
 * tool result is hashed and signed with a key derived from the device's locker key; a result that
 * was edited afterwards, or a receipt made up without the key, fails verification.
 */
export interface Receipt { hash: string; mac: string; at: string }
export type ReceiptVerdict = { valid: true } | { valid: false; reason: string };

/** Stable serialisation so equal results always hash the same way. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const resultHash = (result: unknown): string => createHash("sha256").update(canonical(result)).digest("hex");

export class Receipts {
  private key: Promise<Buffer> | undefined;
  constructor(private readonly keys: LockerKeySource) {}
  private async signingKey(): Promise<Buffer> {
    return (this.key ??= this.keys.key().then((root) => createHmac("sha256", root).update("branch-receipts-v1").digest()));
  }
  private async mac(runId: string, toolCallId: string, name: string, hash: string, at: string): Promise<string> {
    return createHmac("sha256", await this.signingKey()).update([runId, toolCallId, name, hash, at].join("\n")).digest("hex");
  }
  async sign(runId: string, toolCallId: string, name: string, result: unknown): Promise<Receipt> {
    const hash = resultHash(result), at = new Date().toISOString();
    return { hash, mac: await this.mac(runId, toolCallId, name, hash, at), at };
  }
  /** Checks a tool.completed event's data: the result must match its hash and the hash must carry a genuine signature. */
  async verify(runId: string, data: Record<string, unknown>): Promise<ReceiptVerdict> {
    const receipt = data.receipt as Partial<Receipt> | undefined;
    if (!receipt || typeof receipt.hash !== "string" || typeof receipt.mac !== "string" || typeof receipt.at !== "string")
      return { valid: false, reason: "No receipt was recorded for this result" };
    const toolCallId = String(data.id ?? ""), name = String(data.name ?? "");
    const expected = await this.mac(runId, toolCallId, name, receipt.hash, receipt.at);
    const given = Buffer.from(receipt.mac, "hex"), wanted = Buffer.from(expected, "hex");
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return { valid: false, reason: "The receipt is not genuine" };
    if (resultHash(data.result) !== receipt.hash) return { valid: false, reason: "The result was changed after it was recorded" };
    return { valid: true };
  }
}

export type ToolOutcomeKind = "success" | "modified" | "forged" | "unsigned" | "failed" | "blocked" | "stalled";
/** Classifies one tool event for the receipts view. */
export async function classifyToolEvent(receipts: Receipts, runId: string, kind: string, data: Record<string, unknown>): Promise<ToolOutcomeKind | null> {
  if (kind === "tool.stalled") return "stalled";
  if (kind === "tool.failed") return /^Permission denied/.test(String(data.error ?? "")) ? "blocked" : "failed";
  if (kind !== "tool.completed") return null;
  const verdict = await receipts.verify(runId, data);
  if (verdict.valid) return "success";
  return /not genuine/.test(verdict.reason) ? "forged" : /changed after/.test(verdict.reason) ? "modified" : "unsigned";
}

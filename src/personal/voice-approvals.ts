import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PendingApproval } from "../approvals.js";
import type { Store } from "../store.js";
import { requirePersonal } from "./settings.js";

/**
 * R17-026: saying "yes" aloud to approve one request. The owner presses "answer aloud" beside one
 * waiting question; that makes an offer bound to that question's fingerprint (the exact bytes of the
 * request), good for two minutes and for one answer. What they then say is written out by the
 * owner's own speech settings and compared, as a whole, with a short list of plain yeses and noes in
 * English and French. Anything else — a sentence, a "yes but", silence — decides nothing and the
 * question stays where it is.
 *
 * A spoken yes is always "just this once": it never becomes a standing rule. For a risky request —
 * one the safety check advised against, a lock or door, a command, a message, money or a setting —
 * a spoken yes decides nothing on its own: the owner then presses to confirm it (integration review),
 * so a recording played near the microphone cannot settle it.
 *
 * Nothing here listens by itself. There is no wake word: the owner has not yet decided how one could
 * be built safely, so the microphone is only ever opened by the owner's own press.
 * Idea from OpenClaw's `src/talk/client-voice-confirmation.ts` (MIT); written again for Branch.
 */
export const offerLifetimeMs = 2 * 60_000;

const yeses = new Set(["yes", "yeah", "yep", "yes please", "allow", "allow it", "approve", "approved", "go ahead", "do it",
  "oui", "ouais", "d'accord", "vas-y", "vas y", "autorise", "j'autorise", "c'est bon"]);
const noes = new Set(["no", "nope", "no thanks", "deny", "refuse", "don't", "do not", "stop", "cancel",
  "non", "refuse-le", "annule", "arrête", "surtout pas"]);

/** "allow", "deny", or null when what was said is not plainly one or the other. */
export function spokenDecision(transcript: string): "allow" | "deny" | null {
  const said = transcript.toLowerCase().normalize("NFC").replace(/[’]/g, "'").replace(/[.!?,;:]+/g, " ").replace(/\s+/g, " ").trim();
  if (!said || said.split(" ").length > 4) return null;
  if (yeses.has(said)) return "allow";
  if (noes.has(said)) return "deny";
  return null;
}

interface Offer { sessionId: string; fingerprint: string; label: string; expiresAt: number; heardYes?: boolean }

export interface VoiceApprovalDeps {
  store: Store;
  owner: string;
  /** The question waiting in a conversation with this fingerprint, if it still is. */
  question: (sessionId: string, fingerprint: string) => PendingApproval | undefined;
  /** Answers it, the same way a pressed button does; refuses a fingerprint that no longer matches. */
  approve: (sessionId: string, decision: "allow" | "deny", fingerprint: string) => unknown;
  /** The owner's own speech-to-text, for a recording. */
  transcribe: (clip: { bytes: Uint8Array; mediaType: string }) => Promise<string>;
  /** Whether a yes to this question needs a press as well as the spoken word. */
  risky: (question: PendingApproval) => boolean;
  now?: () => number;
}

export const OfferSchema = z.object({ sessionId: z.string().uuid(), fingerprint: z.string().min(1).max(200) }).strict();
export const ConfirmSchema = z.object({ id: z.string().uuid() }).strict();
export const AnswerSchema = z.object({
  id: z.string().uuid(),
  transcript: z.string().max(200).optional(),
  /** A short recording, base64, when the words are to be written out here. */
  audio: z.string().max(3_000_000).optional(),
  mediaType: z.string().regex(/^audio\/[a-z0-9.+-]{1,40}(;.*)?$/).max(100).default("audio/webm"),
}).strict().refine((v) => (v.transcript === undefined) !== (v.audio === undefined), "Send either the words or a recording");

export class VoiceApprovals {
  private readonly offers = new Map<string, Offer>();
  private readonly now: () => number;
  constructor(private readonly deps: VoiceApprovalDeps) { this.now = deps.now ?? Date.now; }

  /** Binds an offer to one waiting question. */
  offer(input: unknown): { id: string; expiresAt: string; label: string } {
    requirePersonal(this.deps.store, this.deps.owner, "voice-approvals");
    const { sessionId, fingerprint } = OfferSchema.parse(input);
    const question = this.deps.question(sessionId, fingerprint);
    if (!question) throw new Error("That question is no longer waiting for an answer");
    this.sweep();
    if (this.offers.size >= 20) throw new Error("Too many spoken answers are open at once; answer or wait for them first");
    const id = randomUUID(), expiresAt = this.now() + offerLifetimeMs;
    this.offers.set(id, { sessionId, fingerprint, label: question.label, expiresAt });
    return { id, expiresAt: new Date(expiresAt).toISOString(), label: question.label };
  }

  /** Settles an offer with what was said. An unclear answer keeps the offer open. */
  async answer(input: unknown): Promise<{ decision: "allow" | "deny" | null; heard: string; message: string; confirm?: true }> {
    requirePersonal(this.deps.store, this.deps.owner, "voice-approvals");
    const value = AnswerSchema.parse(input);
    const offer = this.open(value.id);
    const heard = value.transcript ?? await this.deps.transcribe({ bytes: Buffer.from(value.audio!, "base64"), mediaType: value.mediaType });
    const decision = spokenDecision(heard);
    const said = heard.slice(0, 200);
    if (!decision) return { decision, heard: said, message: "That was not a plain yes or no, so nothing was decided. Say just yes or no." };
    if (decision === "allow" && this.needsPress(offer)) {
      offer.heardYes = true;
      return { decision: null, heard: said, confirm: true, message: `This one needs a press as well. Press "Yes, allow it" to confirm: ${offer.label}` };
    }
    return { decision, heard: said, message: this.settle(value.id, offer, decision) };
  }

  /** The press that confirms a spoken yes to a risky request; nothing without the spoken yes first. */
  confirm(input: unknown): { decision: "allow"; message: string } {
    requirePersonal(this.deps.store, this.deps.owner, "voice-approvals");
    const { id } = ConfirmSchema.parse(input);
    const offer = this.open(id);
    if (!offer.heardYes) throw new Error("Nothing was said yet. Press answer aloud and say yes first.");
    return { decision: "allow", message: this.settle(id, offer, "allow") };
  }

  private open(id: string): Offer {
    this.sweep();
    const offer = this.offers.get(id);
    if (!offer) throw new Error("That spoken answer has run out (two minutes) or was already used. Press answer aloud again.");
    return offer;
  }
  private needsPress(offer: Offer): boolean {
    const question = this.deps.question(offer.sessionId, offer.fingerprint);
    if (!question) throw new Error("That question is no longer waiting for an answer");
    return question.onceOnly === true || this.deps.risky(question);
  }
  private settle(id: string, offer: Offer, decision: "allow" | "deny"): string {
    this.offers.delete(id);
    this.deps.approve(offer.sessionId, decision, offer.fingerprint);
    return decision === "allow" ? `Allowed just this once: ${offer.label}` : `Refused: ${offer.label}`;
  }

  /** Forgets every open offer, as locking Branch does. */
  clear(): void { this.offers.clear(); }
  private sweep(): void {
    const now = this.now();
    for (const [id, offer] of this.offers) if (offer.expiresAt <= now) this.offers.delete(id);
  }
}

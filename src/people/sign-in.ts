import { randomBytes, scryptSync } from "node:crypto";
import { z } from "zod";
import type { Profiles } from "../profiles.js";
import { authorizationUrl, discover, finishSignIn, linkedTo, type GuardedFetch } from "./oidc.js";
import type { Passkeys } from "./passkeys.js";
import { chainFor, type PeopleSettings, type SignInMethodId } from "./settings.js";
import { verifyAssertion } from "./webauthn.js";

/**
 * Bucket 19: signing a person in, as a chain of checks that must all pass.
 *
 * Each way of proving who somebody is — a PIN, a passkey, an identity service — is a
 * `SignInMethod` with two stages: `begin` hands the device what it needs (a challenge, an address)
 * and `finish` checks the answer. New methods are added by registering one; none can be skipped.
 * A sign-in is a ticket: it starts with the name the person typed, collects the checks it passed,
 * and is handed a key only when every check the chain asks of that profile has passed.
 *
 * A name nobody here has still gets a ticket, which fails at every check in the same words, so the
 * page cannot be used to learn who lives here.
 */
export interface Where { origin: string; rpId: string; redirectUri: string }

export interface Ticket {
  id: string; profileId: string | null; required: SignInMethodId[]; passed: SignInMethodId[];
  failures: number; expiresAt: number; device: string;
  /** What a method keeps between its two stages (a challenge, a nonce). */
  scratch: Partial<Record<SignInMethodId, Record<string, string>>>;
}

export interface MethodHost {
  profiles: Profiles; passkeys: Passkeys; settings: () => PeopleSettings;
  fetch: GuardedFetch; secret: (name: string) => Promise<string | undefined>;
}

export interface SignInMethod {
  readonly id: SignInMethodId;
  begin(ticket: Ticket, input: Record<string, unknown>, where: Where, host: MethodHost): Promise<Record<string, unknown>>;
  /** Throws a plain reason when the answer is wrong. */
  finish(ticket: Ticket, input: Record<string, unknown>, where: Where, host: MethodHost): Promise<void>;
}

export const wrongAnswer = "That did not work. Check it and try again.";
export const maximumTicketFailures = 5;
const ticketMs = 10 * 60_000;

const pinMethod: SignInMethod = {
  id: "pin",
  async begin() { return {}; },
  async finish(ticket, input, _where, host) {
    const pin = z.string().regex(/^\d{4,8}$/).safeParse(input.pin);
    if (!ticket.profileId || !pin.success) {
      // The same work as a real check, so a missing name takes as long as a wrong PIN.
      scryptSync(String(input.pin ?? ""), "branch-no-such-person", 32);
      throw new Error("That PIN is not right");
    }
    host.profiles.verifyPin(ticket.profileId, pin.data);
  },
};

const PasskeyAnswer = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{16,1024}$/), clientDataJSON: z.string().max(4096),
  authenticatorData: z.string().max(4096), signature: z.string().max(2048),
}).strict();

const passkeyMethod: SignInMethod = {
  id: "passkey",
  async begin(ticket, _input, where, host) {
    const challenge = randomBytes(32).toString("base64url");
    ticket.scratch.passkey = { challenge };
    const allow = ticket.profileId ? host.passkeys.of(ticket.profileId).map((each) => each.credentialId) : [];
    return { challenge, rpId: where.rpId, allowCredentials: allow, userVerification: "preferred", timeout: 120000 };
  },
  async finish(ticket, input, where, host) {
    const challenge = ticket.scratch.passkey?.challenge;
    delete ticket.scratch.passkey;
    const answer = PasskeyAnswer.safeParse(input.credential);
    if (!challenge || !answer.success || !ticket.profileId) throw new Error(wrongAnswer);
    const stored = host.passkeys.of(ticket.profileId).find((each) => each.credentialId === answer.data.id);
    if (!stored) throw new Error(wrongAnswer);
    const count = verifyAssertion(answer.data, stored, { challenge, origin: where.origin, rpId: where.rpId });
    host.passkeys.used(ticket.profileId, stored.credentialId, count);
  },
};

const oidcMethod: SignInMethod = {
  id: "oidc",
  async begin(ticket, input, where, host) {
    const provider = host.settings().providers.find((each) => each.id === input.provider);
    if (!provider) throw new Error("That identity service is not set up here");
    const doc = await discover(host.fetch, provider);
    const start = authorizationUrl(provider, doc, where.redirectUri);
    ticket.scratch.oidc = { provider: provider.id, state: start.state, nonce: start.nonce, verifier: start.verifier };
    return { url: start.url, state: start.state };
  },
  async finish(ticket, input, where, host) {
    const scratch = ticket.scratch.oidc;
    delete ticket.scratch.oidc;
    const settings = host.settings();
    const provider = settings.providers.find((each) => each.id === scratch?.provider);
    if (!scratch || !provider || typeof input.code !== "string" || !ticket.profileId) throw new Error(wrongAnswer);
    const doc = await discover(host.fetch, provider);
    const clientSecret = provider.clientSecretName ? await host.secret(provider.clientSecretName) : undefined;
    const identity = await finishSignIn(host.fetch, provider, doc, {
      code: input.code.slice(0, 2048), redirectUri: where.redirectUri, verifier: scratch.verifier!, nonce: scratch.nonce!,
      ...(clientSecret ? { clientSecret } : {}),
    });
    if (!linkedTo(settings.links, provider.id, ticket.profileId, identity))
      throw new Error("That account is not linked to this person here. The owner can link it in Settings.");
  },
};

export class SignIns {
  private readonly methods = new Map<SignInMethodId, SignInMethod>();
  private readonly tickets = new Map<string, Ticket>();
  now: () => number = () => Date.now();
  constructor(private readonly host: MethodHost) {
    for (const method of [pinMethod, passkeyMethod, oidcMethod]) this.register(method);
  }
  /** Adds a way of proving who somebody is. It still has to be named in the chain to be asked. */
  register(method: SignInMethod): void { this.methods.set(method.id, method); }

  start(name: string, device: string): { ticket: string; steps: SignInMethodId[] } {
    this.prune();
    const profile = this.host.profiles.byName(name);
    const settings = this.host.settings();
    const required = profile ? chainFor(settings, profile.id) : [...settings.chain];
    const ticket: Ticket = { id: randomBytes(24).toString("base64url"), profileId: profile?.id ?? null, required, passed: [],
      failures: 0, expiresAt: this.now() + ticketMs, device: device.slice(0, 120), scratch: {} };
    this.tickets.set(ticket.id, ticket);
    return { ticket: ticket.id, steps: required };
  }

  /** The ticket an OpenID Connect answer belongs to, found by the state it carried. */
  byState(state: string): string | null {
    for (const ticket of this.tickets.values()) if (ticket.scratch.oidc?.state === state) return ticket.id;
    return null;
  }

  async step(ticketId: string, method: SignInMethodId, stage: "begin" | "finish", input: Record<string, unknown>, where: Where):
    Promise<{ result: Record<string, unknown>; left: SignInMethodId[] }> {
    const ticket = this.open(ticketId);
    const handler = this.methods.get(method);
    if (!handler || !ticket.required.includes(method)) throw new Error("That check is not part of signing in here");
    if (stage === "begin") return { result: await handler.begin(ticket, input, where, this.host), left: this.left(ticket) };
    try {
      await handler.finish(ticket, input, where, this.host);
    } catch (error) {
      ticket.failures += 1;
      if (ticket.failures >= maximumTicketFailures) this.tickets.delete(ticket.id);
      throw error;
    }
    if (!ticket.passed.includes(method)) ticket.passed.push(method);
    return { result: { passed: method }, left: this.left(ticket) };
  }

  /** Ends a ticket whose every check passed: the profile it proved, and how. Otherwise throws. */
  complete(ticketId: string): { profileId: string; method: string; device: string } {
    const ticket = this.open(ticketId);
    // A chain the owner tightened while this sign-in was going applies to it too.
    if (ticket.profileId)
      for (const method of chainFor(this.host.settings(), ticket.profileId))
        if (!ticket.required.includes(method)) ticket.required.push(method);
    if (this.left(ticket).length || !ticket.profileId) throw new Error("Not every check has passed yet");
    this.tickets.delete(ticket.id);
    return { profileId: ticket.profileId, method: ticket.passed.join("+"), device: ticket.device };
  }

  private left(ticket: Ticket): SignInMethodId[] {
    return ticket.required.filter((method) => !ticket.passed.includes(method));
  }
  private open(ticketId: string): Ticket {
    const ticket = this.tickets.get(String(ticketId));
    if (!ticket || ticket.expiresAt <= this.now()) throw new Error("That sign-in has run out. Start again.");
    return ticket;
  }
  private prune(): void {
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= this.now()) this.tickets.delete(id);
    if (this.tickets.size > 500) this.tickets.delete(this.tickets.keys().next().value!);
  }
}

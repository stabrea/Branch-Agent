import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { audit } from "../audit.js";
import type { Store } from "../store.js";

/**
 * Batch 20 (wave 8): what a phone has to satisfy before the extra door lets it in.
 *
 * Branch already had three separate answers to "who is this": the local key, the pairing code, and
 * whichever chat app had approved the sender. For the door that faces the private network the owner
 * should be able to say "the key AND this exact phone", not pick one. So the checks are written as
 * a chain of named steps and every step in it must pass. Adding a step can only make the door
 * harder to open, never easier, which is the property that makes a chain safe to configure.
 *
 * The steps:
 *   - `token`   the same local key the window on this computer uses. Already checked before this
 *               runs; it is in the chain so the list reads as the whole truth.
 *   - `pairing` at least one phone has been let in on this computer. It is a switch, not a check on
 *               who is calling; the step that tells one phone from another is `device`.
 *   - `device`  the phone must send back the secret it was given when it paired, so a key copied
 *               off one phone is no use on another.
 *
 * Signing in through somebody else's identity service (OIDC, a social login) is deliberately not
 * one of the steps: there is one owner, the door faces their own private network, and adding an
 * outside company to the path a phone takes to reach this computer would make it less private,
 * not more. See docs/configuration.md.
 */
export const gatewaySteps = ["token", "pairing", "device"] as const;
export type GatewayStep = (typeof gatewaySteps)[number];

export const GatewayAuthSchema = z.object({
  /** Every step named here must pass. An empty chain means the local key alone, as before. */
  chain: z.array(z.enum(gatewaySteps)).max(3).default(["token", "pairing"]),
}).strict();
export type GatewayAuthSettings = z.infer<typeof GatewayAuthSchema>;
const settingsKey = "remote-gateway-auth";
const devicesKey = "remote-devices";

export function readGatewayAuth(store: Store, owner: string): GatewayAuthSettings {
  const saved = GatewayAuthSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : GatewayAuthSchema.parse({});
}
export function saveGatewayAuth(store: Store, owner: string, input: unknown): GatewayAuthSettings {
  const next = GatewayAuthSchema.parse(input ?? {});
  store.save("settings", owner, settingsKey, next);
  audit(store, owner, {
    action: "policy.changed", actor: owner, subject: "what a phone must satisfy to reach Branch",
    reason: next.chain.length ? next.chain.join(", then ") : "the local key alone", outcome: "saved",
  });
  return next;
}

export const DeviceSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{16}$/),
  name: z.string().trim().min(1).max(80),
  /** The secret's fingerprint. The secret itself is shown once, on the computer, and never kept. */
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  pairedAt: z.string().max(40),
}).strict();
export type Device = z.infer<typeof DeviceSchema>;
const DevicesSchema = z.object({ devices: z.array(DeviceSchema).max(20).default([]) }).strict();

export function knownDevices(store: Store, owner: string): Device[] {
  const saved = DevicesSchema.safeParse(store.get("settings", owner, devicesKey)?.data ?? {});
  return saved.success ? saved.data.devices : [];
}

/** The headers a phone sends back on every request once it has paired. */
export const deviceHeader = "x-branch-device";
export const deviceSecretHeader = "x-branch-device-key";
const fingerprintOf = (secret: string): string => createHash("sha256").update(secret).digest("hex");
const sameText = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class GatewayAuth {
  constructor(private readonly store: Store, private readonly owner: string) {}
  settings(): GatewayAuthSettings { return readGatewayAuth(this.store, this.owner); }
  devices(): Device[] { return knownDevices(this.store, this.owner); }

  /**
   * Writes one phone down at the moment it accepts an invitation, and hands back the secret it must
   * send from then on. The secret exists once, here; only its fingerprint is kept.
   */
  remember(name: string): { device: Device; secret: string } {
    const secret = randomBytes(24).toString("hex");
    const device: Device = {
      id: randomBytes(8).toString("hex"), name: name.slice(0, 80) || "A phone",
      fingerprint: fingerprintOf(secret), pairedAt: new Date().toISOString(),
    };
    const kept = [...this.devices().filter((each) => each.name !== device.name), device].slice(-20);
    this.store.save("settings", this.owner, devicesKey, { devices: kept });
    audit(this.store, this.owner, {
      action: "channel.paired", actor: this.owner, subject: device.name,
      reason: "A phone was let in, and given a secret of its own to send back each time", outcome: "paired",
    });
    return { device, secret };
  }

  /** Takes one phone back off the list; it cannot reach Branch again without a new invitation. */
  forget(id: string): boolean {
    const kept = this.devices().filter((each) => each.id !== id);
    if (kept.length === this.devices().length) return false;
    this.store.save("settings", this.owner, devicesKey, { devices: kept });
    audit(this.store, this.owner, {
      action: "channel.paired", actor: this.owner, subject: id,
      reason: "A phone was taken off the list of phones that may reach Branch", outcome: "removed",
    });
    return true;
  }

  /**
   * Runs the chain. Answers the plain reason the first step refused, or null when every step
   * passed. `tokenOk` is what the ordinary key check already decided, passed in rather than redone.
   */
  check(request: Pick<IncomingMessage, "headers">, tokenOk: boolean): string | null {
    for (const step of this.settings().chain) {
      const refusal = this.step(step, request, tokenOk);
      if (refusal) return refusal;
    }
    return null;
  }

  private step(step: GatewayStep, request: Pick<IncomingMessage, "headers">, tokenOk: boolean): string | null {
    if (step === "token")
      return tokenOk ? null : "This phone does not have the key for this computer. Accept a fresh invitation on the computer.";
    if (step === "pairing")
      // A switch, deliberately: it says an invitation has been accepted at all. Telling this phone
      // from another one is the `device` step below, which is the one to add for that.
      return this.devices().length ? null : "No phone has been let in yet. Make an invitation on the computer and accept it.";
    const id = String(request.headers[deviceHeader] ?? "");
    const secret = String(request.headers[deviceSecretHeader] ?? "");
    const device = this.devices().find((each) => each.id === id);
    if (!device || !secret || !sameText(fingerprintOf(secret), device.fingerprint))
      return "This phone is not the one that was let in. Accept a fresh invitation on the computer.";
    return null;
  }
}

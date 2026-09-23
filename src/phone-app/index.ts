import { join } from "node:path";
import { z } from "zod";
import { qrRows } from "../deployment-api.js";
import { lockdownActive } from "../lockdown.js";
import type { Store } from "../store.js";
import { candidateAddresses, filterTailnetAddresses, type Runner, runQuietly } from "./address.js";
import { assertDoorAddress, PhoneDoor, type DoorView } from "./door.js";
import { appRoot, damagedReason, findPhoneApp, readCheckedApp } from "./file.js";
import { loadDictionaries } from "./page.js";
import { probeTailscale, type ProbeTailscale } from "../remote/tailscale.js";

/**
 * mac7/phone-qr: "Get Branch on your phone" — the card in the window and `branch phone`.
 *
 * The owner presses Show the code; Branch opens the download door (src/phone-app/door.ts) on this
 * computer's home network address for fifteen minutes and shows a code for the phone's ordinary
 * camera. Scanning it opens the install page on this computer. Nothing is published anywhere: the
 * app comes from inside this Branch (src/phone-app/file.ts). Updating the phone is scanning again.
 */
export const phoneLockdownRefusal =
  "Lockdown is on, so the phone download cannot be opened. Turn Lockdown off in Settings first.";
export const noAddressRefusal =
  "This computer is not on a home network or Tailscale, so a phone has nowhere to reach it. Connect to your Wi-Fi and try again.";
export const pickedAddressRefusal = "That address is not one this computer can offer a phone.";

export interface PhoneAppDeps {
  root?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: Runner;
  /** The addresses the door may use, best first; read from this computer when left out. */
  addresses?: () => Promise<string[]>;
  tailscale?: ProbeTailscale;
  now?: () => number;
}

export const ShareSchema = z.object({
  address: z.string().max(64).optional(),
  minutes: z.number().int().min(1).max(60).optional(),
}).strict();

export class PhoneApp {
  readonly door: PhoneDoor;
  private stopGeneration = 0;
  constructor(private readonly deps: PhoneAppDeps = {}) { this.door = new PhoneDoor(deps.now); }
  private root(): string { return this.deps.root ?? appRoot(); }
  /** Only a 100.64 address Tailscale reports as this computer's own counts, whichever way the list was read. */
  async addresses(): Promise<string[]> {
    const found = await (this.deps.addresses?.() ?? candidateAddresses(this.deps.platform ?? process.platform, this.deps.run ?? runQuietly));
    return filterTailnetAddresses(found, this.deps.tailscale);
  }
  /** What the card shows: whether the app is here, where it can be offered, and the live code. */
  async overview(): Promise<Record<string, unknown>> {
    const found = await findPhoneApp(this.root(), this.deps.env);
    return {
      available: found.file !== null, size: found.file?.size ?? null, reason: found.reason,
      addresses: await this.addresses(), share: shareView(this.door.view()),
    };
  }
  /** Opens (or replaces) the download link, on the address asked for or the best one. */
  async share(input: unknown, deps?: { store: Pick<Store, "get">; owner: string }): Promise<DoorView> {
    const asked = ShareSchema.parse(input ?? {});
    const startGeneration = this.stopGeneration;
    const found = await findPhoneApp(this.root(), this.deps.env);
    if (!found.file) throw new PhoneAppRefusal(409, found.reason);
    if (startGeneration !== this.stopGeneration) throw new PhoneAppRefusal(409, "Share was cancelled");
    if (deps && lockdownActive(deps.store, deps.owner)) throw new PhoneAppRefusal(403, phoneLockdownRefusal);
    const bytes = await readCheckedApp(found.file);
    if (!bytes) throw new PhoneAppRefusal(409, damagedReason);
    if (startGeneration !== this.stopGeneration) throw new PhoneAppRefusal(409, "Share was cancelled");
    if (deps && lockdownActive(deps.store, deps.owner)) throw new PhoneAppRefusal(403, phoneLockdownRefusal);
    const addresses = await this.addresses();
    if (asked.address && !addresses.includes(asked.address)) throw new PhoneAppRefusal(400, pickedAddressRefusal);
    const address = asked.address ?? addresses[0];
    if (!address) throw new PhoneAppRefusal(409, noAddressRefusal);
    if (startGeneration !== this.stopGeneration) throw new PhoneAppRefusal(409, "Share was cancelled");
    if (deps && lockdownActive(deps.store, deps.owner)) throw new PhoneAppRefusal(403, phoneLockdownRefusal);
    const dictionaries = await loadDictionaries(join(this.root(), "public", "locales"));
    if (startGeneration !== this.stopGeneration) throw new PhoneAppRefusal(409, "Share was cancelled");
    if (deps && lockdownActive(deps.store, deps.owner)) throw new PhoneAppRefusal(403, phoneLockdownRefusal);
    // Tailscale is asked again for the door, once: it may have stopped since the list was read, and
    // the door's own check takes that same answer, so it cannot refuse later without saying why.
    const real = this.deps.tailscale ?? probeTailscale;
    let answer: ReturnType<ProbeTailscale> | undefined;
    const tailscale: ProbeTailscale = () => (answer ??= real());
    try { await assertDoorAddress(address, tailscale); } catch { throw new PhoneAppRefusal(409, noAddressRefusal); }
    if (startGeneration !== this.stopGeneration) throw new PhoneAppRefusal(409, "Share was cancelled");
    if (deps && lockdownActive(deps.store, deps.owner)) throw new PhoneAppRefusal(403, phoneLockdownRefusal);
    return this.door.start({ file: found.file, bytes, address, dictionaries, ...(asked.minutes ? { lifetimeMs: asked.minutes * 60_000 } : {}), tailscale });
  }
  stop(): void { this.stopGeneration++; this.door.stop(); }
}

export class PhoneAppRefusal extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function shareView(view: DoorView | null): Record<string, unknown> | null {
  return view && { url: view.url, address: view.address, expiresAt: view.expiresAt, qr: qrRows(view.qr) };
}

export const handlesPhoneAppPath = (path: string): boolean => path === "/api/phone-app" || path.startsWith("/api/phone-app/");

/** The card's routes, the owner's alone (the server checks the profile and short-lived keys first). */
export async function phoneAppApi(
  phone: PhoneApp, deps: { store: Pick<Store, "get">; owner: string; method: string; readBody: () => Promise<unknown> }, path: string,
): Promise<unknown> {
  if (path === "/api/phone-app" && deps.method === "GET") return phone.overview();
  if (deps.method !== "POST") throw new PhoneAppRefusal(405, "Use GET or POST here.");
  if (path === "/api/phone-app/stop") { phone.stop(); return { share: null }; }
  if (path !== "/api/phone-app/share") throw new PhoneAppRefusal(404, "Endpoint not found");
  if (lockdownActive(deps.store, deps.owner)) throw new PhoneAppRefusal(403, phoneLockdownRefusal);
  return { share: shareView(await phone.share(await deps.readBody(), { store: deps.store, owner: deps.owner })) };
}

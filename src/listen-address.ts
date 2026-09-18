import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { z } from "zod";
import { audit } from "./audit.js";
import { runOrigin, startedFromChat, startedWithShortLivedKey } from "./key-context.js";
import { lockdownActive } from "./lockdown.js";
import { isPrivateAddress } from "./network-policy.js";
import { currentPerson } from "./people/context.js";
import { isTailnetAddress } from "./remote/tailscale.js";
import type { Store } from "./store.js";

/**
 * mac7/bind: which address Branch's own door listens on.
 *
 * Branch has always listened on 127.0.0.1 and nothing else, so the window, a script and the
 * assistant all had to be on this very computer. That is the right default and it does not change
 * here: a person who upgrades sees exactly what they saw before. But inside a container 127.0.0.1
 * is the container's own loopback, so a published port reaches nothing at all, and the only way in
 * was to hand the container the host's whole network — which puts Branch's door straight onto the
 * host's loopback, which is not what running a container is for.
 *
 * So there is one setting, off at first, that says where the door is:
 *
 *   this-computer    127.0.0.1, as before and as at first.
 *   private-network  every address this computer answers on, so a published port or another
 *                    machine on the same private network can reach it.
 *
 * Listening beyond this computer is a security decision, so it is treated as one. The setting alone
 * is not enough: `decideListen` refuses to open the door and says why, in plain words, when
 * Lockdown is on, when this computer answers on an address that is not private (a server with a
 * public address would be putting Branch on the internet), or when there is no local key for the
 * door to ask callers for. A refusal always lands on 127.0.0.1 — the safe answer is the one Branch
 * falls back to, never the wide one.
 *
 * "Private" here is the network rules' own idea of a private address (src/network-policy.ts),
 * plus a Tailscale address, which Branch already treats as private for the paired door
 * (src/remote/tailscale.ts). Nothing new was invented for this.
 */

export const listenKey = "listen-address";

/** The two places the door can be. Written most careful first, as every choice list here is. */
export const listenPlaces = ["this-computer", "private-network"] as const;
export type ListenPlace = (typeof listenPlaces)[number];

export const ListenSettingsSchema = z.object({
  /**
   * Where the door is. Deliberately a choice of two and not an address to type: a settings file or
   * a whole-app preset can be brought in from anywhere, and nothing brought in that way may ever
   * name the address this computer listens on. The same line `wake-word` draws around the word it
   * listens for.
   */
  where: z.enum(listenPlaces).default("this-computer"),
}).strict();
export type ListenSettings = z.infer<typeof ListenSettingsSchema>;

/** This computer's own loopback address: where Branch listens unless it is told otherwise. */
export const thisComputerAddress = "127.0.0.1";
/** Every address this computer answers on. */
export const everyAddress = "0.0.0.0";

const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** Whether a caller is on this very computer, whatever address the door is listening on. */
export function fromThisComputer(remoteAddress: string | undefined): boolean {
  const from = (remoteAddress ?? "").toLowerCase();
  return loopbackAddresses.has(from) || from.startsWith("127.") || from.startsWith("::ffff:127.");
}

/**
 * The setting as it stands. While Lockdown is on the answer is "this computer", whatever was saved,
 * the same way every other covered switch reads as off (src/lockdown.ts).
 */
export function listenSettings(store: Pick<Store, "get">, owner: string): ListenSettings {
  const saved = ListenSettingsSchema.safeParse(store.get("settings", owner, listenKey)?.data ?? {});
  const settings = saved.success ? saved.data : ListenSettingsSchema.parse({});
  return lockdownActive(store, owner) ? { where: "this-computer" } : settings;
}

/**
 * The name a container is told with, because a container has no window to turn the setting on in.
 * It is deliberately not one of the gateway's `workerEnvNames`: a change to the gateway's settings
 * must never be able to open this door. It asks for the wider address and nothing more — every
 * refusal in `decideListen` is still asked, so it can no more get past Lockdown or a public address
 * than the saved setting can.
 */
export const listenEnvName = "BRANCH_LISTEN";

/** What has been asked for: the saved setting, or the container's own name for it. */
export function listenAsked(
  store: Pick<Store, "get">, owner: string, env: NodeJS.ProcessEnv = process.env,
): ListenPlace {
  const asked = ListenSettingsSchema.safeParse({ where: env[listenEnvName] });
  return listenSettings(store, owner).where === "private-network" || asked.data?.where === "private-network"
    ? "private-network" : "this-computer";
}

export function saveListenSettings(store: Store, owner: string, input: unknown): ListenSettings {
  const next = ListenSettingsSchema.parse(input ?? {});
  store.save("settings", owner, listenKey, next);
  audit(store, owner, {
    action: "policy.changed", actor: owner, subject: "where Branch listens",
    reason: next.where === "private-network" ? "every address on the private network" : "this computer only",
    outcome: "saved",
  });
  return next;
}

/* ---------- who may change it ---------- */

export const listenKeyRefusal =
  "A short-lived key cannot change where Branch listens. Do that in the app window.";
export const listenChatRefusal =
  "A message from a chat app cannot change where Branch listens. Do that in the app window.";
export const listenAgentRefusal =
  "Work another assistant or program started cannot change where Branch listens. The owner can, in the app window.";
export const listenPersonRefusal =
  "Where Branch listens belongs to the owner. Switch back to the owner's profile to change it.";
export const listenLockdownRefusal =
  "Lockdown is on, so where Branch listens cannot be changed. Turn Lockdown off in Settings first.";

/**
 * Why this change to where Branch listens is refused, or null. The same line src/reach/tools.ts and
 * src/personal/guard.ts draw: a household profile, a signed-in person, a short-lived key (which is
 * also how a Trunk's message from another computer arrives), a chat message's task and work another
 * assistant or program started are all refused before anything is written. Lockdown is refused too,
 * because opening the door wider is exactly the kind of reaching Lockdown exists to stop.
 */
export function listenChangeRefusal(
  store: Store, owner: string, context: { source?: string | undefined; runId?: string | undefined } = {},
): string | null {
  store.profiles.requireOwner("Where Branch listens");
  if (lockdownActive(store, owner)) return listenLockdownRefusal;
  const origin = context.runId && store.run(context.runId) ? runOrigin(store, context.runId) : null;
  if (startedWithShortLivedKey() || origin?.shortLivedKey) return listenKeyRefusal;
  if (currentPerson() || origin?.personProfileId || origin?.lentTo) return listenPersonRefusal;
  if (startedFromChat(context, store)) return listenChatRefusal;
  if (["mcp", "a2a", "acp"].includes(context.source ?? origin?.source ?? "owner")) return listenAgentRefusal;
  return null;
}

/* ---------- where the door ends up ---------- */

/** One address this computer answers on, as `node:os` describes it. */
export interface OwnAddress { address: string; internal: boolean }

export interface ListenDecision {
  /** What `server.listen` is given. */
  address: string;
  /**
   * Names and addresses a request may say it was sent to, beyond this computer's own loopback.
   * They carry no port on purpose: a container publishes Branch on whatever port the host chose,
   * and Branch inside it cannot know which. The port was never the thing keeping anyone out — the
   * local key is — and the name is what stops a page elsewhere pointing its own address here.
   */
  extraHosts: string[];
  /** Whether Branch really is reachable from beyond this computer. */
  beyond: boolean;
  /** Why a wider door was refused, in plain words, or null when nothing was refused. */
  refusal: string | null;
}

/** Every address this computer answers on, as `decideListen` wants them. */
export function ownAddresses(): OwnAddress[] {
  return Object.values(networkInterfaces()).flat()
    .filter((entry): entry is NonNullable<typeof entry> => !!entry)
    .map((entry) => ({ address: entry.address.replace(/%.*$/, ""), internal: entry.internal }));
}

/** Private the way the network rules mean it, or a Tailscale address, which Branch already calls private. */
const privateHere = (address: string): boolean =>
  isIP(address) !== 0 && (isPrivateAddress(address) || isTailnetAddress(address));

/** An address is written into a Host header with brackets when it is IPv6. */
const asHost = (address: string): string => (isIP(address) === 6 ? `[${address}]` : address);

/**
 * Where the door goes, and why. The safe answer — 127.0.0.1, this computer only — is what every
 * refusal falls back to, so a mistake anywhere here leaves Branch exactly as it has always been.
 */
export function decideListen(input: {
  where: ListenPlace;
  lockdown: boolean;
  /** The local key the door asks every caller for. */
  token: string;
  addresses: readonly OwnAddress[];
}): ListenDecision {
  const stay = (refusal: string | null): ListenDecision =>
    ({ address: thisComputerAddress, extraHosts: [], beyond: false, refusal });
  if (input.where === "this-computer") return stay(null);
  if (input.lockdown)
    return stay("Lockdown is on, so Branch is listening on this computer only.");
  // The whole door rests on this one key. Without it a wider address would be Branch with no
  // credential at all on a network, so it is refused rather than obeyed.
  if (!/^[a-f0-9]{64}$/.test(input.token))
    return stay("Branch has no local key to ask callers for, so it is listening on this computer only.");
  const outward = input.addresses.filter((entry) => !entry.internal);
  const open = outward.filter((entry) => !privateHere(entry.address));
  if (open.length)
    return stay(`This computer answers on ${open[0]!.address}, which is not a private address, so Branch is`
      + " listening on this computer only. Branch listens beyond this computer on a private network and nowhere else.");
  return {
    address: everyAddress, beyond: true, refusal: null,
    // "localhost" is here because a container's published port is reached by that name as often as
    // by 127.0.0.1, and both mean this same door.
    extraHosts: ["localhost", thisComputerAddress, "[::1]", ...outward.map((entry) => asHost(entry.address))],
  };
}

/** What the owner's screen and `GET /api/listen` are told. */
export function listenView(store: Pick<Store, "get">, owner: string, decision: ListenDecision): Record<string, unknown> {
  return {
    where: listenAsked(store, owner),
    saved: ListenSettingsSchema.safeParse(store.get("settings", owner, listenKey)?.data ?? {}).data?.where ?? "this-computer",
    places: listenPlaces,
    lockdown: lockdownActive(store, owner),
    listeningOn: decision.address,
    beyondThisComputer: decision.beyond,
    refusal: decision.refusal,
  };
}

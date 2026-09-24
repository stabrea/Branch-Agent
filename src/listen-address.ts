import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { z } from "zod";
import { audit } from "./audit.js";
import { tunnelMark } from "./auth-limits.js";
import { runOrigin, startedFromChat, startedWithShortLivedKey } from "./key-context.js";
import { lockdownActive } from "./lockdown.js";
import { currentPerson } from "./people/context.js";
import { isTailnetAddress, probeTailscale, type ProbeTailscale } from "./remote/tailscale.js";
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
 * falls back to, never the wide one. An IPv6 address that is not private is the one thing found that
 * does not refuse: the wider door is the IPv4 wildcard, which a connection over IPv6 never reaches, so
 * beside a private IPv4 network the door opens on private IPv4 networks only, and says so.
 *
 * "Private" here is stricter than the network rules' idea of a private address (src/network-policy.ts).
 * Those rules refuse to REACH an address, so they count an IPv6 address as private when the IPv4
 * address it carries is, and multicast and site-local besides. Opening a door is the other direction:
 * a 6to4, Teredo, NAT64 or IPv4-compatible address routes across the internet whatever it carries, so
 * `isLanListenAddress` accepts only an address a private network really hands out, plus the address
 * Tailscale itself reports as this computer's (src/remote/tailscale.ts). Tailscale's addresses come
 * from 100.64.0.0/10, which is shared address space other networks hand out too, so being in that
 * range is not enough on its own.
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
/**
 * Whether a caller is on this very computer, whatever address the door is listening on.
 *
 * Integration review: the webhook door (src/personal/tunnel.ts) dials 127.0.0.1, so a request it
 * passes on from the internet arrives wearing a loopback address. Today it only ever passes on
 * webhook and trigger paths, so nothing guarded by this function is reachable that way — but that
 * is a promise kept in another file, and this one must not depend on it. The mark the door always
 * sets, and always strips from a caller, is read here too, so widening what the door forwards can
 * never quietly turn the internet into "this computer".
 */
export function fromThisComputer(
  remoteAddress: string | undefined, headers: Record<string, unknown> = {},
): boolean {
  if (headers[tunnelMark] !== undefined) return false;
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
  "A short-lived key cannot read or change where Branch listens. Do that in the app window.";
export const listenChatRefusal =
  "A message from a chat app cannot read or change where Branch listens. Do that in the app window.";
export const listenAgentRefusal =
  "Work another assistant or program started cannot read or change where Branch listens. The owner can, in the app window.";
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
export interface ListenCaller { source?: string | undefined; runId?: string | undefined }

/** Everyone who is not the owner sitting at the app window, whether they are looking or moving it. */
function notTheOwner(store: Store, context: ListenCaller): string | null {
  const origin = context.runId && store.run(context.runId) ? runOrigin(store, context.runId) : null;
  if (startedWithShortLivedKey() || origin?.shortLivedKey) return listenKeyRefusal;
  if (currentPerson() || origin?.personProfileId || origin?.lentTo) return listenPersonRefusal;
  if (startedFromChat(context, store)) return listenChatRefusal;
  if (["mcp", "a2a", "acp"].includes(context.source ?? origin?.source ?? "owner")) return listenAgentRefusal;
  return null;
}

/**
 * Why this caller may not even be told where Branch listens, or null.
 *
 * Integration review: the same line as changing it, and for the same reason. Where the door is is
 * where to knock: telling a household person, a chat message's task, a Trunk on another computer or
 * another assistant's program that Branch answers on the private network hands them the one fact
 * the wider door was careful about. Lockdown is deliberately NOT a refusal here — the owner's own
 * card has to be able to say "Lockdown is on, so Branch is listening on this computer only", and a
 * blank card exactly then would be the worst moment to go quiet.
 */
export function listenReadRefusal(store: Store, owner: string, context: ListenCaller = {}): string | null {
  store.profiles.requireOwner("Where Branch listens");
  void owner;
  return notTheOwner(store, context);
}

export function listenChangeRefusal(
  store: Store, owner: string, context: ListenCaller = {},
): string | null {
  store.profiles.requireOwner("Where Branch listens");
  if (lockdownActive(store, owner)) return listenLockdownRefusal;
  return notTheOwner(store, context);
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
  /**
   * When the wider door is open on private IPv4 networks only, because this computer also answers
   * on an IPv6 address that is not private: that, in plain words. Null otherwise.
   */
  ipv4Only: string | null;
}

/** Every address this computer answers on, as `decideListen` wants them. */
export function ownAddresses(): OwnAddress[] {
  return Object.values(networkInterfaces()).flat()
    .filter((entry): entry is NonNullable<typeof entry> => !!entry)
    .map((entry) => ({ address: entry.address.replace(/%.*$/, ""), internal: entry.internal }));
}

/**
 * IPv4 addresses on this computer's own network: private (RFC 1918), link-local, and this computer's
 * own loopback, which every version before this allowed. The shared range Tailscale hands out is not
 * here: an address in it counts only when Tailscale reports it (see `isLanListenAddress`).
 */
const lanV4 = new BlockList();
for (const [base, bits] of [
  ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["169.254.0.0", 16], ["127.0.0.0", 8],
] as const) lanV4.addSubnet(base, bits, "ipv4");

/** IPv6 addresses on this computer's own network: unique local, link-local and loopback. */
const lanV6 = new BlockList();
for (const [base, bits] of [["fc00::", 7], ["fe80::", 10], ["::1", 128]] as const) lanV6.addSubnet(base, bits, "ipv6");

/**
 * Whether the door may open on this address. Only a real address on the private network passes, and
 * an IPv4-mapped (::ffff:) spelling of one. Multicast, site-local, 6to4, Teredo, NAT64, translated and
 * IPv4-compatible addresses do not, whatever IPv4 address they carry.
 *
 * An address in Tailscale's range passes only when it is one of `tailnet`, the addresses Tailscale
 * itself reports as this computer's, and never in its IPv6 spelling, which Tailscale does not report.
 */
export function isLanListenAddress(address: string, tailnet: readonly string[] = []): boolean {
  const bare = address.replace(/%.*$/, "");
  const kind = isIP(bare);
  if (kind === 4) return lanV4.check(bare, "ipv4") || (isTailnetAddress(bare) && tailnet.includes(bare));
  if (kind !== 6) return false;
  // node:net matches an IPv4 rule against the ::ffff:0:0/96 spelling of that IPv4 address, and only that one.
  return lanV6.check(bare, "ipv6") || lanV4.check(bare, "ipv6");
}

/** An address is written into a Host header with brackets when it is IPv6. */
const asHost = (address: string): string => (isIP(address) === 6 ? `[${address}]` : address);

/** Every IPv4 address, to tell the IPv4-mapped (::ffff:) spelling of one from a real IPv6 address. */
const anyV4 = new BlockList();
anyV4.addSubnet("0.0.0.0", 0, "ipv4");

/**
 * Whether a connection reaches this address over IPv6 only: an IPv6 address that is not the mapped
 * spelling of an IPv4 one. The wider door is the IPv4 wildcard, which such a connection never
 * reaches (tests/listen-door-ipv4-only.test.mjs checks that with real sockets).
 */
function reachedOverIPv6Only(address: string): boolean {
  const bare = address.replace(/%.*$/, "");
  return isIP(bare) === 6 && !anyV4.check(bare, "ipv6");
}

/**
 * The wider door, answering to the names of `reached`. `leftOut` is an IPv6 address that is not
 * private, when there is one: the door then opens on private IPv4 networks only, and says so.
 */
function wideDoor(reached: readonly OwnAddress[], leftOut: string | null): ListenDecision {
  return {
    address: everyAddress, beyond: true, refusal: null,
    ipv4Only: leftOut === null ? null : `This computer also answers on ${leftOut}, which is not a private`
      + " address, so Branch listens on private IPv4 networks only.",
    // "localhost" is here because a container's published port is reached by that name as often as
    // by 127.0.0.1, and both mean this same door.
    extraHosts: ["localhost", thisComputerAddress, "[::1]", ...reached.map((entry) => asHost(entry.address))],
  };
}

/** Why an address this computer answers on keeps the door on this computer. */
function notPrivate(address: string): string {
  if (isTailnetAddress(address))
    return `This computer answers on ${address}, which Tailscale does not report as this computer's own`
      + " address, so Branch is listening on this computer only. If it is this computer's Tailscale address,"
      + " connect Tailscale and start Branch again.";
  return `This computer answers on ${address}, which is not a private address, so Branch is listening on`
    + " this computer only. Branch listens beyond this computer on a private network and nowhere else.";
}

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
  /**
   * The addresses Tailscale itself reports as this computer's. Of the addresses in Tailscale's range,
   * only these count as private; left out, none do.
   */
  tailnet?: readonly string[];
}): ListenDecision {
  const stay = (refusal: string | null): ListenDecision =>
    ({ address: thisComputerAddress, extraHosts: [], beyond: false, refusal, ipv4Only: null });
  if (input.where === "this-computer") return stay(null);
  if (input.lockdown)
    return stay("Lockdown is on, so Branch is listening on this computer only.");
  // The whole door rests on this one key. Without it a wider address would be Branch with no
  // credential at all on a network, so it is refused rather than obeyed.
  if (!/^[a-f0-9]{64}$/.test(input.token))
    return stay("Branch has no local key to ask callers for, so it is listening on this computer only.");
  const outward = input.addresses.filter((entry) => !entry.internal);
  // Integration review: every other refusal here is something found; this one is something NOT
  // found, which is exactly the shape that fails open. A computer that answers on nothing beyond
  // itself has nowhere to be reached from, so a wide socket buys nothing and hides the next mistake
  // (a network that comes up later, an address list read wrongly) behind an open door.
  if (!outward.length)
    return stay("This computer answers on no address beyond itself, so Branch is listening on this"
      + " computer only.");
  const open = outward.filter((entry) => !isLanListenAddress(entry.address, input.tailnet));
  // An IPv4 address that is not private would put the door on that network, so it refuses and is the
  // one named, whichever came first. An IPv6 one would not, as the door is the IPv4 wildcard: the door
  // opens on the private IPv4 networks alone, when there is one to open on.
  const openV4 = open.find((entry) => !reachedOverIPv6Only(entry.address));
  if (openV4) return stay(notPrivate(openV4.address));
  const ipv4 = outward.filter((entry) => isIP(entry.address) === 4);
  if (open.length && !ipv4.length) return stay(notPrivate(open[0]!.address));
  return open.length ? wideDoor(ipv4, open[0]!.address) : wideDoor(outward, null);
}

/**
 * `decideListen` for this computer: its own addresses, and what Tailscale itself reports about them.
 * Tailscale is asked only when the wider door is asked for and this computer answers on an address in
 * Tailscale's range. Tailscale missing, not running or not answering confirms nothing, so such an
 * address keeps the door on this computer.
 */
export async function decideListenHere(input: {
  where: ListenPlace;
  lockdown: boolean;
  token: string;
  /** This computer's addresses; `ownAddresses()` when left out. */
  addresses?: readonly OwnAddress[] | undefined;
  /** How Tailscale is asked; `probeTailscale` when left out. */
  tailscale?: ProbeTailscale | undefined;
}): Promise<ListenDecision> {
  const addresses = input.addresses ?? ownAddresses();
  const asks = input.where === "private-network"
    && addresses.some((entry) => !entry.internal && isTailnetAddress(entry.address));
  const tailnet = asks ? await reportedTailnet(input.tailscale ?? probeTailscale) : [];
  return decideListen({ where: input.where, lockdown: input.lockdown, token: input.token, addresses, tailnet });
}

/** The address Tailscale reports as this computer's, while it is running; nothing otherwise. */
async function reportedTailnet(probe: ProbeTailscale): Promise<string[]> {
  try {
    const status = await probe();
    return status.running && status.address ? [status.address] : [];
  } catch {
    return [];
  }
}

/* ---------- while Branch runs ---------- */

/**
 * How often the wider door looks at this computer's addresses again. The door is decided on the
 * addresses this computer has when Branch starts, and a computer can gain one later: a public
 * address, or a 100.64 one Tailscale does not report. Either would have kept the door on this
 * computer at the start, so while the door is open wider it looks again, and decides again when the
 * addresses have changed.
 */
export const addressCheckMs = 15_000;

/** The door as it stands while Branch runs: the decision it was opened on, and what happened since. */
export interface ListenState extends ListenDecision {
  /** The wider door was open, and was closed while Branch ran: by Lockdown, or by a change of address. */
  closedWhileRunning: boolean;
  /**
   * The door was closed while Branch ran, and this computer's addresses would let it open again. Only
   * starting Branch again opens it: nothing opens the door while Branch runs.
   */
  restartOpens: boolean;
}

/**
 * Why the wider door closed when a decision made again finds it is no longer asked for: the setting
 * was changed to this computer only, or Lockdown reads it that way.
 */
export const listenNowHereReason = "Branch is no longer asked to listen beyond this computer, so it is"
  + " listening on this computer only.";

/** A reading's outward addresses as one string, so two readings can be compared as `decideListen` sees them. */
export function outwardAddressKey(addresses: readonly OwnAddress[]): string {
  return addresses.filter((entry) => !entry.internal)
    .map((entry) => entry.address.replace(/%.*$/, "").toLowerCase()).sort().join(" ");
}

/**
 * Reads this computer's addresses every `everyMs` and hands a reading to `changed` when its outward
 * addresses differ from the last reading acted on. One reading is acted on at a time: a tick while
 * `changed` is still deciding passes by. A reading that throws changes nothing, and a `changed` that
 * fails is tried again at the next tick. The timer never keeps Branch running by itself. Returns
 * what stops it.
 */
export function watchAddresses(input: {
  read: () => readonly OwnAddress[];
  everyMs: number;
  /** The reading the door was decided on. */
  first: readonly OwnAddress[];
  changed: (addresses: readonly OwnAddress[]) => Promise<void>;
}): () => void {
  let seen = outwardAddressKey(input.first);
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    let now: readonly OwnAddress[];
    let key: string;
    try {
      now = input.read();
      key = outwardAddressKey(now);
    } catch {
      return;
    }
    if (key === seen) return;
    busy = true;
    Promise.resolve().then(() => input.changed(now))
      .then(() => { seen = key; }, () => undefined)
      .finally(() => { busy = false; });
  }, input.everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** What the owner's screen and `GET /api/listen` are told. */
export function listenView(store: Pick<Store, "get">, owner: string, state: ListenState): Record<string, unknown> {
  return {
    where: listenAsked(store, owner),
    saved: ListenSettingsSchema.safeParse(store.get("settings", owner, listenKey)?.data ?? {}).data?.where ?? "this-computer",
    places: listenPlaces,
    lockdown: lockdownActive(store, owner),
    listeningOn: state.address,
    beyondThisComputer: state.beyond,
    refusal: state.refusal,
    ipv4Only: state.ipv4Only,
    closedWhileRunning: state.closedWhileRunning,
    // Lockdown keeps the door on this computer at a start too, so while it is on nothing says otherwise.
    restartOpens: state.restartOpens && !lockdownActive(store, owner),
  };
}

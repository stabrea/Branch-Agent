import { z } from "zod";
import { FeatureModeSchema, type FeatureMode } from "./feature-switches.js";

/**
 * How tightly a program Branch Agent starts is held. Until this existed, the memory and processor
 * ceilings and the dead-address proxy were fixed per tool, and `src/code-run.ts` said outright that
 * what it offered was a limit on resources, not a sandbox the owner chooses. An approval rule can
 * now say which of the three it wants for the tools it covers, and the tool that starts the program
 * honours it.
 *
 * Nothing here is a security boundary on its own: a program still runs on this computer as this
 * user. It is the owner deciding how much rope one tool gets.
 */
export const sandboxChoices = ["no-internet", "limits-only", "none"] as const;
export type SandboxChoice = (typeof sandboxChoices)[number];

/** What one choice means for a program about to be started. */
export interface SandboxShape {
  /** Have the system hold the memory and processor ceilings (a Windows job, or a limited process group on macOS and Linux). */
  job: boolean;
  /** Point the program at a dead address, so it cannot reach the internet. */
  netless: boolean;
}

const shapes: Record<SandboxChoice, SandboxShape> = {
  "no-internet": { job: true, netless: true },
  "limits-only": { job: true, netless: false },
  none: { job: false, netless: false },
};

/** Who holds the ceilings on each computer, in the owner's words. */
export const systemName = (platform: NodeJS.Platform = process.platform): string =>
  platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : "the system";

/** Plain words for the settings screen and the approval card. */
export function sandboxSentencesFor(platform: NodeJS.Platform = process.platform): Record<SandboxChoice, string> {
  const system = systemName(platform);
  return {
    "no-internet": `in a box ${system} holds to its memory and processor limits, with no way out to the internet`,
    "limits-only": `in a box ${system} holds to its memory and processor limits`,
    // A rule never loosens the settings, so "none" adds no box of its own; the settings may still hold one.
    none: "with no extra box beyond what the settings already hold",
  };
}
export const sandboxSentences: Record<SandboxChoice, string> = sandboxSentencesFor();
export const sandboxSentence = (choice: SandboxChoice): string => sandboxSentences[choice];

/**
 * The shape to use: the owner's choice when a rule made one, otherwise exactly what the tool would
 * have done before this existed. A tool with no rule behaves as it always did.
 */
export function sandboxShape(choice: SandboxChoice | null | undefined, fallback: SandboxShape): SandboxShape {
  if (!choice) return fallback;
  // A rule may hold a program more tightly than the settings already do, never more loosely, and that
  // holds for every field. If the settings say this tool has no way out to the internet, or that the
  // system holds its limits, no choice on a rule takes that away: the owner switched it on in one
  // place and should not have it switched off in another.
  return { job: shapes[choice].job || fallback.job, netless: shapes[choice].netless || fallback.netless };
}

/** The choice a shape amounts to, for reporting back what a program actually ran under. */
export function shapeChoice(shape: SandboxShape): SandboxChoice {
  return shape.job ? (shape.netless ? "no-internet" : "limits-only") : "none";
}

// ------------------------------------------------------------------ the wall (wave mac3, os-sandbox)
//
// Everything above holds a program to limits; it still reads and writes whatever the owner can. The
// wall is the system itself refusing: macOS's own sandbox (`/usr/bin/sandbox-exec`) or, on Linux,
// bubblewrap. It is one three-way switch in Settings and it ships off. Nothing here is reachable from
// a tool's arguments: the switch is read from the owner's settings when a call starts, a rule may
// only make it stricter, and on Windows it changes nothing at all (the job object and Windows'
// throwaway desktop keep doing exactly what they did).

/** How far a program behind the wall may reach, strictest first. */
export const wallNetworks = ["none", "limited", "per-site", "open"] as const;
export type WallNetwork = (typeof wallNetworks)[number];

/** The stricter of two network reaches. */
export const tighterNetwork = (a: WallNetwork, b: WallNetwork): WallNetwork =>
  wallNetworks.indexOf(a) <= wallNetworks.indexOf(b) ? a : b;

const hostName = z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9.-]+$/, "A site is a name such as api.github.com");
export const WallSettingsSchema = z.object({
  /** Off, when needed (only calls your rules ask about or hold in a box), or on for every program. */
  mode: FeatureModeSchema.default("off"),
  /** Nowhere, only reading from sites you allow, sites you allow, or anywhere. */
  network: z.enum(wallNetworks).default("none"),
  /** Which site each saved key belongs to; a program behind the wall gets a stand-in for it. */
  keySites: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), hostName)
    .refine((sites) => Object.keys(sites).length <= 64, "At most 64 keys").default({}),
  /** More places a program behind the wall may not even read, given in full. */
  unreadable: z.array(z.string().trim().min(2).max(500).regex(/^\//, "Give the place in full, starting with /")).max(32).default([]),
}).strict();
export type WallSettings = z.infer<typeof WallSettingsSchema>;

interface SettingsReader { get(kind: string, owner: string, key: string): { data: unknown } | undefined }
interface SettingsWriter extends SettingsReader { save(kind: string, owner: string, key: string, data: Record<string, unknown>): unknown }

export function wallSettings(store: SettingsReader, owner: string): WallSettings {
  const saved = WallSettingsSchema.safeParse(store.get("settings", owner, "os-sandbox")?.data ?? {});
  // A damaged record is read as the strictest thing it could have meant, never as "off".
  return saved.success ? saved.data : WallSettingsSchema.parse({ mode: "on", network: "none" });
}
export function saveWallSettings(store: SettingsWriter, owner: string, input: unknown): WallSettings {
  const value = WallSettingsSchema.parse(input ?? {});
  store.save("settings", owner, "os-sandbox", { ...value });
  return value;
}

/**
 * Whether a call goes behind the wall. Monotone: "on" always does, whatever the rule or the call
 * says; "when needed" does for a call your rules mark risky; "off" never adds a wall of its own.
 */
export function wallApplies(mode: FeatureMode, risky: boolean): boolean {
  return mode === "on" || (mode === "when-needed" && risky);
}

/** The reach a call gets: the setting, made stricter by a rule's "no internet" and never looser. */
export function wallNetworkFor(setting: WallNetwork, choice: SandboxChoice | null | undefined): WallNetwork {
  return choice === "no-internet" ? "none" : setting;
}

/** What a tool that starts a program is handed, when the program goes behind the wall. */
export interface WallContext {
  network: WallNetwork;
  keySites: Readonly<Record<string, string>>;
  unreadable: readonly string[];
  /** Places a program may read but never change: Branch's own program, gateway and updater (src/never-break). */
  readOnly?: readonly string[];
  /** An answer already given to "may programs reach this site" or "may it write here". */
  answer(kind: WallQuestion, target: string): "allow" | "deny" | undefined;
  /** Every place the owner has let a program write to after the wall blocked it. */
  granted(kind: WallQuestion): string[];
  /** Uses up a yes given just for one retry. */
  spend(kind: WallQuestion, target: string): void;
  /** The owner's network rules (blocked sites, private addresses), asked before any site is reached. */
  siteCheck?: ((target: URL) => Promise<void>) | undefined;
  /** The owner's fake-IP proxy setting (web section), which the door reads for every site. */
  fakeIpProxy?: (() => boolean) | undefined;
}
export type WallQuestion = "network.site" | "sandbox.write";

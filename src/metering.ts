/**
 * Metering: writing this month's usage out as a spreadsheet file, on a schedule, into a folder of
 * your own workspace. Nothing is sent anywhere — the file is written on this computer and stays
 * here. Every model call and tool call is already counted in the ledger; this only copies the
 * counting out at a set time so an accounts person, or a billing sheet, can pick it up.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { csvCell } from "./audit.js";
import { audit } from "./audit.js";
import type { Store } from "./store.js";
import type { UsageAggregate } from "./usage.js";
import type { ModelPrice } from "./pricing.js";
import { optionalFields } from "./feature-switches.js";

export const MeteringSchema = z.object({
  /** Off until the owner asks for it. */
  enabled: z.boolean().default(false),
  /** A folder inside the workspace. It is made if it is not there. */
  folder: z.string().trim().min(1).max(200).default("usage"),
  /** How often the file is written again. Daily is the sensible setting. */
  every: z.enum(["hourly", "daily", "weekly"]).default("daily"),
  /** When it was last written, and to where. Branch fills these in; they are not settings. */
  lastWrittenAt: z.string().optional(),
  lastFile: z.string().optional(),
}).strict();
export type MeteringSettings = z.infer<typeof MeteringSchema>;

const settingsKey = "metering";
const everyMs: Record<MeteringSettings["every"], number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export function meteringSettings(store: Store, owner: string): MeteringSettings {
  const saved = MeteringSchema.safeParse(store.get("settings", owner, settingsKey)?.data);
  return saved.success ? saved.data : MeteringSchema.parse({});
}
export function saveMeteringSettings(store: Store, owner: string, input: unknown): MeteringSettings {
  const current = meteringSettings(store, owner);
  const wanted = optionalFields(MeteringSchema).parse(input);
  const next = MeteringSchema.parse({ ...current, ...wanted });
  store.save("settings", owner, settingsKey, next);
  return next;
}

/** The month's days as a spreadsheet, with the money columns the Usage screen shows. */
export function meteringCsv(days: UsageAggregate[]): string {
  const header = "date,runs,toolCalls,tokensInput,tokensOutput,estimatedCostUsd,costPerRunUsd,runsWithPrice,runsWithoutPrice,failures";
  const rows = days.map((day) => [
    day.date, day.runs, day.toolCalls, day.tokens.input, day.tokens.output,
    day.pricedRuns ? day.estimatedCost.toFixed(4) : "",
    day.pricedRuns ? (day.estimatedCost / day.pricedRuns).toFixed(6) : "",
    day.pricedRuns, day.unpricedRuns, day.failures,
  ].map(csvCell).join(","));
  return [header, ...rows].join("\n") + "\n";
}

/** The file this month's figures go into, named after the month so each one stands on its own. */
export function meteringFileName(when: Date): string {
  return `usage-${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}.csv`;
}

/** A folder inside the workspace, refusing anything that would climb out of it. */
export function meteringFolder(workspace: string, folder: string): string {
  if (isAbsolute(folder) || folder.includes("\\") || folder.includes(":"))
    throw new Error("The folder for the usage file must be inside your workspace, written as a plain name");
  const target = resolve(workspace, folder);
  const inside = relative(workspace, target);
  if (inside.startsWith("..") || isAbsolute(inside))
    throw new Error("The folder for the usage file must be inside your workspace");
  return target;
}

export interface MeteringDeps {
  store: Store;
  owner: string;
  workspace: string;
  /** The owner's own prices, so the file costs a task the same way the Usage screen does. */
  overrides: () => Record<string, ModelPrice>;
}

/** True when enough time has gone by since the last file for another one to be due. */
export function meteringDue(settings: MeteringSettings, now: Date): boolean {
  if (!settings.enabled) return false;
  if (!settings.lastWrittenAt) return true;
  const last = Date.parse(settings.lastWrittenAt);
  return !Number.isFinite(last) || now.getTime() - last >= everyMs[settings.every];
}

/**
 * Writes this month's figures out, whether or not one is due. The Settings screen's "Write it now"
 * calls this; the scheduled beat calls `meteringTick`.
 */
export async function writeMeteringFile(deps: MeteringDeps, now = new Date()): Promise<{ path: string; days: number }> {
  const settings = meteringSettings(deps.store, deps.owner);
  const folder = meteringFolder(deps.workspace, settings.folder);
  const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-`;
  const month = deps.store.usageStore().aggregateUsage("90d", "day", deps.overrides())
    .filter((day) => day.date.startsWith(prefix));
  const path = join(folder, meteringFileName(now));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, meteringCsv(month), "utf8");
  deps.store.save("settings", deps.owner, settingsKey,
    MeteringSchema.parse({ ...settings, lastWrittenAt: now.toISOString(), lastFile: path }));
  audit(deps.store, deps.owner, {
    action: "data.exported", actor: deps.owner, subject: "this month's usage",
    reason: "The usage file was written into your workspace on the schedule you set", outcome: "saved",
  });
  return { path, days: month.length };
}

/** The scheduler's beat: writes the file when one is due, and does nothing at all when it is not. */
export async function meteringTick(deps: MeteringDeps, now = new Date()): Promise<string | null> {
  if (!meteringDue(meteringSettings(deps.store, deps.owner), now)) return null;
  try {
    return (await writeMeteringFile(deps, now)).path;
  } catch {
    /* A folder that cannot be written to must not stop the rest of the scheduled work. */
    return null;
  }
}

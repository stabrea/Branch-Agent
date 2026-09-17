import { z } from "zod";
import type { Store } from "../store.js";
import { audit } from "../audit.js";
import { currentValue, type Proposal, type Value } from "./changes.js";
import { settingsCatalogue } from "./catalogue.js";

/**
 * R17-S07: the owner's settings, switches included, as one small file to keep or carry to another
 * computer. Only the fields in the catalogue go in, so no key, password, connection or person can
 * ever be inside. Bringing a file in only proposes changes; nothing is written until the owner
 * ticks them, and a change that makes Branch less careful needs its own yes.
 */
export const settingsFileFormat = "branch-settings";
export const maximumSettingsFileBytes = 256 * 1024;

const FieldValues = z.record(z.string().max(80), z.unknown()).refine((value) => Object.keys(value).length <= 40, "Too many fields");
export const SettingsFileSchema = z.object({
  format: z.literal(settingsFileFormat),
  version: z.literal(1),
  exportedAt: z.string().max(40),
  appVersion: z.string().max(40),
  settings: z.record(z.string().max(80), FieldValues).refine((value) => Object.keys(value).length <= 200, "Too many settings"),
}).strict();
export type SettingsFile = z.infer<typeof SettingsFileSchema>;

/** Every catalogued setting as it is now. */
export function exportSettings(store: Store, owner: string, appVersion: string): SettingsFile {
  const settings: Record<string, Record<string, Value>> = {};
  for (const spec of settingsCatalogue)
    settings[spec.key] = Object.fromEntries(spec.fields.map((field) => [field.field, currentValue(store, owner, spec, field)]));
  audit(store, owner, {
    action: "data.exported", actor: owner, subject: "settings, as one file",
    reason: `${settingsCatalogue.length} settings with their switches; no keys, connections or people`, outcome: "saved",
  });
  return { format: settingsFileFormat, version: 1, exportedAt: new Date().toISOString(), appVersion: appVersion.slice(0, 40), settings };
}

/** Opens a settings file and turns it into proposals. Whether each one is allowed is decided later. */
export function readSettingsFile(input: unknown): Proposal[] {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? null);
  if (Buffer.byteLength(text, "utf8") > maximumSettingsFileBytes) throw new Error("That file is larger than a settings file can be.");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("That file is not a settings file: it could not be read."); }
  const file = SettingsFileSchema.safeParse(parsed);
  if (!file.success) throw new Error("That file is not a Branch settings file.");
  return Object.entries(file.data.settings).flatMap(([key, fields]) =>
    Object.entries(fields).map(([field, value]) => ({ key, field, value })));
}

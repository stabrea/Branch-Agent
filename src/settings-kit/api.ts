import { z } from "zod";
import type { Store } from "../store.js";
import { audit } from "../audit.js";
import { lockedDown } from "../lockdown.js";
import { settingsCatalogue } from "./catalogue.js";
import { applyChanges, changesFor, currentValue, resetProposals, type Proposal, type Writer } from "./changes.js";
import { fileMap, openFile, saveFile, SlotSchema } from "./file-map.js";
import { presetFor, presets } from "./presets.js";
import { exportSettings, maximumSettingsFileBytes, readSettingsFile } from "./transfer.js";

/**
 * R17-S-A: the window's side of understandable settings, under /api/settings-kit. Every route is the
 * owner's alone: a household profile is answered 403 (integration review). A short-lived key is
 * refused every change here (none of these routes is on its list in src/short-lived-keys.ts), and the
 * settings file and the owner's own files are on its list of reads it may not make.
 */
export class SettingsKitError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface SettingsKitDeps {
  store: Store;
  owner: string;
  workspace: string;
  appVersion: string;
  /** Saves that do more than write the record (see ApplyChoice.writers). */
  writers?: Record<string, Writer> | undefined;
  /** The never-break guard for a file about to be written: why not, or null (src/never-break/protected.ts). */
  guard?: ((target: string) => string | null) | undefined;
}

function ownerOnly(deps: SettingsKitDeps, what: string): void {
  try { deps.store.profiles.requireOwner(what); }
  catch (error) { throw new SettingsKitError(403, (error as Error).message); }
}

export const handlesSettingsKitPath = (path: string): boolean => path === "/api/settings-kit" || path.startsWith("/api/settings-kit/");
export const settingsKitBodyBytes = maximumSettingsFileBytes * 2;

const Source = z.discriminatedUnion("source", [
  z.object({ source: z.literal("reset"), key: z.string().max(80).optional() }).strict(),
  z.object({ source: z.literal("preset"), preset: z.string().max(40) }).strict(),
  z.object({ source: z.literal("import"), file: z.string().max(maximumSettingsFileBytes) }).strict(),
  /** One change, from a button such as "Watch me once"; held to the same rules as the rest. */
  z.object({ source: z.literal("set"), key: z.string().max(80), field: z.string().max(80),
    value: z.union([z.string().max(40), z.number(), z.boolean()]) }).strict(),
]);
const Apply = z.object({
  plan: Source,
  accept: z.array(z.string().max(120)).max(500),
  confirmLoosening: z.boolean().default(false),
}).strict();

function proposalsFor(plan: z.infer<typeof Source>): { proposals: Proposal[]; why: string } {
  if (plan.source === "reset") {
    if (plan.key && !settingsCatalogue.some((spec) => spec.key === plan.key)) throw new SettingsKitError(404, "There is no such setting to put back.");
    return { proposals: resetProposals(plan.key), why: plan.key ? `put back: ${plan.key}` : "put back: everything" };
  }
  if (plan.source === "preset") {
    const preset = presetFor(plan.preset);
    if (!preset) throw new SettingsKitError(404, "There is no preset by that name.");
    return { proposals: preset.sets, why: `preset: ${preset.name}` };
  }
  if (plan.source === "set") return { proposals: [{ key: plan.key, field: plan.field, value: plan.value }], why: "one switch" };
  try { return { proposals: readSettingsFile(plan.file), why: "a settings file" }; }
  catch (error) { throw new SettingsKitError(400, (error as Error).message); }
}

function overview(deps: SettingsKitDeps) {
  return {
    settings: settingsCatalogue.map((spec) => ({
      key: spec.key, name: spec.name, t: spec.t, home: spec.home,
      fields: spec.fields.map((field) => ({ field: field.field, label: field.label, t: field.t, guard: field.guard,
        initial: field.initial, value: currentValue(deps.store, deps.owner, spec, field) })),
    })),
    presets: presets.map(({ id, name, t, about, aboutT, sets }) => ({ id, name, t, about, aboutT, count: sets.length })),
  };
}

function apply(deps: SettingsKitDeps, input: unknown) {
  // Lockdown keeps its own copy of what it took over and writes it back when it ends; a change made
  // underneath it would either loosen it now or be thrown away then.
  if (lockedDown(deps.store, deps.owner)) throw new SettingsKitError(409, "Lockdown is on, so settings cannot be changed from here. Turn it off first.");
  const body = Apply.parse(input);
  const { proposals, why } = proposalsFor(body.plan);
  const { changes } = changesFor(deps.store, deps.owner, proposals);
  let applied;
  try {
    applied = applyChanges(deps.store, deps.owner, changes, { accept: body.accept, confirmLoosening: body.confirmLoosening, why, writers: deps.writers });
  } catch (error) { throw new SettingsKitError(409, (error as Error).message); }
  if (body.plan.source === "import" && applied.length)
    audit(deps.store, deps.owner, { action: "data.imported", actor: deps.owner, subject: "settings, from one file",
      reason: `${applied.length} of ${changes.length} proposed changes were made`, outcome: "saved" });
  return { applied, overview: overview(deps) };
}

export async function settingsKitApi(deps: SettingsKitDeps, method: string, path: string, body: () => Promise<unknown>): Promise<unknown> {
  // The switches, the settings file and the text of the owner's own files are the owner's alone.
  ownerOnly(deps, "Settings");
  if (method === "GET" && path === "/api/settings-kit") return overview(deps);
  if (method === "GET" && path === "/api/settings-kit/export") return exportSettings(deps.store, deps.owner, deps.appVersion);
  if (method === "GET" && path === "/api/settings-kit/files") return { files: fileMap(deps.store, deps.owner, deps.workspace) };
  const slot = /^\/api\/settings-kit\/files\/([a-z][a-z0-9_-]{0,20})$/.exec(path);
  if (method === "GET" && slot) {
    const key = SlotSchema.safeParse(slot[1]);
    if (!key.success) throw new SettingsKitError(404, "There is no such file.");
    return openFile(deps.store, deps.owner, deps.workspace, key.data);
  }
  if (method !== "POST") throw new SettingsKitError(404, "Not found");
  if (path === "/api/settings-kit/preview") {
    const { proposals } = proposalsFor(Source.parse(await body()));
    return changesFor(deps.store, deps.owner, proposals);
  }
  if (path === "/api/settings-kit/apply") return apply(deps, await body());
  if (path === "/api/settings-kit/files") {
    const input = await body();
    try { return saveFile(deps.store, deps.owner, deps.workspace, input, deps.guard); }
    catch (error) { throw error instanceof z.ZodError ? error : new SettingsKitError(400, (error as Error).message); }
  }
  throw new SettingsKitError(404, "Not found");
}

import { z } from "zod";
import type { Store } from "../store.js";
import { audit } from "../audit.js";
import { securityShaped, secretShaped, settingsCatalogue, specFor, switchPositions, type FieldSpec, type SettingSpec } from "./catalogue.js";

/**
 * R17-S-A: one list of changes, whoever proposed them — putting settings back, a whole-app preset,
 * or a settings file. The owner sees the list, ticks what they want, and only those are written.
 * A change that makes Branch less careful is marked, and is refused unless the owner said yes to
 * that in as many words.
 */
export type Value = string | number | boolean;

export interface Change {
  /** `key.field`, which is also what the owner ticks. */
  id: string;
  key: string;
  field: string;
  name: string;
  nameT: string;
  label: string;
  labelT: string;
  home: string;
  from: Value;
  to: Value;
  /** True when this change makes Branch less careful or lets it reach further. */
  loosens: boolean;
}

/** A value proposed for one field, before it has been checked. */
export interface Proposal { key: string; field: string; value: unknown }

const readPath = (data: Record<string, unknown>, field: string): unknown =>
  field.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), data);

function writePath(data: Record<string, unknown>, field: string, value: Value): Record<string, unknown> {
  const [head, rest] = field.split(/\.(.*)/s, 2) as [string, string | undefined];
  if (!rest) return { ...data, [head]: value };
  const inner = data[head] && typeof data[head] === "object" ? data[head] as Record<string, unknown> : {};
  return { ...data, [head]: writePath(inner, rest, value) };
}

/** The value a field accepts, or undefined when the proposal is not one it could hold. */
export function acceptValue(spec: FieldSpec, value: unknown): Value | undefined {
  const kind = spec.kind;
  const schema = kind.type === "switch" ? z.enum(switchPositions)
    : kind.type === "yes-no" ? z.boolean()
      : kind.type === "choice" ? z.enum(kind.options as [string, ...string[]])
        : z.number().int().min(kind.min).max(kind.max);
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** What the field holds now; an unset or unreadable value counts as its starting value. */
export function currentValue(store: Store, owner: string, spec: SettingSpec, field: FieldSpec): Value {
  const data = spec.read ? spec.read(store, owner) : (store.get("settings", owner, spec.key)?.data ?? {}) as Record<string, unknown>;
  let saved = readPath(data, field.field);
  // An older record with only a yes/no stands for "when needed" (src/feature-switches.ts, modeOf).
  if (saved === undefined && field.field === "mode" && spec.keepsEnabled && data.enabled === true) saved = "when-needed";
  const accepted = acceptValue(field, saved);
  if (accepted !== undefined) return accepted;
  // A choice saved outside the list ("custom" approval rules) is shown as it is, and counts as the
  // least known position, so moving away from it always asks for the separate yes.
  return field.kind.type === "choice" && typeof saved === "string" ? saved.slice(0, 40) : field.initial;
}

/** How careful a value is, as a number: higher is less careful. */
function reachOf(field: FieldSpec, value: Value): number {
  const kind = field.kind;
  if (kind.type === "switch") return switchPositions.indexOf(value as (typeof switchPositions)[number]);
  if (kind.type === "yes-no") return value ? 1 : 0;
  if (kind.type === "choice") return kind.options.indexOf(String(value));
  return 0;
}

export function loosens(field: FieldSpec, from: Value, to: Value, spec?: Pick<SettingSpec, "key">): boolean {
  // Fails closed: a "plain" field on a setting that sounds like safety counts as less careful either way.
  if (field.guard === "plain") return !!spec && securityShaped.test(spec.key) && from !== to;
  const up = reachOf(field, to) > reachOf(field, from);
  const down = reachOf(field, to) < reachOf(field, from);
  // A choice list is written most careful first, so moving along it is loosening whichever guard it is.
  if (field.kind.type === "choice") return up;
  return field.guard === "reach" ? up : down;
}

/**
 * Turns proposals into the changes they would make. Anything that is not in the catalogue, sounds
 * like a secret, or is not a value the field can hold is refused with a reason; anything that would
 * change nothing is left out.
 */
export function changesFor(store: Store, owner: string, proposals: readonly Proposal[]): { changes: Change[]; refused: string[] } {
  const changes: Change[] = [];
  const refused: string[] = [];
  const seen = new Set<string>();
  for (const proposal of proposals.slice(0, 500)) {
    const spec = specFor(proposal.key);
    const field = spec?.fields.find((entry) => entry.field === proposal.field);
    const id = `${proposal.key}.${proposal.field}`;
    if (!spec || !field || secretShaped.test(proposal.field)) { refused.push(`${id}: not a setting that can be changed from here`); continue; }
    const to = acceptValue(field, proposal.value);
    if (to === undefined) { refused.push(`${id}: not a value this setting can hold`); continue; }
    const from = currentValue(store, owner, spec, field);
    if (from === to || seen.has(id)) continue;
    seen.add(id);
    changes.push({ id, key: spec.key, field: field.field, name: spec.name, nameT: spec.t, label: field.label, labelT: field.t,
      home: spec.home, from, to, loosens: loosens(field, from, to, spec) });
  }
  return { changes, refused };
}

/** Everything put back to how it started, or one setting only. */
export function resetProposals(key?: string): Proposal[] {
  return settingsCatalogue.filter((spec) => !key || spec.key === key)
    .flatMap((spec) => spec.fields.map((field) => ({ key: spec.key, field: field.field, value: field.initial })));
}

export type Writer = (patch: Record<string, unknown>) => void;

function writeOne(store: Store, owner: string, spec: SettingSpec, picked: Change[], writer?: Writer): void {
  const patch = Object.fromEntries(picked.map((change) => [change.field, change.to]));
  if (writer) return writer(patch);
  if (spec.write) return spec.write(store, owner, patch);
  let data = { ...((store.get("settings", owner, spec.key)?.data ?? {}) as Record<string, unknown>) };
  for (const change of picked) data = writePath(data, change.field, change.to);
  if (spec.keepsEnabled && picked.some((change) => change.field === "mode")) data.enabled = data.mode !== "off";
  store.save("settings", owner, spec.key, data);
}

export interface ApplyChoice {
  /** The ids the owner ticked. Nothing else is written. */
  accept: readonly string[];
  /** The owner's separate yes to changes that make Branch less careful. */
  confirmLoosening: boolean;
  /** Where the changes came from, for the record. */
  why: string;
  /**
   * Settings whose own save does more than write the record (a learning switch also adds or takes
   * away a tool) are saved through that, keyed by setting.
   */
  writers?: Record<string, Writer> | undefined;
}

/**
 * Writes only the ticked changes, worked out again here rather than taken from the page, so a page
 * cannot slip in a value the owner was never shown.
 */
export function applyChanges(store: Store, owner: string, changes: readonly Change[], choice: ApplyChoice): Change[] {
  const accepted = new Set(choice.accept);
  const picked = changes.filter((change) => accepted.has(change.id));
  const loose = picked.filter((change) => change.loosens);
  if (loose.length && !choice.confirmLoosening)
    throw new Error(`${loose.length} of these make Branch less careful (${loose.map((change) => change.label).join(", ")}). Tick "Yes, make it less careful" to go ahead, or untick them.`);
  for (const spec of settingsCatalogue) {
    const mine = picked.filter((change) => change.key === spec.key);
    if (mine.length) writeOne(store, owner, spec, mine, choice.writers?.[spec.key]);
  }
  if (picked.length)
    audit(store, owner, {
      action: "policy.changed", actor: owner, subject: `${picked.length} settings changed (${choice.why})`,
      reason: picked.map((change) => `${change.id}: ${String(change.from)} → ${String(change.to)}`).join("; ").slice(0, 500),
      outcome: "saved",
    });
  return picked;
}

import { z } from "zod";
import type { Store } from "../store.js";

/**
 * Bucket R17-D (wave mac7): "coding polish". Each part has the owner's three-way switch — off, when
 * needed, on — kept in a settings record of its own. Every part ships off except `read-first`, a guard
 * that only makes things stricter, which ships on (Q250, the owner's "what ships on" rule).
 *
 *   off          the part does nothing and refuses in one plain sentence; its tools are not listed
 *   when-needed  it works, and its tools are a line in the index until the work calls for them
 *   on           it works, and its tools are loaded from the first round
 *
 * The schema is written out here rather than imported from feature-switches.ts, because that file
 * reads these same records to decide what to preload, and the two must not import each other.
 */
export const codingParts = [
  "format-on-edit", "shell-snapshot", "mentions", "worktrees", "init", "ci",
  "checklist", "path-rules", "large-output", "notebooks", "review-checks",
  // mac7/coding-next: a guard, not a tool; "when needed" and "on" both hold every task to it.
  "read-first",
  // mac7/speed: doing more in one round. Like read-first this is mostly how the loop behaves, so
  // "when needed" and "on" both switch the behaviour on; what differs is its one tool's tier.
  "fewer-rounds",
] as const;
export type CodingPart = (typeof codingParts)[number];
export const CodingPartSchema = z.enum(codingParts);

const ModeSchema = z.enum(["off", "when-needed", "on"]);
export type CodingMode = z.infer<typeof ModeSchema>;
const RecordSchema = z.object({ mode: ModeSchema.default("off") }).passthrough();

/** The settings record a part's switch is kept in. */
export const codingKey = (part: CodingPart): string => `coding-${part}`;

/** What each part is, in the owner's words, for the card and for a refusal. */
export const codingLabels: Record<CodingPart, string> = {
  "format-on-edit": "Tidying a file and checking it for mistakes after every change",
  "shell-snapshot": "Using your own command-line setup",
  mentions: "Pointing at files with @, and @imports in instruction files",
  worktrees: "A separate copy of the project for a conversation or a helper",
  init: "Writing the project's instruction file",
  ci: "Running Branch in GitHub Actions or GitLab CI",
  checklist: "A checklist for each task that you can edit while it runs",
  "path-rules": "Rules for some folders only, and schedules kept as files",
  "large-output": "Keeping very long tool output in a file",
  notebooks: "Reading Jupyter notebooks cell by cell",
  "review-checks": "Review checks kept in the project",
  "read-first": "Reading a file before changing it",
  "fewer-rounds": "Doing more in one go, so a task takes fewer turns",
};

/** The tools each part owns, so the catalog can leave them out while the part is off. */
export const codingTools: Record<CodingPart, readonly string[]> = {
  "format-on-edit": ["code.format"],
  "shell-snapshot": [],
  mentions: [],
  worktrees: [],
  init: ["project.init"],
  ci: [],
  checklist: ["checklist.write", "checklist.read"],
  "path-rules": ["rules.for_path"],
  "large-output": ["output.read"],
  notebooks: ["notebook.read"],
  "review-checks": ["review.checks"],
  "read-first": [],
  "fewer-rounds": ["files.read_many"],
};

/** For src/feature-switches.ts: each part with tools — its settings record, why it is loaded, and its tools. */
export const codingToolFeatures: readonly (readonly [string, string, readonly string[]])[] = codingParts
  .filter((part) => codingTools[part].length > 0)
  .map((part) => [codingKey(part), `${codingLabels[part].charAt(0).toLowerCase()}${codingLabels[part].slice(1)} is switched on`, codingTools[part]] as const);

/** Q250: the parts that ship on. A part the owner has never switched is in the mode named here. */
const shipsOn: ReadonlySet<CodingPart> = new Set<CodingPart>(["read-first"]);
export const codingDefault = (part: CodingPart): CodingMode => (shipsOn.has(part) ? "on" : "off");

export function codingMode(store: Pick<Store, "get">, owner: string, part: CodingPart): CodingMode {
  const data = (store.get("settings", owner, codingKey(part))?.data ?? {}) as Record<string, unknown>;
  if (data.mode === undefined) return codingDefault(part);
  const saved = RecordSchema.safeParse(data);
  return saved.success ? saved.data.mode : "off";
}

export const codingOn = (store: Pick<Store, "get">, owner: string, part: CodingPart): boolean =>
  codingMode(store, owner, part) !== "off";

/** Saves a switch, keeping the part's other settings in the same record. */
export function saveCodingMode(store: Store, owner: string, part: CodingPart, mode: CodingMode): CodingMode {
  const current = (store.get("settings", owner, codingKey(part))?.data ?? {}) as Record<string, unknown>;
  store.save("settings", owner, codingKey(part), { ...current, mode: ModeSchema.parse(mode) });
  return mode;
}

export class CodingOffError extends Error {
  override name = "CodingOffError";
}

/** Throws the one plain sentence a switched-off part answers with. */
export function requireCoding(store: Pick<Store, "get">, owner: string, part: CodingPart): void {
  if (codingMode(store, owner, part) === "off")
    throw new CodingOffError(`${codingLabels[part]} is switched off. The owner can switch it on in Settings.`);
}

/** A part's own settings (beside its switch), read through a schema with defaults. */
export function partSettings<T>(store: Pick<Store, "get">, owner: string, part: CodingPart, schema: z.ZodType<T>): T {
  const { mode: _mode, ...rest } = (store.get("settings", owner, codingKey(part))?.data ?? {}) as Record<string, unknown>;
  const saved = schema.safeParse(rest);
  return saved.success ? saved.data : schema.parse({});
}

/** Saves a part's own settings, keeping its switch as it is. */
export function savePartSettings<T extends object>(store: Store, owner: string, part: CodingPart, schema: z.ZodType<T>, input: unknown): T {
  const value = schema.parse(input ?? {});
  store.save("settings", owner, codingKey(part), { ...value, mode: codingMode(store, owner, part) });
  return value;
}

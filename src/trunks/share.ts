import { z } from "zod";
import { pick, TrunkSchema, type Trunk, type TrunkFields } from "./record.js";

/**
 * R17-013 (T-14): a Trunk as one file, to keep or to give to somebody else.
 *
 * The file holds what the Trunk *is* — its name, role, picture, model, instructions, style and
 * lists — and never what it holds: no conversation, no memory, no keys or account choices, and no
 * reach. A Trunk brought in from a file therefore starts with every reach switch off and the
 * owner's own keys, whoever wrote the file. Sharing through a git source is a later step (R17-083).
 */
export const trunkFileFormat = "branch-trunk/1";

export const TrunkFileSchema = z.object({
  format: z.literal(trunkFileFormat),
  exportedAt: z.string().max(40),
  trunk: TrunkSchema.omit({ keys: true, reach: true, hidden: true, section: true, pinned: true, order: true }),
}).strict();
export type TrunkFile = z.infer<typeof TrunkFileSchema>;

export function exportTrunk(trunk: Trunk): TrunkFile {
  const { keys: _keys, reach: _reach, hidden: _hidden, section: _section, pinned: _pinned, order: _order, ...shared } = pick(trunk);
  return { format: trunkFileFormat, exportedAt: new Date().toISOString(), trunk: shared };
}

/** The fields a file brings in, checked, with everything it may not carry set back to off. */
export function importedFields(input: unknown): TrunkFields {
  const file = TrunkFileSchema.parse(input);
  return TrunkSchema.parse({ ...file.trunk, keys: { copyFromOwner: true, accounts: {} }, reach: { channels: [], commands: false } });
}

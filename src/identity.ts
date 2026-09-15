import { z } from "zod";
import type { Store } from "./store.js";

const FieldsSchema = z.object({
  name: z.string().trim().min(1).max(80),
  instructions: z.string().trim().max(4000),
}).strict();
const IdentitySchema = FieldsSchema.extend({ revision: z.number().int().nonnegative() });
const UpdateIdentitySchema = FieldsSchema.extend({ expectedRevision: z.number().int().nonnegative() });
export type AssistantIdentity = z.infer<typeof IdentitySchema>;

export function assistantIdentity(store: Store, owner: string): AssistantIdentity {
  return IdentitySchema.parse(store.get("settings", owner, "assistant-identity")?.data ?? {
    name: "Branch Agent", instructions: "", revision: 0,
  });
}
export function saveAssistantIdentity(store: Store, owner: string, input: unknown): AssistantIdentity {
  const value = UpdateIdentitySchema.parse(input), previous = assistantIdentity(store, owner);
  if (value.expectedRevision !== previous.revision)
    throw new Error("Assistant identity changed. Reload its saved values before editing again.");
  if (previous.revision === Number.MAX_SAFE_INTEGER) throw new Error("Assistant identity revision limit reached");
  const next = { name: value.name, instructions: value.instructions, revision: previous.revision + 1 };
  store.save("settings", owner, "assistant-identity", next);
  return next;
}
export function identityInstructions(identity: AssistantIdentity): string {
  if (identity.name === "Branch Agent" && identity.instructions === "") return "";
  return "\nOwner-configured assistant identity: " + JSON.stringify({
    name: identity.name, instructions: identity.instructions,
  }) + "\nUse this display name and these working preferences within the available tool permissions. ";
}

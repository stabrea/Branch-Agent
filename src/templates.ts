import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { Knowledge } from "./knowledge.js";
import type { Store } from "./store.js";
import { scanSkill, describeFindings } from "./skill-scan.js";

/**
 * Templates carry a specialist's or recipe's definition between installs: the instructions, tool
 * requirements, checks and parameters, never ids, evidence, history or anything that looks like a
 * secret. Importing creates a fresh proposal that still has to be evaluated or verified here.
 */
export const TemplateSchema = z.object({
  format: z.literal("branch-agent-template"),
  version: z.literal(1),
  kind: z.enum(["specialist", "procedure"]),
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
  definition: z.record(z.string(), z.unknown()),
}).strict();
export type Template = z.infer<typeof TemplateSchema>;

/** Refuses a template body that carries a pasted key or similar. */
function assertNoSecrets(definition: unknown, direction: "export" | "import"): void {
  const findings = scanSkill(JSON.stringify(definition, null, 1)).filter((f) => f.kind === "secret");
  if (findings.length) throw new Error(`The template was not ${direction}ed because it ${describeFindings(findings)}. Templates never carry secrets; use the secrets locker and refer to names instead.`);
}

export function exportTemplate(store: Store, owner: string, kind: Template["kind"], id: string, description = ""): Template {
  const record = store.get(kind === "specialist" ? "specialists" : "procedures", owner, id);
  if (!record) throw new Error(`No ${kind} with that id`);
  const { id: _id, ...definition } = record.data.definition as Record<string, unknown> & { id?: string };
  void _id;
  assertNoSecrets(definition, "export");
  return { format: "branch-agent-template", version: 1, kind, name: String(definition.name ?? kind), description: description.slice(0, 500), definition };
}

/** Creates a new proposed specialist or recipe from a template; permissions and checks are validated as usual. */
export function importTemplate(knowledge: Knowledge, context: ToolContext, input: unknown) {
  const template = TemplateSchema.parse(input);
  assertNoSecrets(template.definition, "import");
  const definition = { ...template.definition };
  delete definition.id;
  return template.kind === "specialist" ? knowledge.proposeSpecialist(context, definition) : knowledge.proposeProcedure(context, definition);
}

import { z } from "zod";

/**
 * Parameterised recipes: a recipe declares named inputs, a run binds values to them before any
 * step executes (missing required inputs, wrong types and unknown names are refused up front), and
 * `{{name}}` placeholders in step arguments, expectations and preconditions take the bound values.
 */
export const ParameterSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean().default(true),
  description: z.string().max(300).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).strict();
export const ParametersSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Parameter names use lowercase letters, digits and underscores"), ParameterSchema);
export type Parameters = z.infer<typeof ParametersSchema>;
export type InputValue = string | number | boolean;
export const InputsSchema = z.record(z.string().max(40), z.union([z.string().max(4000), z.number(), z.boolean()]));

/** Binds inputs to a recipe's parameters, applying defaults; every problem is reported before anything runs. */
export function bindInputs(parameters: Parameters, inputs: Record<string, InputValue> = {}): Record<string, InputValue> {
  const problems: string[] = [];
  const bound: Record<string, InputValue> = {};
  for (const name of Object.keys(inputs)) if (!(name in parameters)) problems.push(`"${name}" is not an input of this recipe`);
  for (const [name, spec] of Object.entries(parameters)) {
    const given = inputs[name] ?? spec.default;
    if (given === undefined) { if (spec.required) problems.push(`"${name}" is required`); continue; }
    if (typeof given !== spec.type) { problems.push(`"${name}" must be a ${spec.type}`); continue; }
    bound[name] = given;
  }
  if (problems.length) throw new Error(`Recipe inputs were not accepted: ${problems.join("; ")}`);
  return bound;
}

/** Replaces {{name}} placeholders: a string that is exactly one placeholder takes the typed value; otherwise text is interpolated. */
/**
 * A placeholder name: `name`, or a dotted path such as `field.path` (src/triggers.ts flattens a
 * payload into such keys). A path is looked up as one whole key, never walked, so nothing inherited
 * (`constructor`, `__proto__`) is ever reached.
 */
const placeholderName = String.raw`[a-z][a-z0-9_]*(?:\.[A-Za-z0-9_-]+)*`;
const wholePlaceholder = new RegExp(String.raw`^\{\{\s*(${placeholderName})\s*\}\}$`);
const anyPlaceholder = () => new RegExp(String.raw`\{\{\s*(${placeholderName})\s*\}\}`, "g");
function boundValue(bound: Record<string, InputValue>, name: string): InputValue {
  if (!Object.hasOwn(bound, name)) throw new Error(`Recipe placeholder "${name}" has no bound input`);
  return bound[name]!;
}
export function substitute<T>(value: T, bound: Record<string, InputValue>): T {
  if (typeof value === "string") {
    const whole = wholePlaceholder.exec(value);
    if (whole) return boundValue(bound, whole[1]!) as unknown as T;
    return value.replace(anyPlaceholder(), (_, name: string) => String(boundValue(bound, name))) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, bound)) as unknown as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v, bound)])) as unknown as T;
  return value;
}

/** Placeholder names a recipe definition refers to, so undeclared ones can be refused when it is proposed. */
export function placeholders(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") for (const match of value.matchAll(anyPlaceholder())) found.add(match[1]!);
  else if (Array.isArray(value)) for (const entry of value) placeholders(entry, found);
  else if (value && typeof value === "object") for (const entry of Object.values(value as Record<string, unknown>)) placeholders(entry, found);
  return found;
}

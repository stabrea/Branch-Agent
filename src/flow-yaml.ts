import { isNode, parseDocument, stringify, visit, type Document } from "yaml";
import { z } from "zod";
import type { FlowView, GraphFlowView } from "./flows.js";

/**
 * Bucket 21 (serialization): a saved flow written out as YAML, and a YAML file read back as a flow.
 *
 * The editor keeps saving JSON; this is the same flow in a form a person can write by hand, keep in
 * a folder of their own, and send to somebody else. Nothing here decides what a good flow is: the
 * text is only turned into the object the flow editor would have sent, and saving it goes through
 * the same checks (`Flows.save`) as any other flow. A flow read back is always saved as a new flow,
 * so a file can never overwrite one already here.
 */
export const flowYamlFormat = "branch-flow/1";
/** Large enough for the biggest flow the schemas allow (40 boxes, 80 arrows, long prompts). */
export const flowYamlLimit = 512 * 1024;

export class FlowYamlError extends Error {}

export const FlowYamlImportSchema = z.object({ yaml: z.string().min(1).max(flowYamlLimit) }).strict();

const isGraph = (flow: FlowView): flow is GraphFlowView => (flow as GraphFlowView).kind === "graph";

/** What a saved flow is, without anything that belongs to this computer (its id, where it got to). */
function portable(flow: FlowView): Record<string, unknown> {
  if (isGraph(flow)) {
    const { id: _id, ...definition } = flow.definition;
    return { format: flowYamlFormat, kind: "graph", ...definition };
  }
  return { format: flowYamlFormat, kind: "steps", name: flow.name, description: flow.description, steps: flow.steps };
}

/** One saved flow as YAML text, with a comment line saying what the file is. */
export function flowToYaml(flow: FlowView): string {
  const body = stringify(portable(flow), { lineWidth: 0, aliasDuplicateObjects: false });
  return `# A Branch Agent flow. Read it back in Flows, or with POST /api/flows/yaml.\n${body}`;
}

/** Integration review: names that reach an object's insides are never a flow's own words. */
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);

/** Refuses an explicit tag (!!binary, !!set, !foo) or an anchor anywhere in the file. */
function refuseTagsAndAnchors(document: Document): void {
  visit(document, (_key, node) => {
    if (!isNode(node)) return;
    if (node.tag) throw new FlowYamlError(`A flow file may not mark a value with a tag (${node.tag}); write the value plainly.`);
    if (node.anchor) throw new FlowYamlError("A flow file may not name a part with an anchor (&) or repeat it by reference (YAML aliases).");
  });
}

/** Refuses object-insides keys at any depth, and numbers that cannot be kept exactly. */
function refuseUnsafeValues(value: unknown): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
      throw new FlowYamlError(`A flow file may only hold ordinary numbers; ${String(value)} is too large or not a number.`);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (unsafeKeys.has(key)) throw new FlowYamlError(`A flow file may not use "${key}" as a name.`);
    refuseUnsafeValues((value as Record<string, unknown>)[key]);
  }
}

function readYaml(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, "utf8") > flowYamlLimit)
    throw new FlowYamlError("That flow file is too large (at most 512 KB).");
  // No aliases, no duplicate keys, no tags: the file is data and is read as nothing more.
  const document = parseDocument(text, { strict: true, uniqueKeys: true, schema: "core", resolveKnownTags: false });
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem) throw new FlowYamlError(`That file is not readable YAML: ${problem.message.split("\n")[0]}`);
  refuseTagsAndAnchors(document);
  let value: unknown;
  try { value = document.toJS({ maxAliasCount: 0 }); } catch {
    throw new FlowYamlError("A flow file may not repeat a part by reference (YAML aliases); write each part out.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FlowYamlError("A flow file holds one flow: its name, and its steps or its boxes and arrows.");
  refuseUnsafeValues(value);
  return value as Record<string, unknown>;
}

/**
 * The flow a YAML file describes, shaped as the flow editor would send it. A file without the
 * format line is accepted when it is plainly one or the other kind; a different format is refused.
 */
export function flowFromYaml(text: string): Record<string, unknown> {
  const { format, kind, id: _id, ...rest } = readYaml(text);
  if (format !== undefined && format !== flowYamlFormat)
    throw new FlowYamlError(`This file says it is "${String(format)}"; Branch reads "${flowYamlFormat}".`);
  const shape = kind ?? (Array.isArray(rest.edges) ? "graph" : "steps");
  if (shape === "graph") return rest;
  if (shape === "steps") {
    const { name, description, steps, ...extra } = rest;
    if (Object.keys(extra).length)
      throw new FlowYamlError(`A flow of steps has a name, a description and steps; this file also has ${Object.keys(extra).join(", ")}.`);
    return { name, ...(description === undefined ? {} : { description }), steps };
  }
  throw new FlowYamlError(`A flow is of kind "steps" or "graph", not "${String(shape)}".`);
}

import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { detectInjection } from "./content-guard.js";
import { maxToolDescriptionChars } from "./catalog.js";

/**
 * Reading an OpenAPI 3 description of a web service and working out what tools it offers. Only the
 * parts a tool call actually needs are taken: the address, the method, what goes in the path, the
 * query and the body, and a short description. Everything a document says is someone else's text,
 * so descriptions are capped and lines that read like instructions to the assistant are dropped
 * before the model ever sees them — the same treatment a web page gets.
 */
export interface OpenApiParameter { name: string; where: "path" | "query" | "header"; required: boolean; schema: Record<string, unknown> }
export interface OpenApiOperation {
  id: string;
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  summary: string;
  parameters: OpenApiParameter[];
  /** The JSON body's schema, when the operation takes one. */
  body: Record<string, unknown> | null;
  bodyRequired: boolean;
}
export interface OpenApiDocument { title: string; servers: string[]; operations: OpenApiOperation[] }

const methods = ["get", "post", "put", "patch", "delete"] as const;
export const maxOperations = 200;

/** Parses the document, whichever of the two ways it was written. */
export function parseOpenApiText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("That description is empty.");
  const parsed = trimmed.startsWith("{") ? JSON.parse(trimmed) : parseYaml(trimmed);
  if (!parsed || typeof parsed !== "object") throw new Error("That does not read as an OpenAPI description.");
  return parsed as Record<string, unknown>;
}

/** Takes someone else's sentence down to something short and free of orders aimed at the assistant. */
export function safeText(value: unknown, limit = maxToolDescriptionChars): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const clean = detectInjection(text).length ? "" : text;
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/** Everything the document offers, before the owner says which of it may be used. */
export function readOpenApi(source: Record<string, unknown>): OpenApiDocument {
  const version = String(source.openapi ?? "");
  if (!version.startsWith("3.")) throw new Error("Only OpenAPI 3 descriptions can be read here.");
  const info = (source.info ?? {}) as Record<string, unknown>;
  const servers = (Array.isArray(source.servers) ? source.servers : [])
    .map((server) => String((server as { url?: unknown }).url ?? "")).filter(Boolean).slice(0, 5);
  const paths = (source.paths ?? {}) as Record<string, unknown>;
  const operations: OpenApiOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (operations.length >= maxOperations) break;
    const shared = readParameters((item as Record<string, unknown>)?.parameters, source);
    for (const method of methods) {
      const operation = (item as Record<string, unknown>)?.[method] as Record<string, unknown> | undefined;
      if (!operation || operations.length >= maxOperations) continue;
      operations.push(readOperation(source, path, method, operation, shared));
    }
  }
  return { title: safeText(info.title, 120) || "a web service", servers, operations };
}

function readOperation(
  source: Record<string, unknown>, path: string, method: OpenApiOperation["method"],
  operation: Record<string, unknown>, shared: OpenApiParameter[],
): OpenApiOperation {
  const body = jsonBody(source, operation.requestBody);
  return {
    id: String(operation.operationId ?? `${method}${path}`),
    method, path,
    summary: safeText(operation.summary ?? operation.description) || `${method.toUpperCase()} ${path}`,
    parameters: [...shared, ...readParameters(operation.parameters, source)].slice(0, 40),
    body: body.schema, bodyRequired: body.required,
  };
}

function readParameters(value: unknown, source: Record<string, unknown>): OpenApiParameter[] {
  if (!Array.isArray(value)) return [];
  const out: OpenApiParameter[] = [];
  for (const entry of value.slice(0, 40)) {
    const parameter = resolve(source, entry) as Record<string, unknown>;
    const where = String(parameter?.in ?? "");
    const name = String(parameter?.name ?? "");
    if (!name || !["path", "query", "header"].includes(where)) continue;
    out.push({
      name, where: where as OpenApiParameter["where"], required: Boolean(parameter.required),
      schema: (resolve(source, parameter.schema) as Record<string, unknown>) ?? { type: "string" },
    });
  }
  return out;
}

function jsonBody(source: Record<string, unknown>, value: unknown): { schema: Record<string, unknown> | null; required: boolean } {
  const body = resolve(source, value) as Record<string, unknown> | undefined;
  const content = (body?.content ?? {}) as Record<string, unknown>;
  const json = (content["application/json"] ?? content["application/json; charset=utf-8"]) as Record<string, unknown> | undefined;
  if (!json?.schema) return { schema: null, required: false };
  return { schema: (resolve(source, json.schema) as Record<string, unknown>) ?? null, required: Boolean(body?.required) };
}

/** Follows a `$ref` back into the document itself; anything pointing elsewhere is left alone. */
export function resolve(source: Record<string, unknown>, node: unknown, depth = 0): unknown {
  const reference = (node as { $ref?: unknown } | null)?.$ref;
  if (typeof reference !== "string" || !reference.startsWith("#/") || depth > 8) return node;
  let current: unknown = source;
  for (const step of reference.slice(2).split("/")) {
    const key = step.replace(/~1/g, "/").replace(/~0/g, "~");
    current = current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
  }
  return resolve(source, current, depth + 1);
}

/** The schema keywords a tool call can act on, kept; everything else in the document is dropped. */
export function schemaFromDocument(source: Record<string, unknown>, node: unknown, depth = 0): Record<string, unknown> {
  const resolved = resolve(source, node) as Record<string, unknown> | undefined;
  if (!resolved || typeof resolved !== "object" || depth > 6) return { type: "string" };
  const out: Record<string, unknown> = {};
  const type = resolved.type;
  if (typeof type === "string") out.type = type;
  const summary = safeText(resolved.description, 120);
  if (summary) out.description = summary;
  if (Array.isArray(resolved.enum)) out.enum = resolved.enum.slice(0, 40);
  if (type === "array") out.items = schemaFromDocument(source, resolved.items, depth + 1);
  if (resolved.properties && typeof resolved.properties === "object") {
    const properties: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(resolved.properties as Record<string, unknown>).slice(0, 40))
      properties[name] = schemaFromDocument(source, child, depth + 1);
    out.type = "object";
    out.properties = properties;
    if (Array.isArray(resolved.required)) out.required = resolved.required.filter((name) => typeof name === "string").slice(0, 40);
  }
  return Object.keys(out).length ? out : { type: "string" };
}

/** The whole call shape as one JSON schema: path and query values, plus the body when there is one. */
export function operationSchema(source: Record<string, unknown>, operation: OpenApiOperation): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of operation.parameters) {
    properties[parameter.name] = schemaFromDocument(source, parameter.schema);
    if (parameter.required) required.push(parameter.name);
  }
  if (operation.body) {
    properties.body = schemaFromDocument(source, operation.body);
    if (operation.bodyRequired) required.push("body");
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** A tool name the registry will accept, made from an operation id that may be written any way. */
export function toolNameFor(group: string, id: string): string {
  const slug = id.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `api.${group}.${(slug || "call").slice(0, 50)}`;
}

/** A zod schema that accepts whatever the document's own schema describes, loosely but safely. */
export const OperationArgsSchema = z.record(
  z.string().max(100),
  z.union([z.string().max(8000), z.number(), z.boolean(), z.null(), z.array(z.unknown()).max(200), z.record(z.string(), z.unknown())]),
);

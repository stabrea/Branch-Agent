import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import type { NetworkPolicy } from "./network-policy.js";
import { scrubSecrets } from "./locker.js";
import { bindInputs, type InputValue, type Parameters } from "./recipes.js";
import type { HttpTool } from "./skill-package.js";

/**
 * Declarative web calls a skill package brings with it. The package says which address to call and
 * which of the owner's saved secrets to send as a header; the value of that secret is fetched at
 * the moment of the call, never written to the task's record and never shown to the model. Every
 * address goes through the same network rules as the rest of the assistant, and only the fields
 * the package listed are kept from the answer.
 */
export const httpToolPermission = "skills.http";
const maxAnswerBytes = 64 * 1024, secretPattern = /\{\{secret:([A-Z][A-Z0-9_]{0,63})\}\}/g;
export interface HttpToolHost { store: Store; policy: NetworkPolicy; fetchImpl?: typeof fetch }

/** Turns a package's declared inputs into the schema the tool registry validates calls against. */
export function schemaFor(parameters: Parameters): z.ZodType<Record<string, InputValue>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, spec] of Object.entries(parameters)) {
    const base = spec.type === "number" ? z.number() : spec.type === "boolean" ? z.boolean() : z.string().max(2000);
    shape[name] = spec.required && spec.default === undefined ? base : base.optional();
  }
  return z.object(shape).strict() as unknown as z.ZodType<Record<string, InputValue>>;
}

/** The secret names a tool refers to, so the owner can be told before anything is installed. */
export function secretsUsed(tool: HttpTool): string[] {
  const text = [tool.url, ...Object.values(tool.headers), ...Object.values(tool.body)].join("\n");
  return [...new Set([...text.matchAll(secretPattern)].map((match) => match[1]!))];
}

function fillText(template: string, bound: Record<string, InputValue>, encode: boolean): string {
  return template.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, name: string) => {
    if (!(name in bound)) throw new Error(`This tool needs a value for "${name}"`);
    const value = String(bound[name]);
    return encode ? encodeURIComponent(value) : value;
  });
}
function fillSecrets(template: string, values: Record<string, string>): string {
  return template.replace(secretPattern, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`The secret ${name} is not saved in this project`);
    return value;
  });
}
/** Keeps only the fields the package listed, so an answer cannot smuggle extra content into the task. */
export function pickFields(body: unknown, paths: string[]): unknown {
  if (!paths.length) return body;
  const picked: Record<string, unknown> = {};
  for (const path of paths) {
    let value: unknown = body;
    for (const step of path.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[step] : undefined;
    if (value !== undefined) picked[path] = value;
  }
  return picked;
}

/** Reads the answer, refusing an oversized one before the whole body is held in memory. */
async function readAnswer(response: Response, host: string): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxAnswerBytes) throw new Error(`${host} sent back more than this tool accepts`);
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxAnswerBytes) { await reader.cancel(); throw new Error(`${host} sent back more than this tool accepts`); }
    parts.push(value);
  }
  return Buffer.concat(parts.map((part) => Buffer.from(part))).toString("utf8");
}

async function callTool(host: HttpToolHost, tool: HttpTool, args: Record<string, InputValue>, context: ToolContext, enabled?: () => boolean): Promise<unknown> {
  if (enabled && !enabled()) throw new Error(`The skill that brought "${tool.name}" is switched off, so it did not run.`);
  const bound = bindInputs(tool.input, args);
  const target = new URL(fillText(tool.url, bound, true));
  await host.policy.assertAllowed(target, "skill tool address");
  const names = secretsUsed(tool);
  const secrets = names.length ? await host.store.locker.resolve(context.owner, host.store.projects.active(context.owner).id, names) : {};
  const headers: Record<string, string> = { accept: "application/json" };
  for (const [name, value] of Object.entries(tool.headers)) headers[name] = fillSecrets(fillText(value, bound, false), secrets);
  const body = tool.method === "POST"
    ? JSON.stringify(Object.fromEntries(Object.entries(tool.body).map(([k, v]) => [k, fillSecrets(fillText(v, bound, false), secrets)]))) : undefined;
  if (body) headers["content-type"] = "application/json";
  const started = Date.now();
  const response = await (host.fetchImpl ?? globalThis.fetch)(target, { method: tool.method, headers, ...(body ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(20000) });
  const text = await readAnswer(response, target.host);
  if (context.runId) host.store.event(context.runId, "skill.tool_called", { tool: tool.name, method: tool.method, host: target.host, path: target.pathname, status: response.status, ms: Date.now() - started, secrets: names });
  if (!response.ok) throw new Error(`${target.host} answered with HTTP ${response.status}`);
  // Parsing failures are reported without the text that failed: an answer can hold a secret we sent.
  let parsed: unknown = text.slice(0, 8000);
  if (text.trim().startsWith("{") || text.trim().startsWith("["))
    try { parsed = JSON.parse(text); } catch { throw new Error(`${target.host} answered with something that is not the JSON this tool expects`); }
  const result = { status: response.status, data: pickFields(parsed, tool.pick) };
  return JSON.parse(scrubSecrets(JSON.stringify(result), secrets)) as unknown;
}

/**
 * Registers one package's declared calls; the name is prefixed so a package cannot claim a built-in
 * name. `enabled` is asked at the moment of a call, so a switched-off skill's calls do not run. If
 * any name is taken the ones already added are taken back out, so a half-registered package is
 * never left behind.
 */
export function registerHttpTools(registry: ToolRegistry, host: HttpToolHost, packageName: string, tools: HttpTool[], enabled?: () => boolean): string[] {
  const registered: string[] = [];
  try {
    for (const tool of tools) {
      const name = `skill.${packageName}.${tool.name}`;
      registry.register({
        name, description: tool.description, permission: httpToolPermission, parameters: schemaFor(tool.input),
        execute: async (args, context) => callTool(host, tool, args, context, enabled),
        target: () => new URL(tool.url.replace(/\{\{[a-z0-9_]*\}\}/g, "x")).host,
      });
      registered.push(name);
    }
  } catch (error) {
    for (const name of registered) registry.unregister(name);
    throw error;
  }
  return registered;
}

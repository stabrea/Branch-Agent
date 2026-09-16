import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolRegistry } from '../registry.js';
import type { ToolDefinition, ToolContext } from '../contracts.js';
import { McpConfigSchema, makeTransport, type McpConfig } from './mcp-config.js';

export const mcpToolName = (id: string, tool: string): string =>
  `mcp.${id}.${createHash('sha256').update(tool).digest('hex').slice(0, 16)}`;

async function discover(client: Client, wanted: string[]): Promise<Tool[]> {
  const found = new Map<string, Tool>(), seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 10000 });
    for (const tool of result.tools) {
      if (JSON.stringify(tool).length > 65536) throw new Error('MCP tool schema is too large');
      if (wanted.includes(tool.name)) found.set(tool.name, tool);
    }
    if (!result.nextCursor) break;
    if (seen.has(result.nextCursor) || page === 9) throw new Error('MCP tool pagination limit');
    seen.add(result.nextCursor); cursor = result.nextCursor;
  }
  if (wanted.some(name => !found.has(name))) throw new Error('Configured MCP tool is unavailable');
  return [...found.values()];
}

function clean(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > 20) throw new Error('MCP result nesting exceeds limit');
  if (typeof value === 'string')
    return secrets.reduce((text, secret) => text.split(secret).join('[credential redacted]'), value);
  if (Array.isArray(value)) return value.map(item => clean(item, secrets, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (secrets.some(secret => key.includes(secret))) throw new Error('MCP metadata contains a credential');
    return [key, clean(item, secrets, depth + 1)];
  }));
  return value;
}

function redact(result: unknown, secrets: string[]): unknown {
  if (Buffer.byteLength(JSON.stringify(result)) > 60000) throw new Error('MCP output exceeds 60 KiB');
  return clean(result, secrets);
}

/**
 * How one of a server's tools is actually called. With the server already connected this is the
 * client it was connected with; on demand it is a function that opens the connection first, so a
 * tool can sit in the list long before anything has been started.
 */
type CallThrough = (tool: string, args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;

const through = (client: Client): CallThrough =>
  (tool, args, context) => client.callTool({ name: tool, arguments: args }, undefined,
    { signal: context.signal, timeout: 30000 });

function definition(call: CallThrough, config: McpConfig, tool: Tool, secrets: string[]): ToolDefinition {
  if (JSON.stringify(redact(tool, secrets)) !== JSON.stringify(tool))
    throw new Error('MCP discovery contains a configured credential');
  const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema as JsonSchemaType);
  const name = mcpToolName(config.id, tool.name);
  return { name, description: tool.description?.slice(0, 2000) ?? tool.name, external: true,
    permission: name, parameters: z.record(z.string(), z.unknown()), inputSchema: tool.inputSchema,
    execute: async (args: unknown, context: ToolContext) => {
      if (!validate(args).valid) throw new Error('MCP arguments do not match the configured tool schema');
      try {
        const result = await call(tool.name, args as Record<string, unknown>, context) as { isError?: boolean };
        if (result.isError) throw new Error('Remote tool reported failure');
        return redact(result, secrets);
      } catch {
        context.signal.throwIfAborted();
        throw new Error('MCP tool failed; inspect the configured server locally');
      }
    } };
}

/** What a connected server said its tools are, kept so they can be listed without connecting. */
export interface CachedMcpTool { name: string; description: string; inputSchema: unknown }
export interface McpToolCache {
  read(id: string): CachedMcpTool[];
  write(id: string, tools: CachedMcpTool[]): void;
}
const cacheable = (tools: Tool[]): CachedMcpTool[] =>
  tools.map(tool => ({ name: tool.name, description: tool.description?.slice(0, 2000) ?? tool.name,
    inputSchema: tool.inputSchema }));

/**
 * Puts a server's tools in the list without starting it. They come from what that server said the
 * last time it was connected, so the assistant can find them and the owner can see them; the
 * connection is opened the first time one of them is actually called, and the list is written down
 * again as soon as it is. A server nobody has ever connected has nothing to list, so this gives
 * back an empty list and the caller connects it the ordinary way instead.
 */
export function registerCachedMcp(
  registry: ToolRegistry, input: unknown, cached: readonly CachedMcpTool[],
  open: () => Promise<{ call: CallThrough }>,
): string[] {
  const config = McpConfigSchema.parse(input);
  const wanted = config.tools
    .map(name => cached.find(tool => tool.name === name))
    .filter((tool): tool is CachedMcpTool => tool !== undefined);
  if (wanted.length !== config.tools.length) return [];
  let opened: Promise<{ call: CallThrough }> | undefined;
  const call: CallThrough = async (name, args, context) => (await (opened ??= open())).call(name, args, context);
  const names: string[] = [];
  for (const tool of wanted) {
    const made = definition(call, config, tool as unknown as Tool, []);
    registry.register(made);
    names.push(made.name);
  }
  return names;
}

/**
 * Opens a server and asks it what its tools are, without putting anything in the tool list. This
 * is what the on-demand path uses: the tools are already listed from what the server said last
 * time, so all that is wanted here is a way to call them, and a fresh list to write down.
 */
export async function openMcp(
  input: unknown, env = process.env,
  policy?: { guard(base: typeof fetch): typeof fetch }, cache?: McpToolCache,
) {
  const config = McpConfigSchema.parse(input);
  if (new Set(config.tools).size !== config.tools.length) throw new Error('Duplicate MCP tool allowlist entry');
  const { transport, secrets } = makeTransport(config, env, policy);
  const client = new Client({ name: 'branch', version: '0.1.0' });
  try {
    // SDK 1.x transport declarations disagree on optional sessionId under exact optional types.
    await client.connect(transport as Transport, { timeout: 10000 });
    if (client.getServerVersion()?.version !== config.expectedVersion)
      throw new Error('MCP server version changed; review compatibility before enabling');
    const found = await discover(client, config.tools);
    // What it has just said its tools are, so a later launch can list them without starting it.
    cache?.write(config.id, cacheable(found));
    return { config, found, secrets, call: through(client), close: () => client.close() };
  } catch {
    await client.close().catch(() => undefined);
    throw new Error('MCP connection failed: check server availability, version, tool allowlist and metadata');
  }
}

export async function connectMcp(
  registry: ToolRegistry, input: unknown, env = process.env,
  policy?: { guard(base: typeof fetch): typeof fetch }, cache?: McpToolCache,
) {
  const opened = await openMcp(input, env, policy, cache);
  try {
    const definitions = opened.found.map(tool => definition(opened.call, opened.config, tool, opened.secrets));
    const existing = new Set(registry.descriptions(new Set(registry.permissions())).map(tool => tool.name));
    if (definitions.some(tool => existing.has(tool.name))) throw new Error('MCP tool name collision');
    for (const tool of definitions) registry.register(tool);
    return { id: opened.config.id, version: opened.config.expectedVersion,
      tools: definitions.map(tool => tool.name), call: opened.call, close: opened.close };
  } catch {
    await opened.close().catch(() => undefined);
    throw new Error('MCP connection failed: check server availability, version, tool allowlist and metadata');
  }
}

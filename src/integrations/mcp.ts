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

function definition(client: Client, config: McpConfig, tool: Tool, secrets: string[]): ToolDefinition {
  if (JSON.stringify(redact(tool, secrets)) !== JSON.stringify(tool))
    throw new Error('MCP discovery contains a configured credential');
  const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema as JsonSchemaType);
  const name = mcpToolName(config.id, tool.name);
  return { name, description: tool.description?.slice(0, 2000) ?? tool.name,
    permission: name, parameters: z.record(z.string(), z.unknown()), inputSchema: tool.inputSchema,
    execute: async (args: unknown, context: ToolContext) => {
      if (!validate(args).valid) throw new Error('MCP arguments do not match the configured tool schema');
      try {
        const result = await client.callTool({ name: tool.name, arguments: args as Record<string, unknown> },
          undefined, { signal: context.signal, timeout: 30000 });
        if (result.isError) throw new Error('Remote tool reported failure');
        return redact(result, secrets);
      } catch {
        context.signal.throwIfAborted();
        throw new Error('MCP tool failed; inspect the configured server locally');
      }
    } };
}

export async function connectMcp(registry: ToolRegistry, input: unknown, env = process.env) {
  const config = McpConfigSchema.parse(input);
  if (new Set(config.tools).size !== config.tools.length) throw new Error('Duplicate MCP tool allowlist entry');
  const { transport, secrets } = makeTransport(config, env);
  const client = new Client({ name: 'branch', version: '0.1.0' });
  try {
    // SDK 1.x transport declarations disagree on optional sessionId under exact optional types.
    await client.connect(transport as Transport, { timeout: 10000 });
    if (client.getServerVersion()?.version !== config.expectedVersion)
      throw new Error('MCP server version changed; review compatibility before enabling');
    const definitions = (await discover(client, config.tools)).map(tool => definition(client, config, tool, secrets));
    const existing = new Set(registry.descriptions(new Set(registry.permissions())).map(tool => tool.name));
    if (definitions.some(tool => existing.has(tool.name))) throw new Error('MCP tool name collision');
    for (const tool of definitions) registry.register(tool);
    return { id: config.id, version: config.expectedVersion, tools: definitions.map(tool => tool.name),
      close: () => client.close() };
  } catch {
    await client.close().catch(() => undefined);
    throw new Error('MCP connection failed: check server availability, version, tool allowlist and metadata');
  }
}

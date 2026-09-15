import { z } from 'zod';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boundedFetch } from './bounded-fetch.js';

const common = {
  id: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/),
  tools: z.array(z.string().min(1).max(200)).min(1).max(64),
  expectedVersion: z.string().min(1).max(100),
};
export const McpConfigSchema = z.discriminatedUnion('transport', [
  z.object({ ...common, transport: z.literal('stdio'), command: z.string().min(1),
    args: z.array(z.string()).max(40).default([]), cwd: z.string().optional(),
    envKeys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(20).default([]) }).strict(),
  z.object({ ...common, transport: z.literal('http'), url: z.string().url(),
    bearerEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional() }).strict(),
]);
export type McpConfig = z.infer<typeof McpConfigSchema>;

function credential(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing configured MCP environment variable: ${name}`);
  return value;
}

export function makeTransport(config: McpConfig, env: NodeJS.ProcessEnv) {
  if (config.transport === 'stdio') {
    const selected = Object.fromEntries(config.envKeys.map(key => [key, credential(env, key)]));
    const transport = new StdioClientTransport({ command: config.command, args: config.args,
      env: { ...getDefaultEnvironment(), ...selected }, stderr: 'pipe', maxBufferSize: 1048576,
      ...(config.cwd ? { cwd: config.cwd } : {}) });
    transport.stderr?.on('data', () => undefined);
    return { transport, secrets: Object.values(selected) };
  }
  const url = new URL(config.url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new Error('MCP endpoint requires HTTPS or loopback HTTP');
  if (url.username || url.password || url.search || url.hash)
    throw new Error('MCP URL must not contain credentials, query, or fragment');
  const secret = config.bearerEnv ? credential(env, config.bearerEnv) : undefined;
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: boundedFetch,
    requestInit: { redirect: 'error', ...(secret ? { headers: { authorization: `Bearer ${secret}` } } : {}) },
  });
  return { transport, secrets: secret ? [secret] : [] };
}

import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import { McpConfigSchema } from './mcp-config.js';
import { connectMcp } from './mcp.js';
import { BranchBrowser, BrowserConfigSchema, registerBrowser } from './browser.js';
import { ShellConfigSchema } from './shell-config.js';
import { BranchShell, registerShell } from './shell.js';

const ConfigSchema = z.object({ mcp: z.array(McpConfigSchema).max(8).default([]),
  browser: BrowserConfigSchema.optional(), shell: ShellConfigSchema.optional() }).strict();

export async function loadIntegrations(registry: ToolRegistry, path?: string, env = process.env) {
  const closers: (() => Promise<void>)[] = [];
  const close = async () => {
    const results = await Promise.allSettled(closers.map(stop => stop()));
    const errors = results.filter(result => result.status === 'rejected');
    if (errors.length) throw new Error(`Failed to close ${errors.length} integration(s)`);
  };
  if (!path) return { close, count: 0 };
  const info = await stat(path);
  if (!info.isFile() || info.size > 65536) throw new Error('Integration config must be a file of at most 64 KiB');
  const config = ConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (new Set(config.mcp.map(server => server.id)).size !== config.mcp.length)
    throw new Error('MCP server IDs must be unique');
  try {
    for (const server of config.mcp) {
      const connection = await connectMcp(registry, server, env);
      closers.push(connection.close);
    }
    if (config.browser) {
      const browser = new BranchBrowser(config.browser);
      registerBrowser(registry, browser); closers.push(() => browser.close());
    }
    if (config.shell) {
      const shell = new BranchShell(config.shell, env);
      await shell.ready();
      registerShell(registry, shell); closers.push(() => shell.close());
    }
    return { close, count: closers.length };
  } catch (error) { await close().catch(() => undefined); throw error; }
}

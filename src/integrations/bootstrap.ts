import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import { McpConfigSchema } from './mcp-config.js';
import { connectMcp } from './mcp.js';
import { BranchBrowser, BrowserConfigSchema, registerBrowser } from './browser.js';
import { ShellConfigSchema } from './shell-config.js';
import { BranchShell, registerShell, type SecretResolver } from './shell.js';
import { ChannelPolicySchema, type ChannelRouter } from '../channels/router.js';
import { TelegramAdapter } from '../channels/telegram.js';
import { WebConfigSchema, type WebAccess } from './web.js';
import { HookSchema, type Hooks, type HookRunner } from '../hooks.js';
import type { ToolContext } from '../contracts.js';

export const ChannelConfigSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/).default('telegram'),
  type: z.literal('telegram'),
  /** Name of the environment variable that holds the bot token. */
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  /** Name of a secret in the default project's locker that holds the bot token. */
  tokenSecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  apiBase: z.string().url().optional(),
}).merge(ChannelPolicySchema).strict().refine(value => !!value.tokenEnv !== !!value.tokenSecret, 'Give exactly one of tokenEnv or tokenSecret');
export interface ChannelHost { router: ChannelRouter; secret: (name: string) => Promise<string>; web?: WebAccess; hooks?: Hooks; context?: (runId: string) => ToolContext }

const ConfigSchema = z.object({ mcp: z.array(McpConfigSchema).max(8).default([]),
  browser: BrowserConfigSchema.optional(), shell: ShellConfigSchema.optional(),
  channels: z.array(ChannelConfigSchema).max(4).default([]), web: WebConfigSchema.optional(),
  hooks: z.array(HookSchema).max(16).default([]) }).strict();

export async function loadIntegrations(registry: ToolRegistry, path?: string, env = process.env, secrets?: SecretResolver, channels?: ChannelHost) {
  const closers: (() => Promise<void>)[] = [];
  const before = new Set(registry.names());
  const close = async () => {
    for (const name of registry.names()) if (!before.has(name)) registry.unregister(name);
    const results = await Promise.allSettled(closers.map(stop => stop()));
    const errors = results.filter(result => result.status === 'rejected');
    if (errors.length) throw new Error(`Failed to close ${errors.length} integration(s)`);
  };
  if (!path) return { close, count: 0 };
  const info = await stat(path);
  if (!info.isFile() || info.size > 65536) throw new Error('Integration config must be a file of at most 64 KiB');
  const config = ConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (config.web) channels?.web?.configure(config.web);
  const policy = channels?.web?.policy;
  if (new Set(config.mcp.map(server => server.id)).size !== config.mcp.length)
    throw new Error('MCP server IDs must be unique');
  try {
    for (const server of config.mcp) {
      const connection = await connectMcp(registry, server, env, policy);
      closers.push(connection.close);
    }
    if (config.browser) {
      const browser = new BranchBrowser(config.browser);
      browser.policy = policy;
      registerBrowser(registry, browser); closers.push(() => browser.close());
    }
    let shell: BranchShell | undefined;
    if (config.shell) {
      const created = new BranchShell(config.shell, env, secrets);
      shell = created;
      await created.ready();
      registerShell(registry, created); closers.push(() => created.close());
    }
    const hookShell = shell;
    if (config.hooks.length) {
      if (!hookShell || !channels?.hooks || !channels.context) throw new Error('Hooks need the shell integration (their executables come from it) and a launch that can host them');
      const runner: HookRunner = hookRunner(hookShell, channels.context);
      channels.hooks.configure(config.hooks, runner);
    }
    if (config.channels.length && !channels) throw new Error('Channels are configured but this launch cannot host them');
    if (new Set(config.channels.map(channel => channel.id)).size !== config.channels.length) throw new Error('Channel ids must be unique');
    for (const channel of config.channels) {
      const token = channel.tokenEnv ? env[channel.tokenEnv] : await channels!.secret(channel.tokenSecret!);
      if (!token) throw new Error(`Channel ${channel.id} has no bot token; set ${channel.tokenEnv ?? channel.tokenSecret}`);
      const adapter = new TelegramAdapter({ id: channel.id, token, ...(channel.apiBase ? { apiBase: channel.apiBase } : {}) });
      await channels!.router.attach(adapter, { activation: channel.activation, pairing: channel.pairing, allowlist: channel.allowlist });
      closers.push(() => adapter.stop());
    }
    return { close, count: closers.length };
  } catch (error) { await close().catch(() => undefined); throw error; }
}

/** Hooks run through the shell integration's declared executables; a busy shell is retried briefly, then counts as a failure. */
function hookRunner(shell: BranchShell, context: (runId: string) => ToolContext): HookRunner {
  return async (hook, payload) => {
    const scoped = { ...context(String(payload.runId ?? '')), signal: AbortSignal.timeout(hook.timeoutMs + 1000) };
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const result = await shell.execute({ executable: hook.executable, args: [...hook.args, JSON.stringify(payload).slice(0, 4000)], cwd: '.', secrets: [], timeoutMs: hook.timeoutMs }, scoped);
        return result.status === 'completed' ? { ok: true } : { ok: false, error: `${result.status}${result.stderr ? ': ' + result.stderr.slice(0, 200) : ''}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already active/.test(message) || attempt === 3) return { ok: false, error: message };
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    return { ok: false, error: 'busy' };
  };
}

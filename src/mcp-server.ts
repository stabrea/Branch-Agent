import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { Store } from './store.js';
import type { Runtime } from './runtime.js';
import type { Knowledge } from './knowledge.js';
import type { WorkspaceFiles } from './files.js';
import { Budget, type ToolContext } from './contracts.js';

// Protocol version negotiation: prefer 2025-06-18, fallback to 2024-11-05
const PREFERRED_PROTOCOL_VERSION = '2025-06-18';
const FALLBACK_PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface InitializeParams {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: { name: string; version: string };
}

interface McpServerOptions {
  exposedTools: ReadonlySet<string>;
  maxConcurrentCalls: number;
  perClientRateLimit: number;
}

class McpSession {
  readonly id: string = randomBytes(8).toString('hex');
  clientVersion?: string;
  initialized = false;
  callCount = 0;
}

export class McpServer {
  private sessions = new Map<string, McpSession>();
  private globalCallCount = 0;

  constructor(
    readonly registry: ToolRegistry,
    readonly store: Store,
    readonly runtime: Runtime,
    readonly knowledge: Knowledge,
    readonly files: WorkspaceFiles,
    readonly options: McpServerOptions,
  ) {}

  /** Get or create a session for a given session ID. */
  getSession(sessionId?: string): McpSession {
    const id = sessionId ?? randomBytes(8).toString('hex');
    if (!this.sessions.has(id)) {
      this.sessions.set(id, new McpSession());
    }
    return this.sessions.get(id)!;
  }

  /** Handle a JSON-RPC request and return a response or notification. */
  async handle(request: JsonRpcRequest, sessionId?: string): Promise<JsonRpcResponse | JsonRpcNotification | null> {
    const session = this.getSession(sessionId);
    const respond = (result?: unknown, error?: { code: number; message: string; data?: unknown }): JsonRpcResponse => ({
      jsonrpc: '2.0',
      id: request.id,
      ...(error ? { error } : { result: result ?? null }),
    });

    try {
      const params = request.params ?? {};
      if (request.method === 'initialize') {
        return respond(this.initialize(session, params));
      }
      if (request.method === 'ping') {
        return respond();
      }
      if (!session.initialized) {
        return respond(undefined, { code: -32002, message: 'Not initialized' });
      }
      if (request.method === 'tools/list') {
        return respond({ tools: this.listTools(session, params) });
      }
      if (request.method === 'tools/call') {
        return respond(await this.callTool(session, params));
      }
      if (request.method === 'resources/list') {
        return respond({ resources: this.listResources(session) });
      }
      if (request.method === 'resources/read') {
        return respond(await this.readResource(session, params));
      }
      if (request.method === 'prompts/list') {
        return respond({ prompts: this.listPrompts(session) });
      }
      if (request.method === 'prompts/get') {
        return respond(await this.getPrompt(session, params));
      }
      return respond(undefined, { code: -32601, message: 'Method not found' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return respond(undefined, { code: -32603, message: 'Internal error', data: { details: message } });
    }
  }

  private initialize(session: McpSession, params: unknown): unknown {
    const InitializeSchema = z.object({
      protocolVersion: z.string(),
      capabilities: z.record(z.string(), z.unknown()).optional(),
      clientInfo: z.object({ name: z.string(), version: z.string() }),
    }).strict();
    const parsed = InitializeSchema.parse(params);
    const selectedVersion =
      parsed.protocolVersion === PREFERRED_PROTOCOL_VERSION ? PREFERRED_PROTOCOL_VERSION :
      parsed.protocolVersion === FALLBACK_PROTOCOL_VERSION ? FALLBACK_PROTOCOL_VERSION :
      PREFERRED_PROTOCOL_VERSION;

    session.clientVersion = parsed.clientInfo.version;
    session.initialized = true;
    return {
      protocolVersion: selectedVersion,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: 'branch', version: '1.0.0' },
    };
  }

  private listTools(_session: McpSession, _params: unknown): unknown[] {
    // Only list tools in the exposure policy
    return this.registry
      .inventory()
      .filter(t => this.options.exposedTools.has(t.name))
      .map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: {
          type: 'object',
          properties: {} as Record<string, unknown>,
        },
      }));
  }

  private async callTool(session: McpSession, params: unknown): Promise<unknown> {
    this.globalCallCount++;
    session.callCount++;
    if (session.callCount > this.options.perClientRateLimit) {
      throw new Error(`Client rate limit exceeded (${this.options.perClientRateLimit} calls)`);
    }
    if (this.globalCallCount > this.options.maxConcurrentCalls) {
      throw new Error(`Global concurrency limit exceeded`);
    }

    const ToolCallSchema = z.object({
      name: z.string(),
      arguments: z.record(z.string(), z.unknown()).optional(),
    }).strict();
    const parsed = ToolCallSchema.parse(params);
    const toolName = parsed.name;
    const args = parsed.arguments ?? {};

    // Check if tool is exposed
    if (!this.options.exposedTools.has(toolName)) {
      throw new Error(`Tool not exposed: ${toolName}`);
    }

    try {
      const context: ToolContext = {
        owner: this.runtime.owner,
        workspace: this.files.base,
        runId: `mcp-${randomBytes(4).toString('hex')}`,
        signal: new AbortController().signal,
        budget: new Budget({ maxSteps: 5, maxTokens: 8000 }),
        permissions: new Set(['files.read']),
        depth: 0,
      };
      const result = await this.registry.execute(toolName, args, context);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  }

  private listResources(_session: McpSession): unknown[] {
    return [
      { uri: 'memory://facts', name: 'Memory facts', description: 'Recent memory facts' },
      { uri: 'workspace://files', name: 'Workspace files', description: 'Files in the workspace' },
    ];
  }

  private async readResource(session: McpSession, params: unknown): Promise<unknown> {
    const ReadResourceSchema = z.object({ uri: z.string() }).strict();
    const parsed = ReadResourceSchema.parse(params);

    if (parsed.uri === 'memory://facts') {
      const facts = this.store.list('memory', this.runtime.owner);
      return {
        contents: [{ uri: parsed.uri, mimeType: 'application/json', text: JSON.stringify(facts) }],
      };
    }
    if (parsed.uri === 'workspace://files') {
      try {
        const listing = await this.files.list();
        return {
          contents: [{ uri: parsed.uri, mimeType: 'application/json', text: JSON.stringify(listing) }],
        };
      } catch {
        throw new Error('Failed to list workspace');
      }
    }
    throw new Error(`Unknown resource: ${parsed.uri}`);
  }

  private listPrompts(_session: McpSession): unknown[] {
    return [
      { name: 'analyze-memory', description: 'Analyze memory facts for patterns' },
      { name: 'plan-task', description: 'Create a task plan from requirements' },
    ];
  }

  private async getPrompt(session: McpSession, params: unknown): Promise<unknown> {
    const GetPromptSchema = z.object({ name: z.string() }).strict();
    const parsed = GetPromptSchema.parse(params);

    if (parsed.name === 'analyze-memory') {
      return {
        messages: [
          {
            role: 'user',
            content: 'Analyze the memory facts for patterns, themes, and actionable insights. Output a brief summary.',
          },
        ],
      };
    }
    if (parsed.name === 'plan-task') {
      return {
        messages: [
          {
            role: 'user',
            content:
              'Create a detailed plan for the task. Break it into steps with clear success criteria. Consider dependencies and risks.',
          },
        ],
      };
    }
    throw new Error(`Unknown prompt: ${parsed.name}`);
  }
}

export async function startMcpServer(
  registry: ToolRegistry,
  store: Store,
  runtime: Runtime,
  knowledge: Knowledge,
  files: WorkspaceFiles,
  options: Partial<McpServerOptions> = {},
): Promise<McpServer> {
  const defaultOptions: McpServerOptions = {
    exposedTools: new Set(['files.read']),
    maxConcurrentCalls: 10,
    perClientRateLimit: 100,
    ...options,
  };
  return new McpServer(registry, store, runtime, knowledge, files, defaultOptions);
}

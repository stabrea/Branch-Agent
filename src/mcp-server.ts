import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type { Store } from './store.js';
import type { Runtime } from './runtime.js';
import type { Knowledge } from './knowledge.js';
import type { WorkspaceFiles } from './files.js';
import { Budget, errorText, type Message, type ToolContext } from './contracts.js';
import { describeToolCall } from './activity.js';

// Protocol version negotiation: prefer 2025-06-18, fallback to 2024-11-05
const PREFERRED_PROTOCOL_VERSION = '2025-06-18';
const FALLBACK_PROTOCOL_VERSION = '2024-11-05';
const CONVERSATION_LIMIT = 20;
const TRANSCRIPT_BYTES = 64 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** What the owner has chosen to share with other AI tools. */
export const McpSharingSchema = z
  .object({
    enabled: z.boolean().default(false),
    exposedTools: z.array(z.string().min(1).max(100)).max(200).default([]),
    /** Also answer assistants elsewhere over the agent-to-agent protocol, from the same shared list. */
    a2a: z.boolean().default(false),
  })
  .strict();
export type McpSharing = z.infer<typeof McpSharingSchema>;

/** A tool only reads when its permission ends in `.read`; anything else can change things. */
export const toolChangesThings = (permission: string): boolean => !/\.read$/.test(permission);

/** Every tool the owner could offer, with whether picking it lets another tool change things. */
export function shareableTools(registry: ToolRegistry): {
  name: string; description: string; permission: string; changesThings: boolean;
}[] {
  return registry
    .inventory()
    .map((tool) => ({ ...tool, changesThings: toolChangesThings(tool.permission) }))
    .sort((a, b) => Number(a.changesThings) - Number(b.changesThings) || a.name.localeCompare(b.name));
}

/** A conversation transcript as plain `role: text` lines, newest kept, older ones dropped. */
export function transcriptText(messages: Message[]): string {
  const lines: string[] = [];
  let bytes = 0;
  let dropped = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = message.content.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const line = `${message.role}: ${text.length > 4000 ? text.slice(0, 3999) + '…' : text}`;
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > TRANSCRIPT_BYTES) { dropped = true; break; }
    lines.unshift(line);
  }
  if (dropped) lines.unshift('(earlier messages are not included)');
  return lines.join('\n');
}

/** A short readable name for a conversation, taken from its first message. */
export function conversationTitle(preview: string): string {
  const text = preview.replace(/\s+/g, ' ').trim();
  if (!text) return 'Conversation';
  return text.length > 60 ? text.slice(0, 59) + '…' : text;
}

interface McpServerOptions {
  /** Used only until the owner saves a choice in Settings. */
  enabled: boolean;
  exposedTools: ReadonlySet<string>;
  maxConcurrentCalls: number;
  perClientRateLimit: number;
}

class McpSession {
  readonly id: string;
  clientName?: string;
  clientVersion?: string;
  protocolVersion: string = PREFERRED_PROTOCOL_VERSION;
  initialized = false;
  callCount = 0;

  constructor() {
    this.id = randomBytes(8).toString('hex');
  }
}

export class McpServer {
  private sessions = new Map<string, McpSession>();
  private inFlight = 0;

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
    if (!this.sessions.has(id)) this.sessions.set(id, new McpSession());
    return this.sessions.get(id)!;
  }

  /** Delete a session and end its state. */
  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** What the owner is sharing right now; read fresh so a settings change takes effect at once. */
  sharing(): McpSharing {
    const saved = this.store.get('settings', this.runtime.owner, 'mcp-sharing');
    const parsed = saved ? McpSharingSchema.safeParse(saved.data) : undefined;
    if (parsed?.success) return parsed.data;
    return { enabled: this.options.enabled, exposedTools: [...this.options.exposedTools], a2a: false };
  }

  private exposed(): Set<string> {
    const sharing = this.sharing();
    return new Set(sharing.enabled ? sharing.exposedTools : []);
  }

  /** Handle a JSON-RPC request and return the response to send back. */
  async handle(request: JsonRpcRequest, sessionId?: string): Promise<JsonRpcResponse> {
    const session = this.getSession(sessionId);
    const respond = (result?: unknown, error?: JsonRpcResponse['error']): JsonRpcResponse => ({
      jsonrpc: '2.0',
      id: request.id,
      ...(error ? { error } : { result: result ?? null }),
    });
    try {
      const params = request.params ?? {};
      if (request.method === 'initialize') return respond(this.initialize(session, params));
      if (request.method === 'ping') return respond({});
      if (!session.initialized) return respond(undefined, { code: -32002, message: 'Not initialized' });
      const result = await this.dispatch(session, request.method, params);
      if (result === undefined) return respond(undefined, { code: -32601, message: 'Method not found' });
      return respond(result);
    } catch (e) {
      return respond(undefined, { code: -32603, message: 'Internal error', data: { details: errorText(e) } });
    }
  }

  /** Methods that need an initialized session; `undefined` means the method is unknown. */
  private async dispatch(session: McpSession, method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'tools/list': return { tools: this.listTools() };
      case 'tools/call': return this.callTool(session, params);
      case 'resources/list': return { resources: this.listResources() };
      case 'resources/read': return this.readResource(params);
      case 'prompts/list': return { prompts: this.listPrompts() };
      case 'prompts/get': return this.getPrompt(params);
      default: return undefined;
    }
  }

  private initialize(session: McpSession, params: unknown): unknown {
    const InitializeSchema = z.object({
      protocolVersion: z.string(),
      capabilities: z.record(z.string(), z.unknown()).optional(),
      clientInfo: z.object({ name: z.string(), version: z.string() }),
    }).strict();
    const parsed = InitializeSchema.parse(params);
    const selectedVersion = parsed.protocolVersion === FALLBACK_PROTOCOL_VERSION
      ? FALLBACK_PROTOCOL_VERSION
      : PREFERRED_PROTOCOL_VERSION;
    session.clientName = parsed.clientInfo.name;
    session.clientVersion = parsed.clientInfo.version;
    session.protocolVersion = selectedVersion;
    session.initialized = true;
    return {
      protocolVersion: selectedVersion,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: 'branch', version: '1.0.0' },
    };
  }

  private listTools(): unknown[] {
    const tools: unknown[] = [{
      name: 'branch.ask',
      description: 'Ask Branch to do something and return its answer. Branch uses its own tools, memory and skills.',
      inputSchema: {
        type: 'object',
        properties: { prompt: { type: 'string', description: 'What you want Branch to do' } },
        required: ['prompt'],
      },
    }];
    const exposed = this.exposed();
    if (!exposed.size) return tools;
    const schemas = new Map(
      // Another program's client validates against what it is told, so it gets the full schema, not
      // the shortened one the model is shown to keep the per-round catalog small.
      this.registry.descriptions(new Set(this.registry.permissions()), { diet: false }).map((d) => [d.name, d.parameters]),
    );
    for (const tool of this.registry.inventory())
      if (exposed.has(tool.name))
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: schemas.get(tool.name) ?? { type: 'object', properties: {} },
        });
    return tools;
  }

  private async callTool(session: McpSession, params: unknown): Promise<unknown> {
    const parsed = z.object({
      name: z.string().min(1).max(100),
      arguments: z.record(z.string(), z.unknown()).optional(),
    }).strict().parse(params);
    session.callCount++;
    if (session.callCount > this.options.perClientRateLimit)
      return failure(`This connection has used its limit of ${this.options.perClientRateLimit} calls.`);
    if (this.inFlight >= this.options.maxConcurrentCalls)
      return failure('Branch is already busy with as many shared calls as it allows. Try again shortly.');
    this.inFlight++;
    try {
      const args = parsed.arguments ?? {};
      if (parsed.name === 'branch.ask') return await this.callAsk(args);
      const exposed = this.exposed();
      if (!exposed.has(parsed.name))
        return failure(`Branch is not sharing "${parsed.name}". Turn it on in Settings, under Sharing with other AI tools.`);
      return await this.callRegistryTool(parsed.name, args, exposed);
    } finally {
      this.inFlight--;
    }
  }

  /** Delegate a prompt to Branch itself; the runtime records the run, we add the receipt. */
  private async callAsk(args: Record<string, unknown>): Promise<unknown> {
    const parsed = z.object({ prompt: z.string().trim().min(1).max(16000) }).strict().safeParse(args);
    if (!parsed.success) return failure('Give a "prompt" saying what you want Branch to do.');
    try {
      const run = await this.runtime.run({ prompt: parsed.data.prompt, source: 'mcp' });
      await this.recordCall(run.id, 'branch.ask', parsed.data, run.output, run.status === 'completed');
      return { content: [{ type: 'text', text: run.output }], isError: run.status !== 'completed' };
    } catch (e) {
      return failure(errorText(e));
    }
  }

  /** Run one shared tool as its own recorded task, so it appears in Activity with a receipt. */
  private async callRegistryTool(name: string, args: Record<string, unknown>, exposed: Set<string>): Promise<unknown> {
    const run = this.store.createRun(this.runtime.owner, `Another AI tool used ${name}`);
    this.store.event(run.id, 'run.started', { source: 'mcp', tool: name, provider: this.runtime.provider.name, parentRunId: null });
    try {
      const result = await this.registry.execute(name, args, this.toolContext(run.id, exposed));
      await this.recordCall(run.id, name, args, result, true);
      this.store.finish(run.id, 'completed', JSON.stringify(result));
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
    } catch (e) {
      const error = errorText(e);
      await this.recordCall(run.id, name, args, error, false);
      this.store.finish(run.id, 'failed', error);
      return failure(error);
    }
  }

  /** The same started/completed pair the runtime records, marked as coming from another AI tool. */
  private async recordCall(runId: string, name: string, args: unknown, result: unknown, ok: boolean): Promise<void> {
    const id = randomUUID();
    const label = name === 'branch.ask' ? 'Answering another AI tool' : describeToolCall(name, args);
    this.store.event(runId, 'tool.started', { name, id, source: 'mcp', label });
    if (!ok) {
      this.store.event(runId, 'tool.failed', { name, id, source: 'mcp', error: String(result) });
      return;
    }
    const receipt = await this.store.receipts.sign(runId, id, name, result);
    this.store.event(runId, 'tool.completed', { name, id, source: 'mcp', result, receipt });
  }

  private toolContext(runId: string, exposed: Set<string>): ToolContext {
    const permissions = new Set(
      this.registry.inventory().filter((tool) => exposed.has(tool.name)).map((tool) => tool.permission),
    );
    return {
      owner: this.runtime.owner,
      workspace: this.files.base,
      runId,
      signal: AbortSignal.timeout(120000),
      budget: new Budget({ maxSteps: 5, maxTokens: 8000 }),
      permissions,
      depth: 0,
    };
  }

  private listResources(): unknown[] {
    const resources: unknown[] = [
      { uri: 'memory://facts', name: 'Memory facts', description: 'What Branch remembers', mimeType: 'application/json' },
      { uri: 'workspace://files', name: 'Workspace files', description: 'Files in the workspace', mimeType: 'application/json' },
    ];
    for (const conversation of this.recentConversations())
      resources.push({
        uri: `conversation://${conversation.sessionId}`,
        name: conversation.title,
        description: `Conversation from ${conversation.date}`,
        mimeType: 'text/plain',
      });
    return resources;
  }

  /** The owner's most recent saved conversations; temporary ones are never listed. */
  private recentConversations(): { sessionId: string; title: string; date: string }[] {
    const found = this.store.searchSessions(this.runtime.owner, { query: '', offset: 0 });
    return found.sessions.slice(0, CONVERSATION_LIMIT).map((session) => ({
      sessionId: session.sessionId,
      title: conversationTitle(session.preview),
      date: session.createdAt.slice(0, 10),
    }));
  }

  private async readResource(params: unknown): Promise<unknown> {
    const { uri } = z.object({ uri: z.string().min(1).max(500) }).strict().parse(params);
    const json = (value: unknown) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value) }] });
    if (uri === 'memory://facts') return json(this.store.list('memory', this.runtime.owner));
    if (uri === 'workspace://files') return json(await this.files.list());
    const conversation = new RegExp(`^conversation://(${UUID})$`).exec(uri);
    if (conversation) {
      const sessionId = conversation[1]!;
      if (!this.store.ownsSession(this.runtime.owner, sessionId)) throw new Error('Conversation not found');
      return { contents: [{ uri, mimeType: 'text/plain', text: transcriptText(this.store.messages(sessionId)) }] };
    }
    throw new Error(`Unknown resource: ${uri}`);
  }

  private listPrompts(): unknown[] {
    return this.store.list('procedures', this.runtime.owner).slice(0, 10).map((procedure) => ({
      name: `procedure:${procedure.id}`,
      description: String((procedure.data as { name?: string }).name ?? procedure.id),
    }));
  }

  private async getPrompt(params: unknown): Promise<unknown> {
    const { name } = z.object({ name: z.string().min(1).max(200) }).strict().parse(params);
    const match = new RegExp(`^procedure:(${UUID})$`).exec(name);
    if (!match) throw new Error(`Unknown prompt: ${name}`);
    const procedure = this.store.get('procedures', this.runtime.owner, match[1]!);
    if (!procedure) throw new Error('Procedure not found');
    const data = procedure.data as { name?: string; steps?: unknown[] };
    return {
      description: String(data.name ?? 'Saved procedure'),
      messages: [{
        role: 'user',
        content: `Follow the saved procedure "${data.name ?? 'Unnamed'}". Steps: ${JSON.stringify(data.steps ?? [])}`,
      }],
    };
  }
}

const failure = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

export async function startMcpServer(
  registry: ToolRegistry,
  store: Store,
  runtime: Runtime,
  knowledge: Knowledge,
  files: WorkspaceFiles,
  options: Partial<McpServerOptions> = {},
): Promise<McpServer> {
  const defaultOptions: McpServerOptions = {
    enabled: false,
    exposedTools: new Set<string>(),
    maxConcurrentCalls: 4,
    perClientRateLimit: 100,
    ...options,
  };
  return new McpServer(registry, store, runtime, knowledge, files, defaultOptions);
}

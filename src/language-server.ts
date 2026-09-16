import { readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import type { WorkspaceFiles } from "./files.js";
import { mapLanguageOf } from "./code-scanners.js";
import { RequestTable, StdioChannel, checkedProgram } from "./stdio-rpc.js";
import type { JobObjects } from "./integrations/job-object.js";
import { defaultJobObjects } from "./integrations/job-object.js";

/**
 * Talking to a language server the owner already has installed. A language server is the same
 * program an editor uses to underline mistakes, jump to where something is defined and rename a
 * name everywhere at once. Branch never downloads one: the owner names the programs they already
 * have, and until they switch this on nothing is started at all.
 */
const alias = z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/);
/** The kinds of file this app knows how to hand to a server, in the words the protocol uses. */
const languageIds: Record<string, string> = {
  TypeScript: "typescript", JavaScript: "javascript", Python: "python",
  Go: "go", Rust: "rust", Java: "java", "C#": "csharp", Markdown: "markdown",
};
export const LanguageServerSettingsSchema = z.object({
  /** Nothing is started until the owner turns this on. */
  enabled: z.boolean().default(false),
  servers: z.record(alias, z.object({
    /** The full address of the program; a .cmd or .bat wrapper is refused. */
    path: z.string().min(1).max(1000),
    args: z.array(z.string().max(500)).max(20).default([]),
    /** The kinds of file this server handles, such as ["TypeScript", "JavaScript"]. */
    languages: z.array(z.string().min(1).max(40)).min(1).max(10),
  }).strict()).default({}),
  maxMemoryMb: z.number().int().min(64).max(16384).default(2048),
  maxCpuSeconds: z.number().int().min(10).max(36000).default(1800),
  /** How long to wait for one answer before giving up on it. */
  timeoutMs: z.number().int().min(1000).max(120000).default(20000),
}).strict();
export type LanguageServerSettings = z.infer<typeof LanguageServerSettingsSchema>;

export function languageServerSettings(store: Store, owner: string): LanguageServerSettings {
  const parsed = LanguageServerSettingsSchema.safeParse(store.get("settings", owner, "language-servers")?.data ?? {});
  return parsed.success ? parsed.data : LanguageServerSettingsSchema.parse({});
}
/** Saves the list, refusing a program that is not there or is a wrapper script. */
export async function saveLanguageServerSettings(store: Store, owner: string, input: unknown): Promise<LanguageServerSettings> {
  const value = LanguageServerSettingsSchema.parse(input ?? {});
  for (const [name, server] of Object.entries(value.servers))
    await checkedProgram(server.path).catch((error: Error) => { throw new Error(`${name}: ${error.message}`); });
  store.save("settings", owner, "language-servers", { ...value });
  return value;
}

export interface Diagnostic { path: string; line: number; character: number; severity: string; message: string; source: string }
export interface Place { path: string; line: number; character: number; endLine: number; endCharacter: number }
const severities = ["", "error", "warning", "information", "hint"];

/** One running language server, with the documents it has been shown and what it said about them. */
class Server {
  private readonly table: RequestTable;
  private readonly diagnostics = new Map<string, Diagnostic[]>();
  private readonly opened = new Set<string>();
  private stderr = "";
  constructor(readonly name: string, private readonly channel: StdioChannel, private readonly root: string, timeoutMs: number) {
    this.table = new RequestTable(timeoutMs);
    channel.listeners.add((message) => this.receive(message));
  }
  note(text: string): void { this.stderr = `${this.stderr}${text}`.slice(-2000); }
  get running(): boolean { return this.channel.running; }
  get pid(): number | null { return this.channel.pid; }

  /** Answers, notifications and the server's own questions, each dealt with in one place. */
  private receive(message: Record<string, unknown>): void {
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null && "method" in message) { this.answerServer(id); return; }
    if (id !== null) {
      const error = message.error as { message?: unknown } | undefined;
      this.table.settle(id, (message.result ?? {}) as Record<string, unknown>, error ? String(error.message ?? "the server refused") : undefined);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") this.keepDiagnostics(message.params as Record<string, unknown>);
  }
  /** A server may ask this app things; nothing is configured here, so every question gets "nothing". */
  private answerServer(id: number): void {
    try { this.channel.send({ jsonrpc: "2.0", id, result: null }); } catch { /* it has already gone */ }
  }
  private keepDiagnostics(params: Record<string, unknown> | undefined): void {
    const uri = String(params?.uri ?? "");
    if (!uri) return;
    const list = Array.isArray(params?.diagnostics) ? (params.diagnostics as Record<string, unknown>[]) : [];
    this.diagnostics.set(uri, list.slice(0, 200).map((entry) => toDiagnostic(this.root, uri, entry)));
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<Record<string, unknown>> {
    const id = this.table.take();
    const waiting = this.table.expect(id, timeoutMs);
    this.channel.send({ jsonrpc: "2.0", id, method, params });
    return waiting;
  }
  notify(method: string, params: unknown): void {
    this.channel.send({ jsonrpc: "2.0", method, params });
  }
  /** Tells the server this file exists, once, and hands it the text. */
  async open(relative: string, absolute: string): Promise<string> {
    const uri = pathToFileURL(absolute).href;
    if (this.opened.has(uri)) return uri;
    const text = await readFile(absolute, "utf8").catch(() => "");
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: languageIds[mapLanguageOf(relative)] ?? "plaintext", version: 1, text },
    });
    this.opened.add(uri);
    return uri;
  }
  diagnosticsFor(uri: string | null): Diagnostic[] {
    if (uri) return this.diagnostics.get(uri) ?? [];
    return [...this.diagnostics.values()].flat().slice(0, 300);
  }
  async stop(): Promise<void> {
    this.table.abandon("The language server was stopped");
    try { await this.request("shutdown", null, 2000); this.notify("exit", null); } catch { /* it may already be gone */ }
    await this.channel.stop();
  }
  get problem(): string { return this.channel.problem ?? this.stderr.trim(); }
}

function toDiagnostic(root: string, uri: string, entry: Record<string, unknown>): Diagnostic {
  const start = ((entry.range as { start?: Record<string, number> } | undefined)?.start) ?? {};
  return {
    path: relativeTo(root, uri), line: Number(start.line ?? 0) + 1, character: Number(start.character ?? 0) + 1,
    severity: severities[Number(entry.severity ?? 1)] ?? "error",
    message: String(entry.message ?? "").slice(0, 500), source: String(entry.source ?? "").slice(0, 60),
  };
}
/** A file address from the server, written the way the rest of the app writes paths. */
export function relativeTo(root: string, uri: string): string {
  try {
    const path = fileURLToPath(uri);
    const rel = path.slice(root.length).replace(/\\/g, "/").replace(/^\//, "");
    return rel || path;
  } catch { return uri; }
}

export class LanguageServers {
  private readonly servers = new Map<string, Server>();
  constructor(
    private readonly store: Store, private readonly owner: string,
    private readonly files: WorkspaceFiles, private readonly jobs: JobObjects = defaultJobObjects(),
  ) {}
  settings(): LanguageServerSettings { return languageServerSettings(this.store, this.owner); }

  /** Which of the owner's servers handles this file, by the kind of file it is. */
  private aliasFor(path: string): string {
    const settings = this.settings();
    if (!settings.enabled) throw new Error("Language servers are switched off. The owner turns them on in Settings, under Developer.");
    const language = mapLanguageOf(path);
    const found = Object.entries(settings.servers).find(([, server]) => server.languages.includes(language));
    if (!found) throw new Error(`No language server is set up for ${language} files. The owner adds one in Settings, under Developer.`);
    return found[0];
  }

  /** Starts one server if it is not already up, and waits for it to say it is ready. */
  private async serverFor(path: string): Promise<Server> {
    const name = this.aliasFor(path);
    const existing = this.servers.get(name);
    if (existing?.running) return existing;
    if (existing) this.servers.delete(name);
    return this.startNamed(name);
  }
  private async startNamed(name: string): Promise<Server> {
    const settings = this.settings();
    const config = settings.servers[name]!;
    const root = this.files.base;
    let server: Server | undefined;
    const channel = await StdioChannel.start({
      executable: config.path, args: config.args, cwd: root,
      limits: { maxMemoryMb: settings.maxMemoryMb, maxCpuSeconds: settings.maxCpuSeconds },
      onStderr: (text) => server?.note(text),
    }, this.jobs);
    server = new Server(name, channel, root, settings.timeoutMs);
    await server.request("initialize", {
      processId: process.pid, rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: "workspace" }],
      capabilities: { textDocument: { publishDiagnostics: {}, hover: { contentFormat: ["plaintext"] }, rename: {} } },
    }).catch((error: Error) => { void channel.stop(); throw new Error(`The language server "${name}" did not start: ${error.message}`); });
    server.notify("initialized", {});
    this.servers.set(name, server);
    return server;
  }

  /** The file, opened at the server, and the server itself. */
  private async at(path: string): Promise<{ server: Server; uri: string }> {
    const absolute = await this.files.checked(path);
    const server = await this.serverFor(path);
    return { server, uri: await server.open(path, absolute) };
  }
  private position(line: number, character: number) { return { line: Math.max(0, line - 1), character: Math.max(0, character - 1) }; }

  /** Mistakes and warnings for one file, or for every file already looked at. */
  async diagnostics(input: { path?: string | undefined; waitMs: number }): Promise<{ diagnostics: Diagnostic[]; server: string }> {
    if (!input.path) {
      const any = [...this.servers.values()].find((server) => server.running);
      if (!any) throw new Error("No language server is running yet; ask about one file first.");
      return { server: any.name, diagnostics: any.diagnosticsFor(null) };
    }
    const { server, uri } = await this.at(input.path);
    await new Promise((resolve) => setTimeout(resolve, input.waitMs));
    return { server: server.name, diagnostics: server.diagnosticsFor(uri) };
  }

  async definition(input: { path: string; line: number; character: number }): Promise<{ places: Place[] }> {
    const { server, uri } = await this.at(input.path);
    const answer = await server.request("textDocument/definition", {
      textDocument: { uri }, position: this.position(input.line, input.character),
    });
    return { places: places(this.files.base, answer) };
  }
  async references(input: { path: string; line: number; character: number; includeDeclaration: boolean }): Promise<{ places: Place[] }> {
    const { server, uri } = await this.at(input.path);
    const answer = await server.request("textDocument/references", {
      textDocument: { uri }, position: this.position(input.line, input.character),
      context: { includeDeclaration: input.includeDeclaration },
    });
    return { places: places(this.files.base, answer) };
  }
  async hover(input: { path: string; line: number; character: number }): Promise<{ text: string }> {
    const { server, uri } = await this.at(input.path);
    const answer = await server.request("textDocument/hover", { textDocument: { uri }, position: this.position(input.line, input.character) });
    return { text: hoverText(answer).slice(0, 4000) };
  }
  /** What a rename would change, as whole files, for the ordinary change-set gate to settle. */
  async renameEdits(input: { path: string; line: number; character: number; newName: string }): Promise<{ path: string; before: string; after: string }[]> {
    const { server, uri } = await this.at(input.path);
    const answer = await server.request("textDocument/rename", {
      textDocument: { uri }, position: this.position(input.line, input.character), newName: input.newName,
    });
    return this.applyWorkspaceEdit(answer);
  }

  /** Turns the server's list of ranges into one new text per file, applied back to front. */
  private async applyWorkspaceEdit(answer: Record<string, unknown>): Promise<{ path: string; before: string; after: string }[]> {
    const changes = (answer.changes ?? {}) as Record<string, unknown>;
    const documentChanges = Array.isArray(answer.documentChanges) ? answer.documentChanges : [];
    const byUri = new Map<string, Record<string, unknown>[]>();
    for (const [uri, edits] of Object.entries(changes)) if (Array.isArray(edits)) byUri.set(uri, edits as Record<string, unknown>[]);
    for (const entry of documentChanges as Record<string, unknown>[]) {
      const uri = String((entry.textDocument as { uri?: unknown } | undefined)?.uri ?? "");
      if (uri && Array.isArray(entry.edits)) byUri.set(uri, entry.edits as Record<string, unknown>[]);
    }
    if (!byUri.size) throw new Error("The language server did not offer a rename here.");
    const planned: { path: string; before: string; after: string }[] = [];
    for (const [uri, edits] of byUri) {
      const path = relativeTo(this.files.base, uri);
      const absolute = await this.files.checked(path);
      const before = await readFile(absolute, "utf8");
      planned.push({ path, before, after: applyEdits(before, edits) });
    }
    return planned;
  }

  /** What is running right now, for the screens and for stopping one by hand. */
  list(): { name: string; pid: number | null; running: boolean; problem: string }[] {
    return [...this.servers.values()].map((server) => ({ name: server.name, pid: server.pid, running: server.running, problem: server.problem }));
  }
  async stopAll(): Promise<number> {
    const running = [...this.servers.values()];
    this.servers.clear();
    await Promise.allSettled(running.map((server) => server.stop()));
    return running.length;
  }
}

/** Ranges are offsets into the text; applying them back to front keeps every earlier one correct. */
export function applyEdits(text: string, edits: Record<string, unknown>[]): string {
  const lines = text.split("\n");
  const offsets: number[] = [0];
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1);
  const at = (position: { line?: unknown; character?: unknown } | undefined): number => {
    const line = Math.min(Math.max(0, Number(position?.line ?? 0)), lines.length - 1);
    return Math.min(text.length, offsets[line]! + Math.max(0, Number(position?.character ?? 0)));
  };
  const ordered = edits
    .map((edit) => ({ range: edit.range as { start?: Record<string, unknown>; end?: Record<string, unknown> } | undefined, newText: String(edit.newText ?? "") }))
    .map((edit) => ({ start: at(edit.range?.start), end: at(edit.range?.end), newText: edit.newText }))
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of ordered) out = out.slice(0, edit.start) + edit.newText + out.slice(Math.max(edit.start, edit.end));
  return out;
}

/** A definition or a reference answer, in any of the three shapes the protocol allows. */
function places(root: string, answer: unknown): Place[] {
  const list = Array.isArray(answer) ? answer : answer && typeof answer === "object" ? [answer] : [];
  return list.slice(0, 200).map((entry) => {
    const item = entry as Record<string, unknown>;
    const uri = String(item.uri ?? item.targetUri ?? "");
    const range = (item.range ?? item.targetSelectionRange ?? item.targetRange ?? {}) as { start?: Record<string, number>; end?: Record<string, number> };
    return {
      path: relativeTo(root, uri),
      line: Number(range.start?.line ?? 0) + 1, character: Number(range.start?.character ?? 0) + 1,
      endLine: Number(range.end?.line ?? range.start?.line ?? 0) + 1, endCharacter: Number(range.end?.character ?? 0) + 1,
    };
  }).filter((place) => !!place.path);
}

/** Hover text, which servers send as a string, a marked block, or a list of either. */
function hoverText(answer: Record<string, unknown>): string {
  const contents = answer.contents;
  const one = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") return String((value as { value?: unknown }).value ?? "");
    return "";
  };
  return (Array.isArray(contents) ? contents.map(one) : [one(contents)]).filter(Boolean).join("\n\n");
}

/** Where a workspace path sits on disk, for the tests and for the screens. */
export const absoluteIn = (root: string, path: string): string => join(root, path);

/**
 * The owner's own MCP servers, added from the window and kept in the store, loaded the way the launch settings file's
 * servers are (`startMcp`, src/integrations/bootstrap.ts): the same allowlist of tools, the same pinned version, the
 * same on-demand manager and the same malware check.
 *
 * Security (flagged for review):
 * - A server that starts a program on this computer (a command) is saved switched OFF. Switching it on puts a question
 *   through the approval gate, bound to a fingerprint of the exact launch (command, arguments, folder and the names of
 *   the secrets it gets). Only "Yes, just now" or "for this conversation" are offered; a standing "always" is refused,
 *   because it would be a policy rule nothing here reads. The program is started only after that yes.
 * - The yes is kept with the server: while it stays on and its launch is unchanged, Branch starts it again when Branch
 *   starts. Switching it off and on again asks again. A saved launch is never edited; a changed one is a new server.
 * - Before it is added and again before each start, a command fetched from a package registry is looked up in the
 *   malware list. The tools it offers are listed once, after the yes, and pinned with the server's version; later starts
 *   refuse a server whose version changed. Each discovered tool is weighed by the owner's approval settings the way
 *   MCP preflight does (src/mcp-policy.ts): a tool the settings refuse outright is left out, and a server with nothing
 *   left is not started. Every call its tools make still goes through the approval gate like any other tool.
 * - A server at a web address reaches outside this computer through the owner's network rules; it is saved on.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { audit } from "./audit.js";
import { approvalQuestion, type ApprovalGate } from "./approvals.js";
import { askerOf, runOrigin } from "./key-context.js";
import { evaluatePolicy, readPolicy } from "./policy.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import { makeTransport, McpTransportSchema, type McpTransportConfig } from "./integrations/mcp-config.js";
import { mcpToolName } from "./integrations/mcp.js";
import { startMcp, type McpHost } from "./integrations/bootstrap.js";

export const AddServerSchema = z.object({
  name: z.string().trim().min(1).max(60),
  server: McpTransportSchema,
  /** The catalogue entry the form was filled from, if it was. */
  catalogue: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
}).strict();

export interface OwnServer {
  id: string; name: string; server: McpTransportConfig; on: boolean;
  /** The launch fingerprint the owner said yes to; null until then (a web address needs none). */
  approved: string | null;
  tools: string[]; version: string | null; hidden: string[]; addedAt: string; catalogue?: string;
}
const Saved = z.object({ servers: z.array(z.custom<OwnServer>()).max(8).default([]) }).strict();
const key = "mcp-own-servers";
const maxServers = 8;
/** The tool name the start question is asked under; the target is the server's id. */
export const startTool = "mcp.start";
const waitLimitMs = 60 * 60 * 1000;

/** The exact launch, in a fixed order, and its fingerprint: what a yes is bound to. */
export function launchBytes(server: McpTransportConfig): string {
  return server.transport === "stdio"
    ? JSON.stringify({ transport: "stdio", command: server.command, args: server.args, cwd: server.cwd ?? null, envKeys: server.envKeys })
    : JSON.stringify({ transport: "http", url: server.url, bearerEnv: server.bearerEnv ?? null });
}
export const launchFingerprint = (server: McpTransportConfig): string =>
  createHash("sha256").update(launchBytes(server), "utf8").digest("hex").slice(0, 32);
const how = (server: McpTransportConfig): string =>
  server.transport === "stdio" ? `${server.command} ${server.args.join(" ")}`.trim().slice(0, 300) : server.url;
const slug = (name: string): string => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 26);
  return base || "server";
};

export interface OwnServersDeps {
  store: Store; owner: () => string; registry: ToolRegistry; approvals: ApprovalGate;
  env?: NodeJS.ProcessEnv; policy: () => NetworkPolicy | undefined; host: () => McpHost | undefined;
  /** The malware check: throws a plain sentence for a package listed as harmful. */
  vet: (command: string, args: readonly string[]) => Promise<void>;
  /** How often a waiting question is looked at again; tests shorten it. */
  pollMs?: number;
}

interface Waiting { runId: string; sessionId: string; fingerprint: string; question: string; timer: NodeJS.Timeout; since: number }

export class OwnMcpServers {
  private readonly live = new Map<string, { close: () => Promise<void>; names: string[] }>();
  private readonly waiting = new Map<string, Waiting>();
  private readonly problems = new Map<string, string>();
  private launchIds: string[] = [];
  constructor(private readonly deps: OwnServersDeps) {}
  private get env(): NodeJS.ProcessEnv { return this.deps.env ?? process.env; }

  saved(): OwnServer[] {
    const kept = Saved.safeParse(this.deps.store.get("settings", this.deps.owner(), key)?.data ?? {});
    return kept.success ? kept.data.servers : [];
  }
  private save(servers: OwnServer[]): void { this.deps.store.save("settings", this.deps.owner(), key, { servers }); }
  private update(id: string, patch: Partial<OwnServer>): OwnServer {
    const servers = this.saved();
    const at = servers.findIndex((entry) => entry.id === id);
    if (at < 0) throw new Error("There is no server of yours by that name.");
    servers[at] = { ...servers[at]!, ...patch };
    this.save(servers);
    return servers[at]!;
  }
  private find(id: string): OwnServer {
    const found = this.saved().find((entry) => entry.id === id);
    if (!found) throw new Error("There is no server of yours by that name.");
    return found;
  }

  view(entry: OwnServer) {
    const pending = this.waiting.get(entry.id);
    return { id: entry.id, name: entry.name, transport: entry.server.transport, how: how(entry.server), on: entry.on,
      running: this.live.has(entry.id), waiting: pending ? { sessionId: pending.sessionId, fingerprint: pending.fingerprint, question: pending.question } : null,
      tools: entry.tools.length, hidden: entry.hidden, error: this.problems.get(entry.id) ?? null, catalogue: entry.catalogue ?? null };
  }
  list() { return { servers: this.saved().map((entry) => this.view(entry)) }; }

  /** Written as a connection changing, with what happened in the subject and the outcome. */
  private record(what: string, subject: string, outcome: string): void {
    const owner = this.deps.owner();
    audit(this.deps.store, owner, { action: "connection.changed", actor: owner, subject: `${what} ${subject}`.slice(0, 300),
      reason: "Your own tool servers, from Customize", source: "owner", outcome });
  }

  /** Adds one server. A command is saved off; a web address is saved on and connected now. */
  async add(input: unknown) {
    const wanted = AddServerSchema.parse(input);
    const servers = this.saved();
    if (servers.length >= maxServers) throw new Error(`Branch keeps at most ${maxServers} servers of your own. Remove one first.`);
    if (wanted.server.transport === "stdio") await this.deps.vet(wanted.server.command, wanted.server.args);
    const taken = new Set([...this.launchIds, ...servers.map((entry) => entry.id)]);
    let id = slug(wanted.name);
    for (let n = 2; taken.has(id); n++) id = `${slug(wanted.name)}-${n}`;
    const entry: OwnServer = { id, name: wanted.name, server: wanted.server, on: false, approved: null, tools: [], version: null,
      hidden: [], addedAt: new Date().toISOString(), ...(wanted.catalogue ? { catalogue: wanted.catalogue } : {}) };
    this.save([...servers, entry]);
    this.record("Tool server added:", `${entry.name}: ${how(entry.server)}`, entry.server.transport === "stdio" ? "saved off" : "saved on");
    if (entry.server.transport === "stdio") return { server: this.view(entry), said: `${entry.name} is added. It is off until you switch it on and say yes.` };
    await this.open(entry, true).catch(() => undefined);
    return { server: this.view(this.find(id)), said: this.problems.get(id) ?? `${entry.name} is added.` };
  }

  /** Switching a server on. A command asks first, through the approval gate; a web address connects now. */
  async start(id: string) {
    const entry = this.find(id);
    if (this.live.has(id)) return { server: this.view(entry), said: `${entry.name} is on.` };
    if (entry.server.transport === "http") {
      await this.open(entry, entry.tools.length === 0);
      return { server: this.view(this.find(id)), said: `${entry.name} is on.` };
    }
    await this.deps.vet(entry.server.command, entry.server.args);
    const pending = this.waiting.get(id) ?? this.ask(entry);
    return { server: this.view(entry), said: pending.question };
  }

  private ask(entry: OwnServer): Waiting {
    const store = this.deps.store, owner = this.deps.owner();
    const fingerprint = launchFingerprint(entry.server), bytes = launchBytes(entry.server);
    const label = `Start a program on this computer for your ${entry.name} server: ${how(entry.server)}`;
    const question = approvalQuestion(label, "");
    const run = store.createRun(owner, `Switch on the ${entry.name} server`);
    this.deps.approvals.ask({ runId: run.id, sessionId: run.sessionId, tool: startTool, target: entry.id, label, question,
      source: "owner", remember: "never", askedAt: new Date().toISOString(), bytes, fingerprint, noStanding: true, noAlways: true });
    store.event(run.id, "policy.ask", { name: startTool, label, target: entry.id, remember: "never", question, bytes, fingerprint });
    store.finish(run.id, "needs_input", question);
    // The question is written into the switch's own conversation, so "Open" shows it with its card. Written after the
    // stop, it also means a window's "carry on" after the yes never starts a model turn here (src/server.ts settleAsked
    // carries on only when nothing was written since the task stopped); starting the program is this class's job.
    store.message(run.sessionId, { role: "assistant", content: question });
    const waiting: Waiting = { runId: run.id, sessionId: run.sessionId, fingerprint, question, since: Date.now(),
      timer: setInterval(() => void this.check(entry.id), this.deps.pollMs ?? 250) };
    waiting.timer.unref?.();
    this.waiting.set(entry.id, waiting);
    return waiting;
  }

  /** Looks at a waiting question: still waiting, answered yes (the program starts), or anything else (it stays off). */
  private async check(id: string): Promise<void> {
    const pending = this.waiting.get(id);
    if (!pending) return;
    const gate = this.deps.approvals, store = this.deps.store;
    const open = gate.questionFor(pending.sessionId, pending.fingerprint);
    if (open && Date.now() - pending.since < waitLimitMs) return;
    this.stopWaiting(id);
    if (open) { gate.resolve(pending.sessionId, pending.fingerprint); store.finish(pending.runId, "cancelled", "Nobody answered."); return; }
    const asker = askerOf(runOrigin(store, pending.runId));
    const yes = gate.answer(pending.sessionId, startTool, id, pending.fingerprint, true) === "allow"
      || gate.takeJustNow(pending.sessionId, startTool, pending.fingerprint, asker);
    store.finish(pending.runId, "completed", yes ? "You said yes." : "You said no.");
    if (!yes) return;
    const entry = this.saved().find((item) => item.id === id);
    if (entry && launchFingerprint(entry.server) === pending.fingerprint) await this.open(entry, true, pending.fingerprint).catch(() => undefined);
  }
  private stopWaiting(id: string): void {
    const pending = this.waiting.get(id);
    if (pending) clearInterval(pending.timer);
    this.waiting.delete(id);
  }

  /** Lists what a server offers now (after the yes), keeping only what the owner's settings do not refuse outright. */
  private async listTools(entry: OwnServer): Promise<{ tools: string[]; hidden: string[]; version: string }> {
    const { transport } = makeTransport(entry.server, this.env, this.deps.policy());
    const client = new Client({ name: "branch", version: "0.1.0" });
    try {
      await client.connect(transport as Transport, { timeout: 20000 });
      const listed = await client.listTools({}, { timeout: 20000 });
      const names = listed.tools.slice(0, 64).map((tool) => tool.name);
      const policy = readPolicy(this.deps.store, this.deps.owner());
      const refused = (name: string) => evaluatePolicy(policy, { tool: mcpToolName(entry.id, name), target: "", readOnly: false }).decision === "deny";
      return { tools: names.filter((name) => !refused(name)), hidden: names.filter(refused), version: client.getServerVersion()?.version ?? "" };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /** Starts a server the way the launch file's are started, and marks it on. A failure is kept as its problem. */
  private async open(entry: OwnServer, list: boolean, approved: string | null = entry.approved): Promise<void> {
    try {
      if (entry.server.transport === "stdio") await this.deps.vet(entry.server.command, entry.server.args);
      const found = list ? await this.listTools(entry) : { tools: entry.tools, hidden: entry.hidden, version: entry.version ?? "" };
      if (!found.tools.length) throw new Error("Your approval settings refuse every tool this server offers, so it was not started.");
      if (!found.version) throw new Error("That server did not say which version it is.");
      const config = { id: entry.id, tools: found.tools, expectedVersion: found.version, ...entry.server };
      const stop = await startMcp(this.deps.registry, config, this.env, this.deps.policy(), this.deps.host());
      const names = found.tools.map((tool) => mcpToolName(entry.id, tool));
      this.live.set(entry.id, { close: stop ?? (async () => undefined), names });
      this.problems.delete(entry.id);
      this.update(entry.id, { on: true, approved, tools: found.tools, hidden: found.hidden, version: found.version });
      this.record("Tool server started:", `${entry.name}: ${found.tools.length} tools`, "started");
    } catch (error) {
      const reason = (error instanceof Error ? error.message : "It did not answer").slice(0, 300);
      this.problems.set(entry.id, reason);
      if (this.saved().some((item) => item.id === entry.id)) this.update(entry.id, { on: false });
      this.record("Tool server started:", `${entry.name}: ${reason}`, "failed");
      throw new Error(reason);
    }
  }

  private async shut(id: string): Promise<void> {
    this.stopWaiting(id);
    const running = this.live.get(id);
    this.live.delete(id);
    await this.deps.host()?.connections.forget?.(id);
    if (running) {
      await running.close().catch(() => undefined);
      for (const name of running.names) this.deps.registry.unregister(name);
    }
  }

  async stop(id: string) {
    const entry = this.find(id);
    await this.shut(id);
    const saved = this.update(id, { on: false });
    this.record("Tool server switched off:", entry.name, "stopped");
    return { server: this.view(saved), said: `${entry.name} is off.` };
  }

  async remove(id: string) {
    const entry = this.find(id);
    await this.shut(id);
    this.problems.delete(id);
    this.save(this.saved().filter((item) => item.id !== id));
    this.record("Tool server removed:", `${entry.name}: ${how(entry.server)}`, "removed");
    return { removed: id, said: `${entry.name} is removed.` };
  }

  /**
   * As Branch starts: every server left on starts again, a command only when its launch is the one the owner said yes
   * to. The launch file's server ids are noted so a new server of the owner's never takes one of them.
   */
  async startSaved(launchIds: readonly string[]): Promise<void> {
    this.launchIds = [...launchIds];
    for (const entry of this.saved()) {
      if (!entry.on || this.launchIds.includes(entry.id)) continue;
      if (entry.server.transport === "stdio" && entry.approved !== launchFingerprint(entry.server)) { this.update(entry.id, { on: false }); continue; }
      await this.open(entry, entry.tools.length === 0).catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.waiting.keys()]) this.stopWaiting(id);
    for (const id of [...this.live.keys()]) await this.shut(id);
  }
}

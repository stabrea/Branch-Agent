import { createHash } from "node:crypto";
import { z } from "zod";
import type { NetworkPolicy } from "../network-policy.js";
import type { Store } from "../store.js";

/**
 * Bucket 15 (A1890): reading a Pipelines server.
 *
 * A Pipelines server is a program some people run beside their chat app: it speaks the same
 * OpenAI-style language as any model connection, and each "pipeline" it runs shows up there as a
 * model. Branch can already talk to it as an OpenAI-compatible connection (Settings, Models). What
 * this part adds is looking at it: whether an address really is a Pipelines server, which pipelines
 * it runs, and the settings ("valves") each one has — read only.
 *
 * Deliberately not built: sending Python files to the server, adding pipelines from an address, or
 * changing valves. That would make Branch the thing that installs code on another computer, which
 * is exactly the kind of reach an add-on must never quietly gain. Do that on the server itself.
 *
 * The protocol (`/models` answering with a `pipelines` field, `/pipelines`, `/<id>/valves`) is read
 * from how Pipelines servers answer; no code from any project is copied here.
 */
export const PipelineServerSchema = z.object({
  address: z.string().url().max(500),
  /** The name of a saved secret holding the server's key, if it wants one. */
  keyName: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  label: z.string().trim().max(80).default(""),
}).strict();
export type PipelineServer = z.infer<typeof PipelineServerSchema>;
export interface PipelineSummary { id: string; name: string; type: string; valves: boolean }

const maxBytes = 512 * 1024;
const key = (address: string): string => `add-on-pipelines:${createHash("sha256").update(address).digest("hex").slice(0, 16)}`;

export interface PipelinesOptions {
  store: Store; owner: string; policy: NetworkPolicy;
  secret: (name: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export class PipelinesReader {
  constructor(private readonly options: PipelinesOptions) {}

  saved(): PipelineServer[] {
    return this.options.store.list("settings", this.options.owner).filter((row) => row.id.startsWith("add-on-pipelines:"))
      .map((row) => PipelineServerSchema.safeParse(row.data)).filter((r) => r.success).map((r) => r.data);
  }
  save(input: unknown): PipelineServer {
    const server = PipelineServerSchema.parse(input);
    const url = new URL(server.address);
    if (url.username || url.password || url.search || url.hash) throw new Error("Give the address without a name, password or anything after ? or #.");
    this.options.store.save("settings", this.options.owner, key(server.address), { ...server });
    return server;
  }
  forget(address: string): { removed: boolean } {
    return { removed: this.options.store.delete("settings", this.options.owner, key(address)) };
  }
  private server(address: string): PipelineServer {
    const found = this.saved().find((server) => server.address === address);
    if (!found) throw new Error("Save that Pipelines server first.");
    return found;
  }

  private async get(server: PipelineServer, path: string): Promise<unknown> {
    const target = new URL(`${server.address.replace(/\/+$/, "")}/${path}`);
    await this.options.policy.assertAllowed(target, "Pipelines server");
    const secret = server.keyName ? await this.options.secret(server.keyName) : null;
    if (server.keyName && !secret) throw new Error(`There is no saved secret called ${server.keyName}.`);
    const response = await (this.options.fetchImpl ?? globalThis.fetch)(target, { redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { accept: "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) } });
    if (!response.ok) throw new Error(`The Pipelines server answered ${response.status}.`);
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error("The Pipelines server sent more than Branch reads.");
    try { return JSON.parse(text) as unknown; } catch { throw new Error("The Pipelines server did not answer in JSON."); }
  }

  /** Whether the address is a Pipelines server: its model list says so. */
  async check(address: string): Promise<{ pipelines: boolean }> {
    const answer = await this.get(this.server(address), "models") as Record<string, unknown> | null;
    return { pipelines: Boolean(answer && typeof answer === "object" && "pipelines" in answer) };
  }

  /** The pipelines it runs, without their code. */
  async list(address: string): Promise<PipelineSummary[]> {
    const server = this.server(address);
    const answer = await this.get(server, "pipelines") as { data?: unknown } | null;
    const rows = Array.isArray(answer?.data) ? answer.data.slice(0, 200) as Record<string, unknown>[] : [];
    return rows.map((row) => ({
      id: String(row.id ?? "").slice(0, 120), name: String(row.name ?? row.id ?? "").slice(0, 120),
      type: String(row.type ?? "pipe").slice(0, 40), valves: Boolean(row.valves),
    })).filter((row) => /^[A-Za-z0-9_.-]{1,120}$/.test(row.id));
  }

  /** One pipeline's settings, read only. Values that look like keys are not shown. */
  async valves(address: string, id: string): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(id)) throw new Error("That is not a pipeline name.");
    const answer = await this.get(this.server(address), `${encodeURIComponent(id)}/valves`);
    const valves = answer && typeof answer === "object" ? answer as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(valves).slice(0, 64).map(([name, value]) =>
      [name, /key|token|secret|password/i.test(name) ? "(hidden)" : typeof value === "object" ? "(set)" : value]));
  }
}

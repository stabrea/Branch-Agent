import { z } from "zod";
import { scrubSecrets } from "../locker.js";
import type { NetworkPolicy } from "../network-policy.js";
import type { ToolRegistry } from "../registry.js";

/**
 * Connectors to hosted workflow-automation platforms: Dify and n8n. The owner builds a workflow on
 * one of those services; this lets the assistant start a run of it and check how that run is going,
 * the same way the issue trackers let it read and write somebody else's tool.
 *
 * Both platforms give back an id for the run they started (Dify's `task_id`, an n8n execution id),
 * and status is asked for again later against that same id. Two connectors can be configured at
 * once, and their ids are not guaranteed to be unique across the two services, so every id this
 * module hands back is a "handle" carrying the platform's name with it (`dify:7`, `n8n:7`) — the
 * part a caller must never build by hand, only pass back exactly as given. That is the
 * "task-id correlation": a status check always lands on the run it names, never on another
 * platform's run that happens to share the same raw id.
 */

const credentialName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

export const DifyConfigSchema = z.object({
  apiBase: z.string().url().default("https://api.dify.ai/v1"),
  /** Name of the secret in the active project's locker holding the Dify app's API key. */
  tokenSecret: credentialName.default("DIFY_API_KEY"),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  maxBytes: z.number().int().min(4096).max(1048576).default(262144),
}).strict();
export type DifyConfig = z.infer<typeof DifyConfigSchema>;

export const N8nConfigSchema = z.object({
  /** The owner's own n8n instance, such as https://n8n.example.com — n8n is always self-hosted. */
  apiBase: z.string().url(),
  /** Name of the secret holding the n8n API key, used to read execution status back. */
  tokenSecret: credentialName.default("N8N_API_KEY"),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  maxBytes: z.number().int().min(4096).max(1048576).default(262144),
}).strict();
export type N8nConfig = z.infer<typeof N8nConfigSchema>;

export const platformNames = ["dify", "n8n"] as const;
export type PlatformName = (typeof platformNames)[number];
export type PlatformRunStatus = "running" | "succeeded" | "failed";

export interface PlatformRun {
  platform: PlatformName;
  /** The opaque, correlated id a status check is made with — never the platform's raw id alone. */
  handle: string;
  status: PlatformRunStatus;
  outputs?: Record<string, unknown>;
  error?: string;
}

/** What every hosted workflow platform connector can do, whichever service it talks to. */
export interface WorkflowPlatform {
  readonly platform: PlatformName;
  trigger(input: { workflowId: string; inputs: Record<string, unknown> }): Promise<PlatformRun>;
  status(taskId: string): Promise<PlatformRun>;
}

/** A run id built with its platform, and read back apart again; the one place either happens. */
export function makeHandle(platform: PlatformName, taskId: string): string {
  return `${platform}:${taskId}`;
}
export function readHandle(handle: string): { platform: PlatformName; taskId: string } {
  const at = handle.indexOf(":");
  const platform = handle.slice(0, at);
  const taskId = handle.slice(at + 1);
  if (at < 1 || !taskId || !(platformNames as readonly string[]).includes(platform))
    throw new Error("That is not a run handle this bridge gave out. Use the handle a trigger call returned.");
  return { platform: platform as PlatformName, taskId };
}

/**
 * Dify's Workflow API: one call starts a run and, in blocking mode, waits for it to finish and
 * hands back its own `task_id` alongside the result; the same id reads the run back later, which
 * matters for a workflow the owner built to run longer than the caller wants to wait for.
 */
export class DifyAccess implements WorkflowPlatform {
  readonly platform = "dify" as const;
  private readonly config: DifyConfig;
  constructor(input: unknown, private readonly policy: NetworkPolicy, private readonly token: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = globalThis.fetch, private readonly userAgent = "BranchAgent") {
    this.config = DifyConfigSchema.parse(input);
  }
  private async call(path: string, init: { method: string; body?: unknown }): Promise<Record<string, unknown>> {
    const token = await this.token();
    const url = new URL(path, this.config.apiBase.replace(/\/?$/, "/"));
    await this.policy.assertAllowed(url, "Dify address");
    const response = await this.fetchImpl(url, {
      method: init.method, redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", "user-agent": this.userAgent },
      body: init.body === undefined ? null : JSON.stringify(init.body),
    });
    const text = scrubSecrets((await response.text()).slice(0, this.config.maxBytes), { [this.config.tokenSecret]: token });
    if (!response.ok) throw new Error(explainPlatform("Dify", response.status, text));
    try { return text ? JSON.parse(text) : {}; } catch { throw new Error("Dify answered with something that is not a workflow run."); }
  }
  private toRun(taskId: string, data: Record<string, unknown>): PlatformRun {
    const rawStatus = String((data as { status?: unknown }).status ?? "running");
    const status: PlatformRunStatus = rawStatus === "succeeded" ? "succeeded" : rawStatus === "running" ? "running" : "failed";
    const outputs = (data as { outputs?: unknown }).outputs;
    const error = (data as { error?: unknown }).error;
    return {
      platform: "dify", handle: makeHandle("dify", taskId), status,
      ...(outputs && typeof outputs === "object" ? { outputs: outputs as Record<string, unknown> } : {}),
      ...(typeof error === "string" && error ? { error } : {}),
    };
  }
  async trigger(input: { workflowId: string; inputs: Record<string, unknown> }): Promise<PlatformRun> {
    // The workflow itself is chosen by which app the API key belongs to; workflowId is kept for the
    // caller's own record-keeping and is echoed back in the run so a batch of triggers stays legible.
    const data = await this.call("workflows/run", { method: "POST", body: { inputs: input.inputs, response_mode: "blocking", user: "branch-agent" } });
    const taskId = String((data as { task_id?: unknown }).task_id ?? (data as { workflow_run_id?: unknown }).workflow_run_id ?? "");
    if (!taskId) throw new Error("Dify started the workflow but did not send back a task id to track it by.");
    return this.toRun(taskId, (data.data as Record<string, unknown> | undefined) ?? {});
  }
  async status(taskId: string): Promise<PlatformRun> {
    const data = await this.call(`workflows/run/${encodeURIComponent(taskId)}`, { method: "GET" });
    return this.toRun(taskId, data);
  }
}

/**
 * n8n has no API endpoint that starts a workflow and hands back an execution id in one call, so the
 * connector calls the workflow's own webhook trigger — the same address the owner would paste into
 * anything else that starts it — and expects the workflow to answer right away with the execution
 * id it is running under (an n8n "Respond to Webhook" node returning `{ "executionId": $execution.id }`
 * is the documented way to do that). That id is then read back through n8n's REST API, with the
 * owner's API key, whenever status is asked for.
 */
export class N8nAccess implements WorkflowPlatform {
  readonly platform = "n8n" as const;
  private readonly config: N8nConfig;
  constructor(input: unknown, private readonly policy: NetworkPolicy, private readonly token: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = globalThis.fetch, private readonly userAgent = "BranchAgent") {
    this.config = N8nConfigSchema.parse(input);
  }
  async trigger(input: { workflowId: string; inputs: Record<string, unknown> }): Promise<PlatformRun> {
    // workflowId is the webhook path n8n gave the trigger node, such as "order-received".
    const url = new URL(`webhook/${input.workflowId}`, this.config.apiBase.replace(/\/?$/, "/"));
    await this.policy.assertAllowed(url, "n8n address");
    const response = await this.fetchImpl(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": this.userAgent },
      body: JSON.stringify(input.inputs),
    });
    const text = (await response.text()).slice(0, this.config.maxBytes);
    if (!response.ok) throw new Error(explainPlatform("n8n", response.status, text));
    let parsed: Record<string, unknown> = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { /* a webhook that answers with plain text has no id to correlate */ }
    const executionId = String(parsed.executionId ?? "");
    if (!executionId)
      throw new Error("n8n ran the workflow but did not send back an execution id. Add a Respond to Webhook node returning { \"executionId\": \"={{$execution.id}}\" }.");
    return { platform: "n8n", handle: makeHandle("n8n", executionId), status: "running" };
  }
  async status(taskId: string): Promise<PlatformRun> {
    const token = await this.token();
    const url = new URL(`api/v1/executions/${encodeURIComponent(taskId)}`, this.config.apiBase.replace(/\/?$/, "/"));
    await this.policy.assertAllowed(url, "n8n address");
    const response = await this.fetchImpl(url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: { "X-N8N-API-KEY": token, accept: "application/json", "user-agent": this.userAgent },
    });
    const text = scrubSecrets((await response.text()).slice(0, this.config.maxBytes), { [this.config.tokenSecret]: token });
    if (!response.ok) throw new Error(explainPlatform("n8n", response.status, text));
    const data = (text ? JSON.parse(text) : {}) as { finished?: unknown; status?: unknown; data?: { resultData?: { error?: unknown } } };
    const failed = data.status === "error" || data.status === "crashed" || Boolean(data.data?.resultData?.error);
    const status: PlatformRunStatus = failed ? "failed" : data.finished ? "succeeded" : "running";
    const error = data.data?.resultData?.error;
    return {
      platform: "n8n", handle: makeHandle("n8n", taskId), status,
      ...(typeof error === "string" && error ? { error } : {}),
    };
  }
}

/** A hosted platform's answer in words the owner can act on. */
export function explainPlatform(platform: "Dify" | "n8n", status: number, text: string): string {
  const detail = (/"message"\s*:\s*"([^"]{0,200})"/.exec(text)?.[1] ?? "").trim();
  if (status === 401 || status === 403) return `${platform} did not accept the key. Save a new ${platform} API key in your secrets.`;
  if (status === 404) return `${platform} could not find that workflow or run.`;
  if (status === 429) return `${platform} says you have made too many requests. Try again shortly.`;
  if (status >= 500) return `${platform} is having trouble right now. Try again shortly.`;
  return `${platform} answered ${status}${detail ? `: ${detail}` : ""}.`;
}

/** The hosted workflow platforms the owner has connected. Missing from here means not configured. */
export interface PlatformBridges {
  dify?: WorkflowPlatform;
  n8n?: WorkflowPlatform;
}

export class PlatformBridgeAccess {
  constructor(private readonly platforms: PlatformBridges) {}
  available(): PlatformName[] {
    return platformNames.filter((name) => this.platforms[name]);
  }
  private of(name: PlatformName): WorkflowPlatform {
    const bridge = this.platforms[name];
    if (!bridge) throw new Error(`${name === "dify" ? "Dify" : "n8n"} is not set up. Turn it on in the integration settings and save its API key.`);
    return bridge;
  }
  async trigger(input: { platform: PlatformName; workflowId: string; inputs: Record<string, unknown> }): Promise<PlatformRun> {
    return this.of(input.platform).trigger({ workflowId: input.workflowId, inputs: input.inputs });
  }
  /** Reads a run back by the exact handle a trigger call returned; never by a raw id alone. */
  async status(handle: string): Promise<PlatformRun> {
    const { platform, taskId } = readHandle(handle);
    return this.of(platform).status(taskId);
  }
}

const inputsShape = z.record(z.string().max(100), z.union([z.string().max(4000), z.number(), z.boolean(), z.null()])).default({});
const triggerInput = z.object({
  platform: z.enum(platformNames),
  /** Dify: the workflow is chosen by the API key, so this is kept as the caller's own label. n8n: the webhook trigger's path. */
  workflowId: z.string().trim().min(1).max(200),
  inputs: inputsShape,
}).strict();
const statusInput = z.object({
  /** The handle a platforms.trigger call returned, such as "dify:abc123" — never a bare id. */
  handle: z.string().trim().min(3).max(300),
}).strict();

export function registerPlatformBridge(registry: ToolRegistry, bridge: PlatformBridgeAccess): void {
  registry.register({
    name: "platforms.trigger", permission: "platforms.run",
    description: "Start a run of a workflow built on a hosted platform (Dify or n8n) and get back a handle to check on it later.",
    parameters: triggerInput,
    execute: (input) => bridge.trigger(input),
  });
  registry.register({
    name: "platforms.status", permission: "platforms.read",
    description: "Check how a hosted workflow run is going, by the handle platforms.trigger returned.",
    parameters: statusInput,
    execute: (input) => bridge.status(input.handle),
  });
}

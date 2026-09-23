import { z } from "zod";
import { audit } from "../audit.js";
import type { Store } from "../store.js";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";

/**
 * FQ-execution.remote (serverless half): a function reached over HTTPS — a Cloudflare Worker, an
 * AWS Lambda function URL, or anything else the owner deployed themselves — held to the same rule
 * SSH computers are held to in `./ssh-workspace.ts`: nothing may be called by name unless the
 * owner listed it first, one function at a time. Branch installs nothing, keeps no cloud SDK and
 * no stored credential; it only ever sends the JSON body the endpoint's own contract expects, over
 * a plain `fetch`, and only to an address the owner already typed in themselves.
 *
 * The parallel with `RemoteWorkspaces` is deliberate: `computer.executables` there is
 * `endpoint.functions` here, and `execute()` refuses exactly the same way — by name, before any
 * network call is made — so a fresh endpoint starts able to answer Branch's own probe and nothing
 * else. `remote.run` and `serverless.run` share the `remote.execute` permission and the same
 * "alias: program" target shape on purpose, so approvals, policy rows and activity lines treat a
 * program on another computer and a call to a serverless function the same way.
 */
export const endpointIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  "Give the endpoint a short name, such as \"reports\"");
const remoteTextPattern = /^[^\0\r\n]*$/;
const remoteTextMessage = "Function names and arguments cannot contain NUL or a line break";
const functionNameSchema = z.string().regex(remoteTextPattern, remoteTextMessage).trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, "Function names may only use letters, numbers, dots, dashes and underscores");
const httpsUrlSchema = z.string().trim().max(2000).regex(remoteTextPattern, remoteTextMessage).url()
  .refine((url) => url.startsWith("https://"), "The endpoint has to be reached over https://; Branch never calls a plain http:// address");
const argSchema = z.union([z.string().max(300).regex(remoteTextPattern, remoteTextMessage), z.number(), z.boolean(), z.null()]);

export const ServerlessEndpointSchema = z.object({
  id: endpointIdSchema,
  url: httpsUrlSchema,
  /** A name the owner will recognise in the list. */
  label: z.string().trim().max(80).default(""),
  /**
   * The only functions that may be invoked at that endpoint. Empty means none: a fresh endpoint
   * can answer Branch's own probe and nothing else, and the owner adds what it may run one at a
   * time, exactly as they add executables to a remote computer.
   */
  functions: z.array(functionNameSchema).max(32).default([]),
  addedAt: z.string().max(40).default(""),
}).strict();
export type ServerlessEndpoint = z.infer<typeof ServerlessEndpointSchema>;
const ListSchema = z.object({ endpoints: z.array(ServerlessEndpointSchema).max(16).default([]) }).strict();
const endpointsKey = "serverless-endpoints";
const maxResponseBytes = 65536;
/** Reserved: never one of the owner's own functions, so it can never collide with an allowed name. */
export const probeFunction = "__branch_probe__";

/** One call to a serverless function's own HTTPS address. Replaced in tests, so nothing is really called. */
export interface ServerlessInvoke {
  (url: string, body: { function: string; args: unknown[] }, signal: AbortSignal):
    Promise<{ ok: boolean; statusCode: number; body: string; error?: string }>;
}

/**
 * The real one: a plain HTTPS POST with the function name and its arguments as JSON, nothing else
 * attached — no cloud SDK, no stored key, no query-string secret. The response body is read with a
 * hard byte cap so a runaway function can never hand back more than an answer needs.
 */
export function serverlessInvoker(timeoutMs = 30_000): ServerlessInvoke {
  return async (url, body, signal) => {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      const text = await readCapped(response, maxResponseBytes);
      return { ok: response.ok, statusCode: response.status, body: text };
    } catch (error) {
      return { ok: false, statusCode: 0, body: "", error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}

/** Reads a response body up to a byte cap, never buffering more than that even if the body is bigger. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, maxBytes);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || total >= maxBytes) { if (!done) void reader.cancel(); break; }
    const room = maxBytes - total;
    const piece = value.length > room ? value.slice(0, room) : value;
    chunks.push(Buffer.from(piece));
    total += piece.length;
    if (total >= maxBytes) { void reader.cancel(); break; }
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class ServerlessEndpoints {
  constructor(
    private readonly store: Store, private readonly owner: string,
    private readonly invoke: ServerlessInvoke,
  ) {}

  list(): ServerlessEndpoint[] {
    const saved = ListSchema.safeParse(this.store.get("settings", this.owner, endpointsKey)?.data ?? {});
    return saved.success ? saved.data.endpoints : [];
  }
  get(id: string): ServerlessEndpoint {
    const found = this.list().find((endpoint) => endpoint.id === id);
    if (!found) throw new Error(`"${id}" is not one of the serverless functions you have set up. The owner adds those in Settings.`);
    return found;
  }

  /**
   * Adds an endpoint. It is only accepted once it actually answers Branch's own probe over https —
   * the same spirit as SSH's known_hosts check in `RemoteWorkspaces.add`: an address is refused,
   * not trusted, until it has already shown Branch it is really there.
   */
  async add(input: unknown, signal: AbortSignal): Promise<ServerlessEndpoint> {
    const wanted = ServerlessEndpointSchema.parse({ ...(input as object ?? {}), addedAt: new Date().toISOString() });
    const probe = await this.invoke(wanted.url, { function: probeFunction, args: [] }, signal);
    if (!probe.ok)
      throw new Error(`Branch could not reach "${wanted.id}" at that address${probe.error ? ` (${probe.error})` : ""}. Deploy it and make sure it answers before adding it here.`);
    const endpoints = [...this.list().filter((endpoint) => endpoint.id !== wanted.id), wanted];
    this.store.save("settings", this.owner, endpointsKey, { endpoints });
    audit(this.store, this.owner, { action: "channel.paired", actor: this.owner,
      subject: `${wanted.id} (${wanted.url})`, reason: "A serverless function was added as a place to work", outcome: "saved" });
    return wanted;
  }
  remove(id: string): boolean {
    const before = this.list();
    const after = before.filter((endpoint) => endpoint.id !== id);
    if (after.length === before.length) return false;
    this.store.save("settings", this.owner, endpointsKey, { endpoints: after });
    return true;
  }

  /**
   * Calls one of the functions the owner allowed at that endpoint. Anything else is refused by
   * name before any network call is made, so adding an endpoint never hands over the address.
   */
  async execute(id: string, functionName: string, args: unknown[], signal: AbortSignal):
    Promise<{ endpoint: string; function: string; output: string }> {
    const parsedName = functionNameSchema.parse(functionName);
    const endpoint = this.get(id);
    if (!endpoint.functions.includes(parsedName))
      throw new Error(`"${parsedName}" is not one of the functions "${id}" is allowed to run. The owner adds those in Settings, one at a time.`);
    const result = await this.invoke(endpoint.url, { function: parsedName, args: args.slice(0, 32) }, signal);
    if (!result.ok) throw new Error(explainServerless(id, result));
    return { endpoint: id, function: parsedName, output: result.body.slice(0, 32768) };
  }
}

/** The invoker's own wording turned into something the owner can act on. */
export function explainServerless(id: string, result: { statusCode: number; error?: string }): string {
  if (result.error) return `${id} did not answer: ${result.error.slice(0, 200)}.`;
  if (result.statusCode === 0) return `${id} did not answer in time.`;
  if (result.statusCode === 404) return `${id} does not know that function.`;
  if (result.statusCode === 401 || result.statusCode === 403) return `${id} refused Branch's request.`;
  return `${id} answered with an error (status ${result.statusCode}).`;
}

const EndpointIdInput = { endpoint: endpointIdSchema };
export const ServerlessListSchema = z.object({}).strict();
export const ServerlessRunSchema = z.object({
  ...EndpointIdInput,
  function: functionNameSchema,
  args: z.array(argSchema).max(32).default([]),
}).strict();

export function registerServerlessEndpoints(registry: ToolRegistry, endpoints: ServerlessEndpoints): void {
  registry.register({
    name: "serverless.list", permission: "files.read", group: "serverless",
    description: "List the serverless functions the owner has set up, and which of their own functions each one may run.",
    parameters: ServerlessListSchema,
    target: () => "the serverless functions set up",
    execute: async () => ({ endpoints: endpoints.list().map(({ id, url, label, functions }) => ({ id, url, label, functions })) }),
  });
  registry.register({
    name: "serverless.run", permission: "remote.execute", group: "serverless",
    description: "Run one of the functions the owner has allowed at one of their serverless endpoints. Anything not on that endpoint's own list is refused, exactly as a program over SSH would be.",
    parameters: ServerlessRunSchema,
    target: (args) => `${args.endpoint}: ${args.function}`.slice(0, 300),
    execute: (args, context: ToolContext) => endpoints.execute(args.endpoint, args.function, args.args, context.signal),
  });
}

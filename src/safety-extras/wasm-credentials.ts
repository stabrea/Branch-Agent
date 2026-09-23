import { z } from "zod";
import type { NetworkPolicy } from "../network-policy.js";
import type { Store } from "../store.js";
import { scrubSecrets, secretNameSchema } from "../locker.js";

/**
 * security.credentials: the host-side credential path for a WebAssembly add-on. A module never
 * imports anything that could reach a secret and never speaks to the network itself (wasm-check.ts
 * allows only branch.memory, input_size, read_input, write_output and log). An add-on may instead
 * declare, at install time, the one request the host should make for it before it runs: an address,
 * the header to carry the credential, and the name of a project secret from the locker
 * (../locker.ts) to put there.
 *
 * The secret is read from the locker and put on the request only at the moment it is sent, exactly
 * as a skill package's declared web call does it (../skill-http-tools.ts) — never inside the bytes
 * `read_input` hands the module, and never inside the module's `write_output` or `log`, because what
 * the module receives is the host's answer, not the credential. On the chance a server echoes the
 * credential back in its answer, every occurrence of its value is replaced before the module ever
 * sees the text, so nothing the module could write out ever holds it either.
 */
const headerName = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,39}$/, "Header names look like X-Api-Key");
export const WasmCredentialCallSchema = z.object({
  /** Where the host asks; no placeholders, since only the host ever sees the secret that goes with it. */
  url: z.string().max(500).regex(/^https?:\/\/[^\s{}]+$/, "Addresses start with http:// or https:// and hold no placeholders"),
  header: headerName,
  secret: secretNameSchema,
}).strict();
export type WasmCredentialCall = z.infer<typeof WasmCredentialCallSchema>;

const maxAnswerBytes = 262_144;
export interface WasmCredentialHost { store: Store; policy: NetworkPolicy; fetchImpl?: typeof fetch }
export interface WasmCredentialAnswer { status: number; body: string }

/** Reads the answer, refusing an oversized one before the whole body is held in memory. */
async function readBounded(response: Response, host: string): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxAnswerBytes) throw new Error(`${host} sent back more than a WebAssembly add-on's request accepts`);
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxAnswerBytes) { await reader.cancel(); throw new Error(`${host} sent back more than a WebAssembly add-on's request accepts`); }
    parts.push(value);
  }
  return Buffer.concat(parts.map((part) => Buffer.from(part))).toString("utf8");
}

/**
 * Performs one add-on's declared request. The secret is resolved from the owner's active project's
 * locker, sent as the one header the add-on named, and never handed back: what comes back is the
 * response's status and its body with every occurrence of the secret's value scrubbed out, so the
 * caller — the sealed worker that runs the module — cannot pass the credential on even by accident.
 */
export async function fetchForAddOn(host: WasmCredentialHost, owner: string, call: WasmCredentialCall): Promise<WasmCredentialAnswer> {
  const target = new URL(call.url);
  await host.policy.assertAllowed(target, "WebAssembly add-on credential call");
  const project = host.store.projects.active(owner).id;
  const secrets = await host.store.locker.resolve(owner, project, [call.secret]);
  const value = secrets[call.secret]!;
  const response = await (host.fetchImpl ?? globalThis.fetch)(target,
    { method: "GET", headers: { [call.header]: value, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(20000) });
  const text = await readBounded(response, target.host);
  return { status: response.status, body: scrubSecrets(text, secrets) };
}

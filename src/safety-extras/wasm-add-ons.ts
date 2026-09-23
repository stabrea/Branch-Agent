import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { audit } from "../audit.js";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { requireSafety } from "./settings.js";
import { capabilityRefusal } from "./wasm-capabilities.js";
import { capabilityNames, deriveCapabilities, readWasmShape, wasmRefusal, type WasmCapability } from "./wasm-check.js";
import { fetchForAddOn, WasmCredentialCallSchema, type WasmCredentialCall, type WasmCredentialHost } from "./wasm-credentials.js";

/**
 * mac7/r17-g (R17-062): add-ons written as WebAssembly, run in a sealed box. This sits beside the
 * walled add-on programs of bucket 15 (src/add-ons/walled-plugin.ts), which run JavaScript behind the
 * system's wall; a WebAssembly add-on needs no wall at all, because it is given nothing to reach:
 *
 *  - imports only from "branch": its input, a place to write its answer, and a log (src/safety-extras/wasm-check.ts);
 *  - a hard memory ceiling (its memory must declare one, or Branch hands it one), and a separate
 *    worker thread with a small heap of its own;
 *  - a time limit: the worker is ended when it runs over, however busy it is (Node has no fuel
 *    counter, so time stands in for it);
 *  - its bytes are kept with their fingerprint when the owner installs it, and anything else is refused.
 *    Integration review: the fingerprint is kept in the database as well as beside the file, so the
 *    two files rewritten together are still refused; at most two add-ons run at once; a damaged note
 *    is skipped rather than breaking the list; removing one is written in the record.
 *
 * Built with Node's own WebAssembly and worker threads only; no dependency. IronClaw's
 * `ironclaw_wasm` lane (MIT or Apache-2.0) was read for the shape of the limits.
 */
export const WasmInstallSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Use lowercase letters, digits and dashes"),
  description: z.string().trim().max(500).default(""),
  /** The module's bytes, in base64. */
  wasm: z.string().min(8).max(8_000_000),
  maxMemoryMb: z.number().int().min(1).max(256).default(16),
  timeoutMs: z.number().int().min(100).max(30_000).default(5000),
  /** What this tool may reach, declared up front rather than left to whatever it happens to import.
   *  Left out, it keeps the old behaviour: it gets whatever branch capabilities it imports. */
  capabilities: z.array(z.enum(capabilityNames)).max(capabilityNames.length).optional(),
  /**
   * security.credentials: the one host-side request this add-on needs, if any. Declared here so the
   * owner sees it before installing; never the secret's value, only which locker name to send and
   * where. See wasm-credentials.ts for why the module itself never touches it.
   */
  call: WasmCredentialCallSchema.optional(),
}).strict();
export interface WasmManifest { name: string; description: string; sha256: string; bytes: number; maxMemoryMb: number; timeoutMs: number; installedAt: string; capabilities: WasmCapability[]; call?: WasmCredentialCall }
export const WasmRunSchema = z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), input: z.string().max(1_000_000).default("") }).strict();
export interface WasmRun { ok: boolean; code: number | null; output: string; log: string; error?: string; durationMs: number }

const maxOutputBytes = 1_000_000;
/** Each run may hold up to 256 MB, so only a couple run at once. */
export const maxRunsAtOnce = 2;
const fingerprintKey = (name: string): string => `safety-wasm-add-on:${name}`;
const pages = (mb: number): number => Math.floor(mb * 1_048_576 / 65_536);
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { bytes, input, minPages, maxPages, maxOutput, importsMemory, capabilities } = workerData;
const allowed = new Set(capabilities);
const text = new TextEncoder().encode(input);
const imported = importsMemory ? new WebAssembly.Memory({ initial: minPages, maximum: maxPages }) : null;
let memory = imported, size = 0, log = "";
const out = [];
const view = () => new Uint8Array(memory.buffer);
const branch = {
  memory: imported,
  input_size: () => text.length,
  read_input: (ptr) => { view().set(text, ptr >>> 0); },
  write_output: (ptr, len) => {
    ptr >>>= 0; len >>>= 0;
    if (size + len > maxOutput) throw new Error("the answer is too large");
    out.push(view().slice(ptr, ptr + len)); size += len;
  },
  log: (ptr, len) => { if (log.length < 16000) log += new TextDecoder().decode(view().slice(ptr >>> 0, (ptr >>> 0) + (len >>> 0))); },
};
try {
  const module = new WebAssembly.Module(bytes);
  const wanted = new Set(WebAssembly.Module.imports(module).map((entry) => entry.name));
  // Only what this tool both imports AND declared: memory is not a capability, so it is exempt.
  const given = Object.fromEntries(Object.entries(branch).filter(([name]) => wanted.has(name) && (name === "memory" || allowed.has(name))));
  const instance = new WebAssembly.Instance(module, { branch: given });
  memory = memory || instance.exports.memory;
  const code = instance.exports.run();
  const all = new Uint8Array(size);
  let at = 0;
  for (const piece of out) { all.set(piece, at); at += piece.length; }
  parentPort.postMessage({ ok: code === 0, code, output: new TextDecoder().decode(all), log });
} catch (error) {
  parentPort.postMessage({ ok: false, code: null, output: "", log, error: String(error && error.message || error).slice(0, 300) });
}
`;

/** One run in a fresh worker, ended at the time limit. `capabilities` defaults to the full catalog, so
 *  a call that predates capability declarations keeps getting whatever it imports, as before. An
 *  operation the module's bytes ask for but `capabilities` does not grant refuses the run before a
 *  worker even starts. */
export function runWasm(bytes: Uint8Array<ArrayBuffer>, input: string, limits: { maxMemoryMb: number; timeoutMs: number }, capabilities: readonly string[] = capabilityNames): Promise<WasmRun> {
  const started = Date.now();
  const refusal = capabilityRefusal(bytes, capabilities);
  if (refusal) return Promise.resolve({ ok: false, code: null, output: "", log: "", error: refusal, durationMs: Date.now() - started });
  const shape = readWasmShape(bytes);
  // A memory the module imports may not be larger than it said, nor than the owner allows.
  const ceiling = Math.min(pages(limits.maxMemoryMb), shape.imported?.max ?? Number.MAX_SAFE_INTEGER);
  const worker = new Worker(workerSource, { eval: true, env: {}, execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, codeRangeSizeMb: 16, stackSizeMb: 4 },
    workerData: { bytes, input, minPages: shape.imported?.min ?? 0, maxPages: ceiling, maxOutput: maxOutputBytes, importsMemory: !!shape.imported, capabilities } });
  return new Promise<WasmRun>((resolve) => {
    const finish = (run: Omit<WasmRun, "durationMs">) => { clearTimeout(timer); void worker.terminate(); resolve({ ...run, durationMs: Date.now() - started }); };
    const timer = setTimeout(() => finish({ ok: false, code: null, output: "", log: "", error: `It ran longer than ${limits.timeoutMs} ms and was stopped.` }), limits.timeoutMs);
    worker.once("message", (message: Omit<WasmRun, "durationMs">) => finish(message));
    worker.once("error", (error) => finish({ ok: false, code: null, output: "", log: "", error: `It was stopped: ${error.message.slice(0, 200)}` }));
    worker.once("exit", () => finish({ ok: false, code: null, output: "", log: "", error: "It stopped without answering." }));
  });
}

export class WasmAddOns {
  private running = 0;
  constructor(
    private readonly store: Store, private readonly owner: string, private readonly folder: string,
    /** Used only for an add-on's declared host-side credential call, if it has one (wasm-credentials.ts). */
    private readonly credentialHost?: WasmCredentialHost,
  ) {}

  private file(name: string, ending: "wasm" | "json"): string { return join(this.folder, `${name}.${ending}`); }

  async list(): Promise<WasmManifest[]> {
    const names = await readdir(this.folder).catch(() => [] as string[]);
    const found = await Promise.all(names.filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try { return JSON.parse(await readFile(join(this.folder, name), "utf8")) as WasmManifest; } catch { return null; }
      }));
    return found.filter((entry): entry is WasmManifest => !!entry && typeof entry.name === "string" && typeof entry.sha256 === "string")
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The owner installs a module (or wasm-build.ts builds one): it is checked against its own declared
   *  capabilities — or, absent a declaration, whatever it already imports, kept for compatibility — then
   *  kept with its fingerprint and capabilities, and written in the record. */
  async install(input: unknown): Promise<WasmManifest> {
    const value = WasmInstallSchema.parse(input);
    const bytes = new Uint8Array(Buffer.from(value.wasm, "base64"));
    const capabilities = value.capabilities ?? deriveCapabilities(bytes);
    const refusal = wasmRefusal(bytes, pages(value.maxMemoryMb), capabilities);
    if (refusal) throw new Error(refusal);
    const manifest: WasmManifest = { name: value.name, description: value.description, sha256: sha(bytes), bytes: bytes.length,
      maxMemoryMb: value.maxMemoryMb, timeoutMs: value.timeoutMs, installedAt: new Date().toISOString(), capabilities, ...(value.call ? { call: value.call } : {}) };
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    await writeFile(this.file(value.name, "wasm"), bytes, { mode: 0o600 });
    await writeFile(this.file(value.name, "json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    this.store.save("settings", this.owner, fingerprintKey(value.name), { sha256: manifest.sha256, maxMemoryMb: manifest.maxMemoryMb, timeoutMs: manifest.timeoutMs, capabilities });
    audit(this.store, this.owner, { action: "policy.changed", actor: this.owner, subject: `WebAssembly add-on ${value.name}`,
      reason: `Installed, fingerprint ${manifest.sha256.slice(0, 16)}; it runs sealed, with ${value.maxMemoryMb} MB, ${value.timeoutMs} ms, and capabilities: ${capabilities.length ? capabilities.join(", ") : "none"}`, outcome: "saved" });
    return manifest;
  }

  async remove(name: string): Promise<boolean> {
    const known = (await this.list()).some((entry) => entry.name === name);
    if (!known) return false;
    await rm(this.file(name, "wasm"), { force: true });
    await rm(this.file(name, "json"), { force: true });
    this.store.delete("settings", this.owner, fingerprintKey(name));
    audit(this.store, this.owner, { action: "policy.changed", actor: this.owner, subject: `WebAssembly add-on ${name}`,
      reason: "Removed", outcome: "saved" });
    return true;
  }

  /** The kept limits and capabilities, as the owner installed them; the note beside the file must
   *  agree on the fingerprint. Capabilities come from the store record, the same source of truth as
   *  the fingerprint: rewriting the note beside the file cannot widen what a tool is given. */
  private async checked(name: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; limits: { maxMemoryMb: number; timeoutMs: number }; capabilities: WasmCapability[]; call?: WasmCredentialCall }> {
    const manifest = (await this.list()).find((entry) => entry.name === name);
    if (!manifest) throw new Error(`There is no WebAssembly add-on called ${name}.`);
    const kept = this.store.get("settings", this.owner, fingerprintKey(name))?.data as { sha256?: unknown; maxMemoryMb?: unknown; timeoutMs?: unknown; capabilities?: unknown } | undefined;
    const bytes = new Uint8Array(await readFile(this.file(name, "wasm")));
    const actual = sha(bytes);
    if (actual !== manifest.sha256 || actual !== kept?.sha256)
      throw new Error(`${name} is not what it was when it was installed, so it was not run. Install it again.`);
    const limits = { maxMemoryMb: Math.min(Number(kept.maxMemoryMb) || 16, manifest.maxMemoryMb, 256), timeoutMs: Math.min(Number(kept.timeoutMs) || 5000, manifest.timeoutMs, 30_000) };
    const capabilities: WasmCapability[] = Array.isArray(kept.capabilities)
      ? kept.capabilities.filter((name): name is WasmCapability => capabilityNames.includes(name as WasmCapability))
      : deriveCapabilities(bytes);
    const refusal = wasmRefusal(bytes, pages(limits.maxMemoryMb), capabilities);
    if (refusal) throw new Error(refusal);
    return { bytes, limits, capabilities, ...(manifest.call ? { call: manifest.call } : {}) };
  }

  async run(input: z.input<typeof WasmRunSchema>, context?: Pick<ToolContext, "runId">): Promise<WasmRun> {
    requireSafety(this.store, this.owner, "wasm-add-ons");
    const { name, input: text } = WasmRunSchema.parse(input);
    if (this.running >= maxRunsAtOnce) throw new Error(`${maxRunsAtOnce} WebAssembly add-ons are already running. Try again when one has finished.`);
    this.running++;
    try {
      const { bytes, limits, capabilities, call } = await this.checked(name);
      // security.credentials: when the add-on declared a host-side request, the host makes it and
      // hands the module only the (scrubbed) answer — never the caller's own text, and never the
      // credential. The module was never given a way to ask for either itself.
      let fed = text, usedCredential = false;
      if (call) {
        if (!this.credentialHost) throw new Error(`${name} needs a host-side credential call, and this launch has no network policy set up for one.`);
        const answer = await fetchForAddOn(this.credentialHost, this.owner, call);
        fed = answer.body;
        usedCredential = true;
      }
      const run = await runWasm(bytes, fed, limits, capabilities);
      if (context?.runId) this.store.event(context.runId, "wasm.ran", { name, ok: run.ok, durationMs: run.durationMs, credential: usedCredential });
      return run;
    } finally { this.running--; }
  }
}

export function registerWasmAddOns(registry: ToolRegistry, addOns: WasmAddOns): void {
  registry.register({
    name: "wasm.run", permission: "addons.wasm", group: "code",
    description: "Run one of the owner's installed WebAssembly add-ons on a piece of text. It runs sealed: no files, no internet, a memory and time limit. Returns what it wrote and its log.",
    parameters: WasmRunSchema,
    target: (args) => `the WebAssembly add-on ${args.name}`,
    execute: (args, context) => addOns.run(args, context),
  });
}

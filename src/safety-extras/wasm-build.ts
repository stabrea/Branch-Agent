import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { WasmAddOns, WasmInstallSchema, type WasmManifest } from "./wasm-add-ons.js";
import { capabilityNames, type WasmCapability } from "./wasm-check.js";
import { requireSafety } from "./settings.js";

/**
 * FQ-extensions.tool-building: closes the wasm-add-ons gap in wasm-add-ons.ts / wasm-check.ts — Branch
 * builds a requested tool itself, from a small fixed catalog of templates, instead of only accepting
 * bytes the owner already compiled. Each template declares its OWN capabilities (a subset of
 * wasm-check.ts's `capabilityNames`), and only those are wired in at run time (see wasm-add-ons.ts
 * `checked`/`runWasm`) — one template can read input and write output, another can only log, and
 * neither gets what it did not declare. That is the "capabilities declared per tool rather than one
 * fixed import list" the queue asked for.
 *
 * The assembler below writes the WebAssembly binary format by hand (magic, sections, LEB128), the same
 * way tests/safety-extras-wasm.test.mjs already builds its fixture modules — no compiler, no dependency.
 * It is a tiny, fixed set of templates, not a general compiler: "build a requested tool" here means
 * choosing and parameterising one of these, not compiling arbitrary source.
 */
export type WasmTemplateName = "echo" | "announce";
export const wasmTemplateNames: readonly WasmTemplateName[] = ["echo", "announce"];
export interface WasmTemplate { capabilities: readonly WasmCapability[]; describe: string }
export const wasmTemplates: Readonly<Record<WasmTemplateName, WasmTemplate>> = {
  echo: { capabilities: ["input_size", "read_input", "write_output"], describe: "Copies its input back out unchanged." },
  announce: { capabilities: ["log"], describe: "Logs a fixed message you choose and returns; it is never given input or output." },
};

/* ---------- a tiny assembler (mirrors tests/safety-extras-wasm.test.mjs) ---------- */
const leb = (n: number): number[] => { const out: number[] = []; do { let byte = n & 0x7f; n >>>= 7; if (n) byte |= 0x80; out.push(byte); } while (n); return out; };
const str = (text: string): number[] => [...leb(Buffer.byteLength(text)), ...Buffer.from(text)];
const vec = (items: number[][]): number[] => [...leb(items.length), ...items.flat()];
const section = (id: number, contents: number[]): number[] => [id, ...leb(contents.length), ...contents];
const I32 = 0x7f;
const fn = (params: number[], results: number[]): number[] => [0x60, ...vec(params.map((p) => [p])), ...vec(results.map((r) => [r]))];
const limits = (min: number, max?: number): number[] => (max === undefined ? [0x00, ...leb(min)] : [0x01, ...leb(min), ...leb(max)]);
const body = (locals: number[][], code: number[]): number[] => { const inner = [...vec(locals), ...code, 0x0b]; return [...leb(inner.length), ...inner]; };
const imp = (name: string, kind: number, desc: number[]): number[] => [...str("branch"), ...str(name), kind, ...desc];
const dataSegment = (offset: number, bytes: Buffer): number[] => [0x00, 0x41, ...leb(offset), 0x0b, ...leb(bytes.length), ...bytes];

interface ModuleParts {
  types: number[][]; imports?: number[][]; funcs?: number[]; memory?: number[];
  exports: number[][]; code: number[][]; data?: number[][];
}
function assemble(parts: ModuleParts): Uint8Array {
  const { types, imports = [], funcs = [], memory, exports, code, data = [] } = parts;
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...(imports.length ? section(2, vec(imports)) : []),
    ...section(3, vec(funcs.map((type) => leb(type)))),
    ...(memory ? section(5, vec([memory])) : []),
    ...section(7, vec(exports)),
    ...section(10, vec(code)),
    ...(data.length ? section(11, vec(data)) : []),
  ]);
}

/** input_size() -> i32; read_input(ptr); write_output(ptr, len); returns what it was given, unchanged. */
function buildEcho(maxPages: number): Uint8Array {
  return assemble({
    types: [fn([], [I32]), fn([I32], []), fn([I32, I32], [])],
    imports: [imp("memory", 0x02, limits(1, maxPages)), imp("input_size", 0x00, [0]), imp("read_input", 0x00, [1]), imp("write_output", 0x00, [2])],
    funcs: [0],
    exports: [[...str("run"), 0x00, 3]],
    code: [body([[1, I32]], [0x41, 0, 0x10, 1, 0x10, 0, 0x21, 0, 0x41, 0, 0x20, 0, 0x10, 2, 0x41, 0])],
  });
}

/** log(ptr, len); logs a fixed, owner-chosen message baked in at build time and returns; no input or output. */
function buildAnnounce(message: string): Uint8Array {
  const bytes = Buffer.from(message, "utf8");
  return assemble({
    types: [fn([I32, I32], []), fn([], [I32])],
    imports: [imp("log", 0x00, [0])],
    funcs: [1],
    memory: limits(1, 1),
    exports: [[...str("run"), 0x00, 1], [...str("memory"), 0x02, 0]],
    // i32.const 0 (ptr); i32.const <len>; call log(ptr, len); i32.const 0 (return value)
    code: [body([], [0x41, 0, 0x41, ...leb(bytes.length), 0x10, 0, 0x41, 0])],
    data: [dataSegment(0, bytes)],
  });
}

const pages = (mb: number): number => Math.floor(mb * 1_048_576 / 65_536);

export const WasmBuildSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Use lowercase letters, digits and dashes"),
  description: z.string().trim().max(500).default(""),
  template: z.enum(wasmTemplateNames as [WasmTemplateName, ...WasmTemplateName[]]),
  /** Only used by the "announce" template; baked into the module at build time. */
  message: z.string().trim().min(1).max(200).default("Hello from a built add-on."),
  maxMemoryMb: z.number().int().min(1).max(256).default(16),
  timeoutMs: z.number().int().min(100).max(30_000).default(5000),
}).strict();
export type WasmBuildInput = z.input<typeof WasmBuildSchema>;

export class WasmBuilder {
  constructor(private readonly addOns: WasmAddOns, private readonly store: Store, private readonly owner: string) {}

  /** Builds one of the fixed templates and installs it through the same pipeline `install` uses, so
   *  fingerprinting, the stored capability record and the audit entry all stay in one place. */
  async build(input: unknown): Promise<WasmManifest> {
    requireSafety(this.store, this.owner, "wasm-add-ons");
    const value = WasmBuildSchema.parse(input);
    const template = wasmTemplates[value.template];
    const bytes = value.template === "echo" ? buildEcho(pages(value.maxMemoryMb)) : buildAnnounce(value.message);
    const install = WasmInstallSchema.parse({
      name: value.name, description: value.description || template.describe,
      wasm: Buffer.from(bytes).toString("base64"),
      maxMemoryMb: value.maxMemoryMb, timeoutMs: value.timeoutMs,
      capabilities: [...template.capabilities],
    });
    return this.addOns.install(install);
  }
}

export function registerWasmBuild(registry: ToolRegistry, builder: WasmBuilder): void {
  registry.register({
    name: "wasm.build", permission: "addons.wasm", group: "code",
    description: "Build a new WebAssembly add-on from a template and install it, ready for wasm.run. "
      + "\"echo\" copies its input back out (capabilities: input_size, read_input, write_output). "
      + "\"announce\" logs a fixed message you choose and returns (capability: log only). "
      + "Each template is given only the host capabilities it declares, never the whole set.",
    parameters: WasmBuildSchema,
    target: (args) => `a new WebAssembly add-on ${(args as { name: string }).name} built from the ${(args as { template: string }).template} template`,
    execute: (args) => builder.build(args),
  });
}

/**
 * mac7/r17-g (R17-062): what a WebAssembly add-on asks for, read from its bytes before anything of
 * it runs. Only Node's built-in WebAssembly is used; the few section layouts below are the ones
 * the WebAssembly core specification gives (imports are section 2, memories section 5).
 *
 * An add-on may import only from "branch", and only these names. It gets no files, no network, no
 * clock and no randomness: whatever it needs comes in as its input.
 */
export const allowedImports: Readonly<Record<string, "function" | "memory">> = {
  memory: "memory", input_size: "function", read_input: "function", write_output: "function", log: "function",
};
/** The function capabilities a tool may declare (everything in `allowedImports` except `memory`,
 *  which is not a capability — it is how a module reaches its bytes, always allowed on its own). */
export const capabilityNames = ["input_size", "read_input", "write_output", "log"] as const;
export type WasmCapability = (typeof capabilityNames)[number];
const pageBytes = 65_536;

export interface MemoryLimits { min: number; max: number | null; shared: boolean; wide: boolean }
export interface WasmShape { imported: MemoryLimits | null; own: MemoryLimits[] }

class Reader {
  offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  byte(): number {
    if (this.offset >= this.bytes.length) throw new Error("The add-on's file ends too early.");
    return this.bytes[this.offset++]!;
  }
  leb(): number {
    let result = 0, shift = 0, byte: number;
    do {
      byte = this.byte();
      if (shift < 35) result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }
  skip(count: number): void { this.offset += count; }
  name(): string { const length = this.leb(); const text = Buffer.from(this.bytes.subarray(this.offset, this.offset + length)).toString("utf8"); this.skip(length); return text; }
  limits(): MemoryLimits {
    const flags = this.byte(), min = this.leb();
    const max = flags & 1 ? this.leb() : null;
    return { min, max, shared: (flags & 2) !== 0, wide: (flags & 4) !== 0 };
  }
}

function skipImport(reader: Reader, kind: number): MemoryLimits | null {
  if (kind === 0) { reader.leb(); return null; }
  if (kind === 1) { reader.byte(); reader.limits(); return null; }
  if (kind === 2) return reader.limits();
  if (kind === 3) { reader.byte(); reader.byte(); return null; }
  if (kind === 4) { reader.byte(); reader.leb(); return null; }
  throw new Error("The add-on imports something Branch does not recognise.");
}

/** The memory the module imports and the memories it declares for itself. */
export function readWasmShape(bytes: Uint8Array): WasmShape {
  if (bytes.length < 8 || Buffer.from(bytes.subarray(0, 4)).toString("latin1") !== "\0asm")
    throw new Error("That is not a WebAssembly file.");
  const reader = new Reader(bytes);
  reader.offset = 8;
  const shape: WasmShape = { imported: null, own: [] };
  while (reader.offset < bytes.length) {
    const id = reader.byte(), size = reader.leb(), end = reader.offset + size;
    if (id === 2) {
      for (let count = reader.leb(); count > 0; count--) {
        reader.name(); reader.name();
        const memory = skipImport(reader, reader.byte());
        if (memory) shape.imported = memory;
      }
    } else if (id === 5) {
      for (let count = reader.leb(); count > 0; count--) shape.own.push(reader.limits());
    }
    reader.offset = end;
  }
  return shape;
}

/**
 * Why this module may not run with at most `maxPages` of memory, or null. `capabilities`, when
 * given, is this tool's own declared list (wasm-add-ons.ts install/checked): a function import must
 * be in it, not just in the fixed `allowedImports` catalog, so two tools built with different
 * declared capabilities get genuinely different import surfaces even though both draw from the same
 * catalog. Omitting it keeps the old, catalog-only check (kept for call sites that predate capability
 * declarations, such as an add-on installed before this existed).
 */
export function wasmRefusal(bytes: Uint8Array<ArrayBuffer>, maxPages: number, capabilities?: readonly string[]): string | null {
  if (!WebAssembly.validate(bytes)) return "That is not a valid WebAssembly file.";
  const module = new WebAssembly.Module(bytes);
  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.module !== "branch" || allowedImports[entry.name] !== entry.kind)
      return `It asks for ${entry.module}.${entry.name}, which add-ons are not given. Only the branch input, output and log are.`;
    if (entry.name !== "memory" && capabilities && !capabilities.includes(entry.name))
      return `It asks for branch.${entry.name}, which this tool was not given. Its declared capabilities are: ${capabilities.length ? capabilities.join(", ") : "none"}.`;
  }
  const exports = WebAssembly.Module.exports(module);
  if (!exports.some((entry) => entry.name === "run" && entry.kind === "function"))
    return "It has no run function to start.";
  const shape = readWasmShape(bytes);
  if (!shape.imported && !exports.some((entry) => entry.name === "memory" && entry.kind === "memory"))
    return "It must import branch.memory or export its memory as \"memory\".";
  const memories = [...(shape.imported ? [shape.imported] : []), ...shape.own];
  if (memories.length !== 1) return "It must use exactly one memory.";
  const memory = memories[0]!;
  if (memory.shared || memory.wide) return "Shared or 64-bit memory is not supported.";
  if (memory.min > maxPages) return `It needs at least ${memory.min * pageBytes / 1_048_576} MB of memory, more than the ${maxPages * pageBytes / 1_048_576} MB allowed.`;
  if (!shape.imported && (memory.max === null || memory.max > maxPages))
    return `Its memory may grow past the ${maxPages * pageBytes / 1_048_576} MB allowed. Build it with a maximum memory size.`;
  return null;
}

/** The capabilities a module actually imports, for an add-on installed before capabilities were
 *  declared: what it already imports is what it keeps, same as the old behaviour. Assumes valid bytes. */
export function deriveCapabilities(bytes: Uint8Array<ArrayBuffer>): WasmCapability[] {
  const wanted = new Set(WebAssembly.Module.imports(new WebAssembly.Module(bytes))
    .filter((entry) => entry.module === "branch" && entry.name !== "memory").map((entry) => entry.name));
  return capabilityNames.filter((name) => wanted.has(name));
}

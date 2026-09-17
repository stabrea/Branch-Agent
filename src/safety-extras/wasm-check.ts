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

/** Why this module may not run with at most `maxPages` of memory, or null. */
export function wasmRefusal(bytes: Uint8Array<ArrayBuffer>, maxPages: number): string | null {
  if (!WebAssembly.validate(bytes)) return "That is not a valid WebAssembly file.";
  const module = new WebAssembly.Module(bytes);
  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.module !== "branch" || allowedImports[entry.name] !== entry.kind)
      return `It asks for ${entry.module}.${entry.name}, which add-ons are not given. Only the branch input, output and log are.`;
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

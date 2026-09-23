import { capabilityNames, deriveCapabilities, type WasmCapability } from "./wasm-check.js";

/**
 * mac7/r17-g (R17-062) follow-up: `wasm-check.ts` keeps one fixed list of what any add-on may import
 * from "branch" — every module gets the same four operations. This gives each module its own,
 * smaller manifest on top of that: the owner may grant a module fewer than the four, and a module
 * that asks for one it was not granted is refused, whether or not that operation is on the shared list.
 * The catalog and the per-module derivation live in wasm-check.ts, so there is one list and one wording.
 */

/** The operations a module can be granted. "memory" is not here: it is not called, so it is not
 * something a manifest grants or withholds. */
export { capabilityNames };
export type CapabilityName = WasmCapability;

const isCapabilityName = (value: unknown): value is CapabilityName => typeof value === "string" && (capabilityNames as readonly string[]).includes(value);

/** Keeps only the entries of `value` that are capability names, dropping anything else (a stray
 * setting, a typo, an old field) rather than letting it through as a grant. */
export function asCapabilityList(value: unknown): CapabilityName[] {
  return Array.isArray(value) ? value.filter(isCapabilityName) : [];
}

/** The branch.* function imports this module's own bytes ask for. This is what the module itself
 * declares it needs; a manifest granting less than this is refused. */
export function requestedCapabilities(bytes: Uint8Array<ArrayBuffer>): CapabilityName[] {
  return deriveCapabilities(bytes);
}

/** Why this module may not run with only `granted` capabilities, or null. Worded as wasmRefusal words it. */
export function capabilityRefusal(bytes: Uint8Array<ArrayBuffer>, granted: readonly string[]): string | null {
  const missing = requestedCapabilities(bytes).find((name) => !granted.includes(name));
  if (!missing) return null;
  return `It asks for branch.${missing}, which this tool was not given. Its declared capabilities are: ${granted.length ? granted.join(", ") : "none"}.`;
}

import { join } from "node:path";
import type { ToolRegistry } from "../registry.js";
import type { Runtime } from "../runtime.js";
import { wallSettings } from "../sandbox.js";
import { wallEdgeFor } from "../sandbox-wall.js";
import { ActivityChain, followActivity } from "./activity-chain.js";
import { registerToolScripts, ToolScripts } from "./tool-scripts.js";
import { registerWasmAddOns, WasmAddOns } from "./wasm-add-ons.js";
import { safetyMode, safetyParts, safetyTools, saveSafetyMode, type SafetyMode, type SafetyPart } from "./settings.js";

/**
 * mac7/r17-g: the safety extras (docs/configuration.md, "Safety extras"). `createBranch` makes one;
 * the server hands it /api/safety-extras/. Every part ships off; a part's tools are in the catalog
 * only while its switch is not off.
 */
export interface SafetyExtrasDeps { runtime: Runtime; registry: ToolRegistry; dataDir: string }

export class SafetyExtras {
  readonly chain: ActivityChain;
  readonly scripts: ToolScripts;
  readonly wasm: WasmAddOns;
  private readonly stopFollowing: () => void;
  private readonly registrars: Partial<Record<SafetyPart, () => void>>;

  constructor(private readonly deps: SafetyExtrasDeps) {
    const { runtime, registry } = deps;
    const store = runtime.store, owner = runtime.owner;
    this.chain = new ActivityChain(store.sqlite);
    this.stopFollowing = followActivity(store, owner, this.chain);
    this.scripts = new ToolScripts({ host: runtime, registry,
      unreadable: () => [...new Set([...wallSettings(store, owner).unreadable, wallEdgeFor(store).dataDir ?? deps.dataDir, deps.dataDir])] });
    this.wasm = new WasmAddOns(store, owner, join(deps.dataDir, "wasm-add-ons"));
    this.registrars = {
      "tool-scripts": () => registerToolScripts(registry, this.scripts),
      "wasm-add-ons": () => registerWasmAddOns(registry, this.wasm),
    };
    for (const part of safetyParts) this.sync(part);
  }

  close(): void { this.stopFollowing(); }

  private sync(part: SafetyPart): void {
    for (const name of safetyTools[part]) this.deps.registry.unregister(name);
    if (safetyMode(this.deps.runtime.store, this.deps.runtime.owner, part) !== "off") this.registrars[part]?.();
  }

  modes(): Record<SafetyPart, SafetyMode> {
    return Object.fromEntries(safetyParts.map((part) => [part, safetyMode(this.deps.runtime.store, this.deps.runtime.owner, part)])) as Record<SafetyPart, SafetyMode>;
  }

  setMode(part: SafetyPart, input: unknown): SafetyMode {
    const mode = saveSafetyMode(this.deps.runtime.store, this.deps.runtime.owner, part, input);
    this.sync(part);
    return mode;
  }
}

export { safetyParts, safetyLabels, safetyTools } from "./settings.js";

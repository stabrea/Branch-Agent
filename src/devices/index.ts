import type { WorkspaceFiles } from "../files.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { DeviceBook, type DeviceMode } from "./book.js";
import { onLockdownChange } from "../lockdown.js"; // mac7/lockdown-fix
import { deviceTools } from "./capabilities.js";
import { DeviceHub, type HubOptions } from "./hub.js";
import { registerDeviceTools } from "./tools.js";

/**
 * mac7/nodes: "Devices" — the owner's other computers and phones lending Branch a few abilities
 * each (see docs/configuration.md, "Devices"). `createBranch` makes one; the server hands it
 * `/api/devices` and the device socket. The whole feature ships off, and so does every capability
 * of every device.
 */
export interface DevicesDeps { store: Store; owner: string; registry: ToolRegistry; files: WorkspaceFiles; hub?: HubOptions }

export class Devices {
  readonly book: DeviceBook;
  readonly hub: DeviceHub;
  constructor(private readonly deps: DevicesDeps) {
    this.book = new DeviceBook(deps.store, deps.owner);
    this.hub = new DeviceHub(this.book, deps.hub);
    this.sync();
    // mac7/lockdown-fix (integration review): Lockdown closes every device's socket straight away.
    this.stopListening = onLockdownChange((store, owner, on) => {
      if (on && store === deps.store && owner === deps.owner) this.hub.disconnectAll("Lockdown is on.");
    });
  }
  private readonly stopListening: () => void;

  /** The tools are in the catalog exactly while the feature is not off. */
  private sync(): void {
    for (const name of deviceTools) this.deps.registry.unregister(name);
    if (this.book.savedMode() !== "off") // mac7/lockdown-fix: Lockdown is refused at use, not by unregistering
      registerDeviceTools(this.deps.registry, { store: this.deps.store, owner: this.deps.owner, book: this.book, hub: this.hub, files: this.deps.files });
  }

  setMode(input: unknown): DeviceMode {
    const mode = this.book.setMode(input);
    this.sync();
    if (mode === "off") this.hub.disconnectAll();
    return mode;
  }

  close(): void { this.stopListening(); this.hub.close(); }
}

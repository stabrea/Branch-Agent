import { z } from "zod";
import type { ChannelRouter } from "../channels/router.js";
import type { WorkspaceFiles } from "../files.js";
import type { PosixExec } from "../integrations/desktop-script-posix.js";
import { lockedDown } from "../lockdown.js";
import type { NetworkPolicy } from "../network-policy.js";
import type { ToolRegistry } from "../registry.js";
import type { Runtime } from "../runtime.js";
import { narrowed } from "../autonomy/runner.js";
import { AgentGit, type GitRunner } from "./agent-git.js";
import { MachineWindow, type MachineDirectory } from "./machines.js";
import { Arena, Notes, type ModelAccess } from "./notes.js";
import { RelayAdapter } from "./relay.js";
import { RemoteTrunks } from "./remote-trunks.js";
import { allReachModes, reachMode, reachParts, reachRecord, reachTools, saveReachMode, type ReachMode, type ReachPart } from "./settings.js";
import { SkillBundles } from "./skill-bundles.js";
import { registrars } from "./tools.js";
import { UsbTrigger, type UsbLister } from "./usb.js";
import type { VideoDeps } from "./video.js";

/**
 * Bucket R17-I (mac7/r17-i): reach and platform — other computers side by side, Trunks across
 * computers, background app use, videos, a relay, `branch send` and pausing a chat app, sharing
 * through git and skill bundles, a USB trigger, notes and a model arena. `createBranch` makes one of
 * these; the server hands it /api/reach/. Every part ships off. See docs/configuration.md,
 * "Reach and platform".
 */
export interface ReachDeps {
  runtime: Runtime;
  registry: ToolRegistry;
  router: ChannelRouter;
  files: WorkspaceFiles;
  policy: NetworkPolicy;
  /** A fetch that follows the owner's network rules. */
  fetch: typeof fetch;
  /** A named secret from the locker, filled in at the moment it is needed. */
  secret: (name: string, purpose: string) => Promise<string>;
  /** The other computers: bucket 23's node list today (see src/reach/machines.ts). */
  machines: MachineDirectory;
  version: string;
  platform: NodeJS.Platform;
  backgroundExec: PosixExec;
  git: GitRunner;
  usbLister: UsbLister;
  relayPollMs?: number;
}

const byRuntime = new WeakMap<object, Reach>();
/** The Reach part of this copy, for the typed commands. */
export const reachFor = (runtime: object): Reach | undefined => byRuntime.get(runtime);

const NameSchema = z.object({ name: z.string().trim().max(40).regex(/^[a-z0-9-]*$/).default("") }).strict();
const nameKey = "reach-machine-name";

export class Reach {
  readonly machines: MachineWindow;
  readonly remoteTrunks: RemoteTrunks;
  readonly relay: RelayAdapter;
  readonly git: AgentGit;
  readonly bundles: SkillBundles;
  readonly usb: UsbTrigger;
  readonly notes: Notes;
  readonly arena: Arena;
  private relayAttached = false;

  constructor(readonly deps: ReachDeps) {
    const { runtime } = deps, store = runtime.store, owner = runtime.owner;
    const link = { fetcher: deps.fetch, secret: (name: string) => deps.secret(name, "another computer running Branch") };
    this.machines = new MachineWindow(store, owner, deps.machines, link.fetcher, link.secret);
    this.remoteTrunks = new RemoteTrunks(store, owner, deps.machines, link);
    this.relay = new RelayAdapter({ store, owner, fetcher: deps.fetch, secret: (name) => deps.secret(name, "the chat relay"), pollMs: deps.relayPollMs ?? 5000 });
    this.git = new AgentGit({ store, owner, files: deps.files, policy: deps.policy, git: deps.git, appVersion: deps.version });
    this.bundles = new SkillBundles({ store, owner, files: deps.files, policy: deps.policy, fetcher: deps.fetch });
    this.usb = new UsbTrigger({ store, owner, list: deps.usbLister, start: (prompt, label) => this.startByItself(prompt, label) });
    const models = this.modelAccess();
    this.notes = new Notes(store, owner, models);
    this.arena = new Arena(store, owner, models);
    for (const part of reachParts) this.sync(part);
    byRuntime.set(runtime, this);
    void this.followRelay();
  }

  get store() { return this.deps.runtime.store; }
  get owner() { return this.deps.runtime.owner; }

  modes(): Record<ReachPart, ReachMode> { return allReachModes(this.store, this.owner); }
  mode(part: ReachPart): ReachMode { return reachMode(this.store, this.owner, part); }

  /** Saves a switch, and puts the part's tools in or takes them out at once. */
  async setMode(part: ReachPart, input: unknown): Promise<ReachMode> {
    const mode = saveReachMode(this.store, this.owner, part, input);
    this.sync(part);
    if (part === "relay") await this.followRelay();
    return mode;
  }

  private sync(part: ReachPart): void {
    for (const name of reachTools[part]) this.deps.registry.unregister(name);
    if (this.mode(part) !== "off") registrars[part]?.(this.deps.registry, this);
  }

  /** The relay is attached the first time it is switched on; while off it neither polls nor sends. */
  private async followRelay(): Promise<void> {
    if (this.relayAttached || this.mode("relay") === "off") return;
    this.relayAttached = true;
    await this.deps.router.attach(this.relay, { activation: "mention", pairing: true, allowlist: [] }).catch(() => { this.relayAttached = false; });
  }

  /** This computer's name as the others call it, for `@name-computer`. */
  machineName(): string {
    const { name } = reachRecord(this.store, this.owner, nameKey, NameSchema);
    if (!name) throw new Error("Give this computer a name first (Settings, Computer, \"Other computers running Branch\").");
    return name;
  }
  saveMachineName(input: unknown): string {
    const { name } = NameSchema.parse(input);
    this.store.save("settings", this.owner, nameKey, { name });
    return name;
  }

  videoDeps(): VideoDeps {
    return { fetcher: this.deps.fetch, secret: (name) => this.deps.secret(name, "making a video"), files: this.deps.files };
  }

  /** A task started by a device, held exactly as a trigger's task is. Nothing starts under Lockdown. */
  private async startByItself(prompt: string, label: string): Promise<unknown> {
    if (lockedDown(this.store, this.owner)) return null;
    return this.deps.runtime.run({ prompt: `${label}.\n\n${prompt}`, source: "trigger", onTextDelta: () => undefined,
      budget: { maxSteps: 12, maxTokens: 40_000 }, permissions: narrowed(undefined, this.deps.registry.permissions()) });
  }

  private modelAccess(): ModelAccess {
    const models = this.deps.runtime.models;
    return {
      presets: () => [...models.presets.values()].map((p) => ({ id: p.id, name: p.name })),
      ask: async (presetId, instructions, text, signal) => {
        const preset = presetId ? models.presets.get(presetId) : models.plan(this.owner, "").candidates[0];
        if (!preset) throw new Error("That model connection is not set up.");
        const answer = await preset.provider.complete({ messages: [{ role: "system", content: instructions }, { role: "user", content: text }],
          tools: [], signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]), maxTokens: 2000 });
        return answer.content;
      },
    };
  }

  /** One beat from the scheduler: the USB look, only while that part is on. */
  async tick(): Promise<void> { await this.usb.tick(); }

  async close(): Promise<void> { await this.relay.stop(); }
}

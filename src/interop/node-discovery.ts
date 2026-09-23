import { z } from "zod";
import type { RemoteAgents } from "../a2a-client.js";
import { DeviceBook } from "../devices/book.js";
import { capabilityInfo } from "../devices/capabilities.js";
import type { ToolRegistry } from "../registry.js";
import type { Runtime } from "../runtime.js";
import { requireInterop } from "./settings.js";

/**
 * R17-interop/node-discovery: one listing of what every node can bring to a task — its tools, the
 * skills it has installed, and the model connections it can call — each row saying which host it
 * came from. Before this, a program's lent tools (client-tools.ts), a device's switched-on
 * capabilities (devices/capabilities.ts) and an assistant elsewhere's card (a2a-client.ts) were three
 * separate places to look, and nothing said which host a given tool or skill belonged to.
 *
 * Nothing here makes a network call: every source is read from what this computer already has saved
 * (the registry, the skill catalog, the model presets, the device book, the remote-agent list), so a
 * host that is unreachable right now simply keeps the entry it last advertised rather than making the
 * whole listing fail or hang.
 */
export interface NodeDiscoveryParts {
  runtime: Runtime;
  remoteAgents: RemoteAgents;
}

export type CatalogKind = "tool" | "skill" | "inference";
export type HostKind = "this-computer" | "program" | "device" | "assistant";

export interface CatalogItem {
  kind: CatalogKind;
  /** Stable within its host: a tool or skill's own name, or a model preset's id. */
  name: string;
  description: string;
  host: string;
  hostKind: HostKind;
}

export interface HostSummary { host: string; hostKind: HostKind; tools: number; skills: number; inference: number }

/** A lent tool is named `client.<program>.<tool>` (see client-tools.ts); this reads the program back out. */
const clientHostOf = (toolName: string): string | null => /^client\.([a-z][a-z0-9-]{0,30})\./.exec(toolName)?.[1] ?? null;

/** One listing of every tool, skill and model connection reachable right now, tagged with its host. */
export function nodeCatalog(parts: NodeDiscoveryParts): { items: CatalogItem[]; hosts: HostSummary[]; summary: string } {
  const { runtime, remoteAgents } = parts;
  const owner = runtime.owner;
  const items: CatalogItem[] = [];

  // This computer: every tool this run may use apart from a program's lent tools and a device's
  // capabilities, which are tagged with their own host below; the skills installed here; the models.
  for (const tool of runtime.registry.inventory()) {
    if (clientHostOf(tool.name) || tool.name.startsWith("device.")) continue;
    items.push({ kind: "tool", name: tool.name, description: tool.description, host: "This computer", hostKind: "this-computer" });
  }
  for (const skill of runtime.store.skills.catalog(owner))
    items.push({ kind: "skill", name: skill.name, description: skill.description, host: "This computer", hostKind: "this-computer" });
  for (const preset of runtime.models.summary(owner).presets)
    items.push({ kind: "inference", name: preset.name, description: `${preset.provider} · ${preset.model}`, host: "This computer", hostKind: "this-computer" });

  // Programs on this computer lending tools over a socket, for as long as each stays connected.
  for (const tool of runtime.registry.inventory()) {
    const program = clientHostOf(tool.name);
    if (program) items.push({ kind: "tool", name: tool.name, description: tool.description, host: program, hostKind: "program" });
  }

  // Devices paired with this computer, for the capabilities the owner has switched on for each.
  const book = new DeviceBook(runtime.store, owner);
  if (book.mode() !== "off")
    for (const device of book.devices())
      for (const capability of device.enabled)
        items.push({ kind: "tool", name: capabilityInfo[capability].tool, description: capabilityInfo[capability].label, host: device.name, hostKind: "device" });

  // Assistants elsewhere, for the skills their own card said they have when they were added.
  for (const agent of remoteAgents.list())
    for (const skill of agent.skills)
      items.push({ kind: "skill", name: skill, description: agent.description || `A skill ${agent.name} advertises`, host: agent.name, hostKind: "assistant" });

  const hosts = summarizeHosts(items);
  const summary = hosts.length
    ? `${items.length} thing${items.length === 1 ? "" : "s"} across ${hosts.length} host${hosts.length === 1 ? "" : "s"}: ${hosts.map((h) => `${h.host} (${h.tools + h.skills + h.inference})`).join(", ")}.`
    : "Nothing to list yet.";
  return { items, hosts, summary };
}

function summarizeHosts(items: CatalogItem[]): HostSummary[] {
  const byHost = new Map<string, HostSummary>();
  for (const item of items) {
    const existing = byHost.get(item.host) ?? { host: item.host, hostKind: item.hostKind, tools: 0, skills: 0, inference: 0 };
    if (item.kind === "tool") existing.tools++;
    else if (item.kind === "skill") existing.skills++;
    else existing.inference++;
    byHost.set(item.host, existing);
  }
  return [...byHost.values()];
}

export function registerNodeDiscoveryTool(registry: ToolRegistry, parts: NodeDiscoveryParts): void {
  registry.register({
    name: "nodes.catalog", group: "agents", permission: "specialists.read",
    description: "One listing of every tool, skill and model connection reachable right now, each tagged with the host it belongs to: this computer, a program lending tools, a paired device or an assistant elsewhere.",
    parameters: z.object({}).strict(),
    execute: async () => {
      requireInterop(parts.runtime.store, parts.runtime.owner, "node-discovery");
      return nodeCatalog(parts);
    },
  });
}

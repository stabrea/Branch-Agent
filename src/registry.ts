import { z } from "zod";
import type {
  ToolContext,
  ToolDefinition,
  ToolDescription,
} from "./contracts.js";
import { policyTarget } from "./policy.js";
import { inferToolGroup, slimTool } from "./catalog.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly runFinished = new Set<(context: ToolContext) => Promise<void>>();
  onRunFinished(listener: (context: ToolContext) => Promise<void>): void {
    this.runFinished.add(listener);
  }
  async finishRun(context: ToolContext): Promise<void> {
    const results = await Promise.allSettled([...this.runFinished].map(listener =>
      Promise.resolve().then(() => listener(context))));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Run cleanup failed");
  }
  private readonly toolsChanged = new Set<() => void>();
  /**
   * Told whenever the set of tools changes — a skill, a plugin or an MCP server's tools arriving or
   * going away. Another AI tool connected over MCP is told so its own list stays right.
   */
  onToolsChanged(listener: () => void): () => void {
    this.toolsChanged.add(listener);
    return () => void this.toolsChanged.delete(listener);
  }
  private announceChange(): void {
    for (const listener of this.toolsChanged)
      try { listener(); } catch { /* telling someone must never break registration */ }
  }
  register<T>(tool: ToolDefinition<T>): void {
    if (
      !/^[a-z][a-z0-9_.-]{0,99}$/.test(tool.name) ||
      this.tools.has(tool.name)
    )
      throw new Error("Invalid or duplicate tool name");
    this.tools.set(tool.name, tool as ToolDefinition);
    this.announceChange();
  }
  /**
   * The catalog as the model sees it: only the tools this run may use, each put on the schema diet
   * so the one part of the context that is charged every round stays small.
   */
  descriptions(permissions: ReadonlySet<string>, options: { diet?: boolean } = {}): ToolDescription[] {
    return [...this.tools.values()]
      .filter((t) => permissions.has(t.permission))
      .map((t) => {
        const described: ToolDescription = {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema ?? (z.toJSONSchema(t.parameters) as Record<string, unknown>),
        };
        return options.diet === false ? described : slimTool(described);
      });
  }
  /** The toolbox a tool belongs to: its own answer, or one worked out from its name. */
  groupOf(name: string): string {
    return this.tools.get(name)?.group ?? inferToolGroup(name);
  }
  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) this.announceChange();
    return removed;
  }
  names(): string[] {
    return [...this.tools.keys()];
  }
  /** Every registered tool with its permission, for the capability inventory. */
  inventory(): { name: string; permission: string; description: string }[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, permission: t.permission, description: t.description }));
  }
  /** The permission a tool needs, or "" when no such tool is registered. */
  permissionOf(name: string): string {
    return this.tools.get(name)?.permission ?? "";
  }
  /** What a call would touch, for the approval policy: the tool's own answer, or one read from the arguments. */
  targetOf(name: string, args: unknown, context: ToolContext): string {
    const own = this.tools.get(name)?.target?.(args, context);
    return (own ?? policyTarget(name, args)) || "";
  }
  permissions(): string[] {
    return [...new Set([...this.tools.values()].map((t) => t.permission))];
  }
  async execute(
    name: string,
    args: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    context.signal.throwIfAborted();
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    if (!context.permissions.has(tool.permission))
      throw new Error(`Permission denied: ${tool.permission}`);
    context.budget.step(context.signal);
    const result = await tool.execute(tool.parameters.parse(args), context);
    context.signal.throwIfAborted();
    if (JSON.stringify(result).length > 65536)
      throw new Error("Tool output exceeds 64 KiB limit");
    return result;
  }
}

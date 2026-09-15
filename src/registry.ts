import { z } from "zod";
import type {
  ToolContext,
  ToolDefinition,
  ToolDescription,
} from "./contracts.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  register<T>(tool: ToolDefinition<T>): void {
    if (
      !/^[a-z][a-z0-9_.-]{0,99}$/.test(tool.name) ||
      this.tools.has(tool.name)
    )
      throw new Error("Invalid or duplicate tool name");
    this.tools.set(tool.name, tool as ToolDefinition);
  }
  descriptions(permissions: ReadonlySet<string>): ToolDescription[] {
    return [...this.tools.values()]
      .filter((t) => permissions.has(t.permission))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters:
          t.inputSchema ??
          (z.toJSONSchema(t.parameters) as Record<string, unknown>),
      }));
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

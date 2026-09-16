/**
 * Deterministic test doubles, exported from the package so plugin and skill authors can write
 * tests that never call a real model and never touch the network.
 *
 * `ScriptedProvider` answers by what it was asked rather than by how many times it has been
 * called: each route is a phrase to look for in the last thing the person said, plus the replies
 * to give, in order, every time that phrase comes back. Call order across tasks then cannot shift
 * a script, which is what makes a suite of tests reproducible.
 *
 * `ScriptedTools` is the same idea for tools: fixed answers for named tools, with every call
 * recorded so a test can say "it was called with this".
 */
import { z } from "zod";
import type {
  Completion, CompletionRequest, Provider, ToolContext, Usage,
} from "./contracts.js";
import type { ToolRegistry } from "./registry.js";

/** One reply: either a fixed completion or a function that looks at the request first. */
export type ScriptedStep = Partial<Completion> | ((request: CompletionRequest) => Partial<Completion>);
/** A phrase to look for in the newest question, and the replies to give when it turns up. */
export type ScriptedRoute = readonly [needle: string, steps: readonly ScriptedStep[]];

let counter = 0;
/** A plain answer with no tool calls. */
export function say(content: string, usage?: Usage): ScriptedStep {
  return { content, toolCalls: [], ...(usage ? { usage } : {}) };
}
/** A round that asks for one tool, with the arguments given here. */
export function callTool(name: string, args: unknown = {}): ScriptedStep {
  return { content: "", toolCalls: [{ id: `scripted-${++counter}`, name, arguments: JSON.stringify(args) }] };
}

export class ScriptedProvider implements Provider {
  readonly name: string;
  /** Every request this provider was given, in order, for a test to look over afterwards. */
  readonly requests: CompletionRequest[] = [];
  readonly acceptsImages = false;
  private routes: readonly ScriptedRoute[];
  private readonly seen = new Map<string, number>();
  constructor(routes: readonly ScriptedRoute[] = [], name = "scripted") {
    this.routes = routes;
    this.name = name;
  }
  /** Replaces the script and forgets how far through each route we were. */
  set(routes: readonly ScriptedRoute[]): void {
    this.routes = routes;
    this.seen.clear();
  }
  /** How many times the route for this phrase has answered. */
  count(needle: string): number {
    return this.seen.get(needle) ?? 0;
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    this.requests.push(request);
    const asked = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const route = this.routes.find(([needle]) => asked.includes(needle));
    if (!route) throw new Error(`Nothing scripted for: ${asked.slice(0, 120)}`);
    const index = this.seen.get(route[0]) ?? 0;
    this.seen.set(route[0], index + 1);
    const step = route[1][Math.min(index, route[1].length - 1)]!;
    const reply = typeof step === "function" ? step(request) : step;
    return { content: reply.content ?? "", toolCalls: reply.toolCalls ?? [], ...(reply.usage ? { usage: reply.usage } : {}) };
  }
}

/** One recorded call: the tool's name and the arguments it was actually given. */
export interface ScriptedCall { name: string; input: unknown }

/**
 * Tools with fixed answers. Register them on a registry and the assistant can call them without
 * anything real happening; the test then reads `calls` to see what it asked for.
 */
export class ScriptedTools {
  readonly calls: ScriptedCall[] = [];
  private readonly replies = new Map<string, unknown>();
  /** Fixes what one tool hands back. A tool with no answer set hands back `{ ok: true }`. */
  reply(name: string, value: unknown): this {
    this.replies.set(name, value);
    return this;
  }
  /** The arguments this tool was called with, in order. */
  calledWith(name: string): unknown[] {
    return this.calls.filter((call) => call.name === name).map((call) => call.input);
  }
  /** Forgets every recorded call, so one fixture can serve several tests. */
  reset(): void {
    this.calls.length = 0;
  }
  /**
   * Puts the named tools on a registry. Every one takes any object and needs the permission given,
   * which defaults to the tool's own name so a test can hand out exactly what it means to.
   */
  register(registry: ToolRegistry, names: readonly string[], permission?: string): void {
    for (const name of names)
      registry.register({
        name,
        description: `Test double for ${name}. It changes nothing.`,
        permission: permission ?? name,
        parameters: z.record(z.string(), z.unknown()).default({}),
        execute: async (input: Record<string, unknown>, _context: ToolContext) => {
          this.calls.push({ name, input });
          return this.replies.get(name) ?? { ok: true };
        },
      });
  }
}

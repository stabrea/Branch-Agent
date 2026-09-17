import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { InputValue } from "../recipes.js";
import type { BranchPlugin, PluginIsolation } from "../plugins.js";
import { defaultSandboxSpawn, openWall, type SandboxSpawn, type WallDeps } from "../sandbox-backends.js";
import type { WallContext } from "../sandbox.js";
import { hostSource, resultMarker } from "./walled-host.js";

/**
 * Bucket 15: a plugin somebody else wrote runs in its own program, behind the same wall as any
 * program Branch starts (src/sandbox-backends.ts) — never inside Branch.
 *
 * Each question is one short run: "what are you" when the owner looks at it, one run per tool call,
 * and one per event a hook listens for. The plugin's file is copied into a fresh scratch folder
 * (Branch's own data folder is unreadable from behind the wall), a small host program loads it,
 * answers, and the folder is thrown away.
 *
 * Behind the wall the program may read the disk except where keys, passwords and Branch's data
 * live, may write only in its scratch folder, and reaches no network at all — unless its package
 * named web addresses and the owner installed it after reading them; then those addresses and no
 * others. It gets no keys, no environment of Branch's, and a hard limit on time, memory and output.
 * On Windows the wall is Windows' own job object; the program still runs apart from Branch.
 */
export interface WalledPluginOptions {
  /** Whether this plugin must run walled, and what its package was allowed to reach. */
  policy(id: string): WalledPolicy | null;
  /** More places the program may not read (the owner's wall settings, Branch's data folder). */
  unreadable(): readonly string[];
  siteCheck?: (target: URL) => Promise<void>;
  spawn?: SandboxSpawn;
  wallDeps?: WallDeps;
  timeoutMs?: number;
}

export interface WalledPolicy {
  walled: boolean;
  hosts: readonly string[];
  /** The fingerprint the code had when the owner installed it; other code is refused. */
  sha256?: string | undefined;
}

const ToolShape = z.object({
  name: z.string().max(80), description: z.string().max(2000).default(""), permission: z.string().max(64),
  input: z.record(z.string(), z.unknown()).optional(), search: z.object({ label: z.string().max(60) }).optional(),
}).strip();
const DescribeShape = z.object({
  id: z.string().max(40), name: z.string().max(80), description: z.string().max(500).default(""),
  permissions: z.array(z.string().max(64)).max(20).default([]), apiVersion: z.number().optional(),
  tools: z.array(ToolShape).max(32).default([]), hooks: z.array(z.string().max(64)).max(16).default([]),
  providers: z.boolean().default(false), channels: z.boolean().default(false),
}).strip();
const Answer = z.object({ ok: z.boolean(), error: z.string().max(1000).optional(), result: z.unknown().optional(), plugin: z.unknown().optional() }).strip();

/** The wall one plugin run goes behind: its scratch folder, and only the addresses it was allowed. */
export function pluginWall(hosts: readonly string[], unreadable: readonly string[], siteCheck?: (target: URL) => Promise<void>): WallContext {
  const allowed = new Set(hosts.map((host) => host.toLowerCase()));
  return {
    network: allowed.size ? "per-site" : "none",
    keySites: {},
    unreadable: [...unreadable],
    answer: (kind, target) => (kind === "network.site" && allowed.has(target.toLowerCase()) ? "allow" : "deny"),
    granted: () => [],
    spend: () => undefined,
    ...(siteCheck ? { siteCheck } : {}),
  };
}

/** The one line the host prints after everything the plugin itself printed. */
export function readAnswer(stdout: string): z.infer<typeof Answer> {
  const at = stdout.lastIndexOf(resultMarker);
  if (at < 0) throw new Error("The plugin's program stopped without answering.");
  const line = stdout.slice(at + resultMarker.length).split("\n")[0] ?? "";
  return Answer.parse(JSON.parse(line));
}

export class WalledPlugins implements PluginIsolation {
  private hooksRunning = 0;
  constructor(private readonly options: WalledPluginOptions) {}

  holds(id: string): boolean { return this.options.policy(id)?.walled === true; }

  /** Asks the program once what it brings, and hands back a plugin whose every part calls it again. */
  async load(id: string, file: string): Promise<BranchPlugin> {
    const { code, policy } = await this.code(id, file);
    const answer = await this.ask(code, policy.hosts, { kind: "describe" });
    const described = DescribeShape.parse(answer.plugin);
    const notes: string[] = [];
    if (described.providers) notes.push("Its model connections were left out: they need Branch's own process, and this plugin runs walled.");
    if (described.channels) notes.push("Its chat services were left out: they need Branch's own process, and this plugin runs walled.");
    notes.push(policy.hosts.length ? `It runs walled and may reach only ${policy.hosts.join(", ")}.` : "It runs walled, with no internet.");
    return {
      id: described.id, name: described.name, description: described.description, permissions: described.permissions,
      ...(described.apiVersion !== undefined ? { apiVersion: described.apiVersion } : {}), notes,
      tools: described.tools.map((tool) => ({
        name: tool.name, description: tool.description, permission: tool.permission,
        ...(tool.input ? { input: tool.input as never } : {}), ...(tool.search ? { search: tool.search } : {}),
        run: (args: Record<string, InputValue>, context: { runId?: string }) => this.call(id, file, { kind: "call", tool: tool.name, args, runId: context.runId ?? "" }),
      })),
      hooks: described.hooks.map((event) => ({ event, run: (payload: unknown) => this.hook(id, file, event, payload) })),
    };
  }

  /** The plugin's code, read fresh each time and refused when it is not what the owner installed. */
  private async code(id: string, file: string): Promise<{ code: string; policy: WalledPolicy }> {
    const policy = this.options.policy(id);
    if (!policy?.walled) throw new Error(`${id} is no longer set up to run walled.`);
    const code = await readFile(file, "utf8");
    if (policy.sha256 && createHash("sha256").update(code, "utf8").digest("hex") !== policy.sha256)
      throw new Error(`The code of ${id} is not what it was when you installed it, so it was not run. Remove it and install it again.`);
    return { code, policy };
  }

  private async call(id: string, file: string, request: Record<string, unknown>): Promise<unknown> {
    const { code, policy } = await this.code(id, file);
    const answer = await this.ask(code, policy.hosts, request);
    return answer.result ?? null;
  }

  /** A hook is told about its event; at most two run at once, and one more is simply not sent. */
  private async hook(id: string, file: string, event: string, payload: unknown): Promise<void> {
    if (this.hooksRunning >= 2) return;
    this.hooksRunning += 1;
    try { await this.call(id, file, { kind: "hook", event, payload: JSON.parse(JSON.stringify(payload ?? {})) }); }
    finally { this.hooksRunning -= 1; }
  }

  /** One run of the plugin's program behind the wall. */
  async ask(code: string, hosts: readonly string[], request: Record<string, unknown>): Promise<z.infer<typeof Answer>> {
    const staging = await mkdtemp(join(tmpdir(), "branch-addon-"));
    try {
      await writeFile(join(staging, "plugin.mjs"), code, { mode: 0o600 });
      await writeFile(join(staging, "host.mjs"), hostSource, { mode: 0o600 });
      await writeFile(join(staging, "request.json"), JSON.stringify(request), { mode: 0o600 });
      const wall = pluginWall(hosts, this.options.unreadable(), this.options.siteCheck);
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: staging, TMPDIR: staging, NODE_USE_ENV_PROXY: "1",
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };
      const opened = await openWall(wall, { executable: process.execPath, args: ["--no-warnings", join(staging, "host.mjs")], cwd: staging, env },
        { workspace: staging }, this.options.wallDeps ?? {});
      try {
        const timeoutMs = this.options.timeoutMs ?? 30_000;
        const limits = { timeoutMs, maxMemoryMb: 512, maxCpuSeconds: Math.ceil(timeoutMs / 1000), maxOutputBytes: 1_000_000, network: hosts.length > 0, job: true };
        const run = await (this.options.spawn ?? defaultSandboxSpawn())(opened.start, limits, AbortSignal.timeout(timeoutMs + 5000));
        const note = await opened.finish(run);
        const answer = readAnswerOr(run.stdout, note ?? run.stderr);
        if (!answer.ok) throw new Error(`The plugin said: ${answer.error ?? "it could not do that"}`);
        return answer;
      } finally { await opened.close(); }
    } finally { await rm(staging, { recursive: true, force: true }).catch(() => undefined); }
  }
}

function readAnswerOr(stdout: string, why: string): z.infer<typeof Answer> {
  try { return readAnswer(stdout); }
  catch { throw new Error(`The plugin's program stopped without answering.${why ? ` ${why.trim().slice(-300)}` : ""}`); }
}

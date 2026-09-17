import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { FeatureModeSchema, optionalFields } from "../feature-switches.js";
import type { ToolRegistry } from "../registry.js";
import {
  acceptProposal, discardProposal, GatewayConfigSchema, loadGatewayConfig, proposeConfig, readProposal,
  saveGatewayConfig, type DryRun, type GatewayConfig,
} from "./gateway-config.js";
import { readState } from "./gateway-state.js";

/**
 * The owner's side of the gateway: the switch, what the gateway last said, and changes the
 * assistant has suggested, which only the owner can accept. The assistant's side is one tool that
 * suggests a change; it never writes the settings itself (see protected.ts).
 */
export class NeverBreakApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const handlesNeverBreakPath = (path: string): boolean => path === "/api/never-break" || path.startsWith("/api/never-break/");

type Read = (request: IncomingMessage) => Promise<unknown>;

export async function neverBreakView(dataDir: string): Promise<Record<string, unknown>> {
  const loaded = await loadGatewayConfig(dataDir);
  const state = await readState(dataDir);
  return {
    mode: loaded.config.mode, config: loaded.config, problem: loaded.problem,
    underGateway: process.env.BRANCH_GATEWAY_CHILD === "1",
    lastExit: state ? (state.phase === "exited" ? "clean" : "running") : "never",
    recentCrashes: state?.crashes.length ?? 0,
    proposal: await readProposal(dataDir),
  };
}

export async function neverBreakApi(dataDir: string, request: IncomingMessage, path: string, readBody: Read): Promise<unknown> {
  if (request.method === "GET" && path === "/api/never-break") return neverBreakView(dataDir);
  if (request.method !== "POST") throw new NeverBreakApiError(405, "Use GET or POST here.");
  if (path === "/api/never-break") {
    const body = z.object({ mode: FeatureModeSchema }).strict().safeParse(await readBody(request));
    if (!body.success) throw new NeverBreakApiError(400, "Choose off, when needed or on.");
    const { config } = await loadGatewayConfig(dataDir);
    await saveGatewayConfig(dataDir, { ...config, mode: body.data.mode });
    return { ...(await neverBreakView(dataDir)), note: "This takes effect the next time Branch starts." };
  }
  if (path === "/api/never-break/proposal/accept") {
    try { await acceptProposal(dataDir); } catch (error) { throw new NeverBreakApiError(409, (error as Error).message); }
    return { ...(await neverBreakView(dataDir)), note: "Saved. It takes effect the next time Branch starts." };
  }
  if (path === "/api/never-break/proposal/discard") { await discardProposal(dataDir); return neverBreakView(dataDir); }
  throw new NeverBreakApiError(404, "Not found");
}

/** The assistant may suggest a change to the gateway's settings; the owner decides. */
export function registerNeverBreak(registry: ToolRegistry, dataDir: string, dryRun: DryRun): void {
  registry.register({
    name: "gateway.propose", permission: "gateway.propose", group: "settings",
    description: "Suggest a change to the settings of Branch's gateway (the part that keeps Branch running). The change is checked and tried on a throwaway copy, then waits for the owner to accept it in Settings. It is never applied by this tool.",
    parameters: z.object({
      change: optionalFields(GatewayConfigSchema.omit({ mode: true })),
      why: z.string().trim().min(1).max(500),
    }).strict(),
    execute: async ({ change, why }) => {
      const proposal = await proposeConfig(dataDir, change, why, dryRun);
      return { waitingForOwner: true, tried: proposal.check,
        said: proposal.check?.ok ? "The change started cleanly on a throwaway copy and now waits for the owner in Settings."
          : "The change did not start cleanly, so the owner will see it cannot be used." };
    },
  });
}

/**
 * Starts a throwaway gateway, with these settings, on an empty data folder of its own, and answers
 * whether its engine came up. Nothing of the owner's is read or written; the folder is removed after.
 */
export function gatewayDryRun(script: string, env: NodeJS.ProcessEnv = process.env): DryRun {
  return async (config: GatewayConfig) => {
    const root = await mkdtemp(join(tmpdir(), "branch-gateway-try-"));
    try {
      const dataDir = join(root, "data");
      await saveGatewayConfig(dataDir, { ...config, mode: "on" });
      return await tryGateway(script, { ...cleanEnv(env), BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: join(root, "workspace"), BRANCH_PORT: "0" },
        (config.startSeconds + 10) * 1000);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  };
}

const cleanEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const copy = { ...env };
  for (const name of ["BRANCH_GATEWAY_CHILD", "BRANCH_GATEWAY_CONTRACT", "NODE_TEST_CONTEXT"]) delete copy[name];
  return copy;
};

async function tryGateway(script: string, env: NodeJS.ProcessEnv, limitMs: number): Promise<{ ok: boolean; detail: string }> {
  const child = spawn(process.execPath, [script, "start"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const deadline = Date.now() + limitMs;
  try {
    while (Date.now() < deadline && child.exitCode === null) {
      const url = /Branch gateway listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
      const health = url ? await fetch(`${url}/gateway/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json() as Promise<{ worker?: { state?: string } }>).catch(() => null) : null;
      if (health?.worker?.state === "ready") return { ok: true, detail: "A throwaway gateway started its engine with these settings." };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ok: false, detail: `A throwaway gateway did not get its engine going with these settings. ${output.trim().split("\n").slice(-3).join(" ").slice(0, 400)}` };
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 20_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

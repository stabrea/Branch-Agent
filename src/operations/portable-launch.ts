import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { readRunning } from "../install/running.js";
import { readUsage, type UsageSample } from "../integrations/process-usage.js";
import type { PortableTarget } from "./portable-targets.js";

/**
 * FQ-operations.portable: launches the packaged binary as a real, separate process (the binary
 * itself, not `node dist/cli.js`) and measures the gateway it boots the same way an agent sandbox's
 * resource limits already do (src/integrations/process-usage.ts, sampled through the operating
 * system): cold start, idle memory, memory while carrying out one task, CPU time, and how much disk
 * the packaged output takes.
 */
export interface PortableUsageReport {
  target: PortableTarget;
  coldStartMs: number;
  idleMemoryMb: number;
  taskMemoryMb: number;
  cpuSeconds: number;
  diskBytes: number;
}

export interface MeasurePortableOptions {
  binaryPath: string;
  target: PortableTarget;
  /** Bytes the packaged output (binary + shipped dist/) occupies on disk. */
  diskBytes: number;
  readyTimeoutMs?: number;
  /** How long idle memory is left to settle past the first-allocation spike before it is sampled. */
  settleMs?: number;
  usageReader?: typeof readUsage;
  /** Replaces the real spawn, for a test that wants to prove the waiting/measuring logic without a
   * real packaged binary (kept optional; the feature's own test uses a real one). */
  spawnBinary?: typeof spawn;
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function until<T>(what: string, check: () => Promise<T | null>, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const answer = await check();
    if (answer) return answer;
    if (Date.now() >= deadline) throw new Error(`timed out waiting: ${what}`);
    await wait(100);
  }
}

export async function measurePortableLaunch(options: MeasurePortableOptions): Promise<PortableUsageReport> {
  const root = await mkdtemp(join(tmpdir(), "branch-portable-run-"));
  const dataDir = join(root, "data");
  const workspace = join(root, "workspace");
  const usage = options.usageReader ?? readUsage;
  const doSpawn = options.spawnBinary ?? spawn;

  const started = Date.now();
  const child: ChildProcess = doSpawn(options.binaryPath, ["start"], {
    stdio: "ignore",
    env: {
      ...process.env,
      BRANCH_DATA_DIR: dataDir,
      BRANCH_WORKSPACE: workspace,
      BRANCH_PORT: "0",
      BRANCH_PROVIDER: "demo",
    },
  });
  let exited = false;
  child.once("exit", () => { exited = true; });

  try {
    const instance = await until("the packaged binary to report ready", async () => {
      if (exited) throw new Error("the packaged binary exited before it was ready");
      return readRunning(dataDir);
    }, options.readyTimeoutMs ?? 30000);
    const coldStartMs = Date.now() - started;

    await wait(options.settleMs ?? 500);
    const idle: UsageSample | null = await usage(instance.pid);

    const token = (await readFile(join(dataDir, "session-token"), "utf8")).trim();
    await fetch(`${instance.url}/api/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Say hello." }),
    }).catch(() => null);
    const task: UsageSample | null = await usage(instance.pid);

    return {
      target: options.target,
      coldStartMs,
      idleMemoryMb: idle?.memoryMb ?? 0,
      taskMemoryMb: Math.max(task?.memoryMb ?? 0, idle?.memoryMb ?? 0),
      cpuSeconds: Math.max(task?.cpuSeconds ?? 0, idle?.cpuSeconds ?? 0),
      diskBytes: options.diskBytes,
    };
  } finally {
    try { if (!exited && child.pid) process.kill(child.pid); } catch { /* already gone */ }
    await until("the packaged binary to stop", async () => (exited || !child.pid || !alive(child.pid) ? true : null), 10000).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

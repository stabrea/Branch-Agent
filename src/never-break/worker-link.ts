import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchHandOver, posixRollbackScript, windowsRollbackScript } from "../desktop/hand-over.js";
import type { UpdateWatch } from "./canary.js";
import { gatewayContract, GatewayMessageSchema } from "./contract.js";
import { loadGatewayConfig } from "./gateway-config.js";
import { Gateway } from "./gateway.js";

/**
 * The engine's side of the gateway. When the engine was started by a gateway it says where it is
 * listening once it is ready, closes itself when asked, and closes itself when the gateway goes
 * away — so a gateway that is killed never leaves an engine behind holding the database.
 */
export interface GatewayLink {
  ready(port: number, version: string): void;
  onStop(stop: () => Promise<void> | void): void;
}

type Channel = Pick<NodeJS.Process, "send" | "on" | "connected" | "disconnect" | "exit" | "env" | "pid">;

export function joinGateway(host: Channel = process): GatewayLink | null {
  if (host.env.BRANCH_GATEWAY_CHILD !== "1" || typeof host.send !== "function") return null;
  let stopper: (() => Promise<void> | void) | null = null;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Whatever happens while closing, the engine is gone within twenty seconds.
    setTimeout(() => host.exit(0), 20_000).unref();
    void Promise.resolve(stopper?.()).catch(() => undefined).finally(() => {
      if (host.connected) host.disconnect();
      setTimeout(() => host.exit(0), 500).unref();
    });
  };
  host.on("disconnect", stop);
  host.on("message", (message: unknown) => {
    const parsed = GatewayMessageSchema.safeParse(message);
    if (parsed.success && parsed.data.type === "stop") stop();
  });
  return {
    ready: (port, version) => {
      host.send?.({ type: "ready", contract: gatewayContract.speaks, accepts: gatewayContract.accepts, port, version, pid: host.pid });
    },
    onStop: (fn) => { stopper = fn; },
  };
}

/**
 * `branch start` with the switch on: run the gateway, which runs the engine. Answers false when the
 * switch is off (or this process already is the engine), so the caller starts the engine itself.
 */
export async function runGatewayIfSwitchedOn(input: { dataDir: string; script: string; version: string; port: number }): Promise<boolean> {
  if (process.env.BRANCH_GATEWAY_CHILD === "1") return false;
  const { config } = await loadGatewayConfig(input.dataDir);
  if (config.mode === "off") return false;
  const gateway: Gateway = new Gateway({ ...input, presence: true,
    rollBack: async (watch) => { await rollBackUpdate(watch, input.dataDir); void gateway.stop().finally(() => process.exit(1)); } });
  const url = await gateway.start();
  console.log(`Branch gateway listening at ${url}\nThe engine runs behind it and is started again if it stops.`);
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void gateway.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return true;
}

/**
 * Writes the way-back script beside the data and starts it so that it outlives this gateway: on
 * Windows through the same hidden launcher the update uses (no console window), elsewhere as a
 * detached shell. The script waits for this process to close before it moves anything.
 */
export async function rollBackUpdate(watch: UpdateWatch, dataDir: string, launch = launchHandOver): Promise<string> {
  const folder = join(dataDir, "updates");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const log = join(folder, "roll-back.log");
  const windows = watch.platform === "win32";
  const script = join(folder, windows ? "roll-back.cmd" : "roll-back.sh");
  const text = windows
    ? windowsRollbackScript({ install: watch.target, exe: join(watch.target, watch.executableName), log })
    : posixRollbackScript({ platform: watch.platform === "darwin" ? "darwin" : "linux", target: watch.target, log, executableName: watch.executableName });
  await writeFile(script, text, { encoding: "utf8", mode: 0o700 });
  if (!windows) await chmod(script, 0o700);
  await launch(script, process.pid, { platform: watch.platform });
  return script;
}

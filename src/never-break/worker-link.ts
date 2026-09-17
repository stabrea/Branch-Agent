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
  const gateway = new Gateway({ ...input, presence: true });
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

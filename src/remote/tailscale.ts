import { execFile } from "node:child_process";
import { z } from "zod";

/**
 * Reaching Branch from a phone uses Tailscale, a private network the owner already runs on both
 * devices. Branch never opens itself to the internet or to the local coffee-shop network: it listens
 * only on the private address Tailscale gives this computer, and only while the switch is on.
 */
const statusSchema = z.object({
  BackendState: z.string().optional(),
  Self: z.object({
    HostName: z.string().optional(),
    DNSName: z.string().optional(),
    TailscaleIPs: z.array(z.string()).optional(),
  }).optional(),
}).loose();

export interface TailnetAddress {
  present: boolean;
  running: boolean;
  /** The private address of this computer inside the tailnet, or null. */
  address: string | null;
  /** The name other devices can use, such as "desk-pc.tail1234.ts.net". */
  hostname: string | null;
  message: string;
}
export type ProbeTailscale = () => Promise<TailnetAddress>;

/** Tailscale hands out addresses in 100.64.0.0/10 only; anything else is refused on purpose. */
export function isTailnetAddress(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

export function readStatus(json: string): TailnetAddress {
  const parsed = statusSchema.safeParse(JSON.parse(json));
  if (!parsed.success) return absent("Tailscale answered in a way this version does not understand.");
  const self = parsed.data.Self ?? {};
  const running = (parsed.data.BackendState ?? "") === "Running";
  const address = (self.TailscaleIPs ?? []).find(isTailnetAddress) ?? null;
  const hostname = (self.DNSName ?? "").replace(/\.$/, "") || self.HostName || null;
  if (!running) return { present: true, running: false, address: null, hostname, message: "Tailscale is installed but not signed in. Open Tailscale and connect, then try again." };
  if (!address) return { present: true, running: true, address: null, hostname, message: "Tailscale is connected but has not given this computer a private address yet." };
  return { present: true, running: true, address, hostname, message: `Tailscale is connected as ${hostname ?? address}.` };
}
const absent = (message: string): TailnetAddress =>
  ({ present: false, running: false, address: null, hostname: null, message });

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true, timeout: 10000, maxBuffer: 1048576 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)));

const candidates = [
  "tailscale",
  "C:\\Program Files\\Tailscale\\tailscale.exe",
  "C:\\Program Files (x86)\\Tailscale IPN\\tailscale.exe",
];

/** Asks Tailscale where this computer sits on the private network. */
export const probeTailscale: ProbeTailscale = async () => {
  for (const file of candidates) {
    try {
      return readStatus(await run(file, ["status", "--json"]));
    } catch { continue; }
  }
  return absent("Tailscale is not installed on this computer. Install it on this computer and on your phone, sign both in, then switch this on again.");
};

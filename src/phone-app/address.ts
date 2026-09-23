import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { isTailnetAddress, type ProbeTailscale, probeTailscale } from "../remote/tailscale.js";

/**
 * mac7/phone-qr: which address the phone download door listens on.
 *
 * The phone is not this computer, so the door has to be somewhere the phone can reach. It is ONE
 * address, never every address: the home network address of the connection this computer uses to
 * reach the world (the phone is almost always on that same Wi-Fi), or, when there is none, the
 * Tailscale address. A public address is never a candidate, nor a self-assigned one (169.254.x.x),
 * nor a container or virtual machine bridge.
 */
export interface NamedAddress { name: string; address: string; internal: boolean }

export function namedAddresses(): NamedAddress[] {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? []).filter((entry) => entry.family === "IPv4")
      .map((entry) => ({ name, address: entry.address, internal: entry.internal })));
}

/** 10/8, 172.16/12 and 192.168/16: a home or office network, and nothing else. */
export function homeNetworkAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Interfaces a phone never sits behind: container, virtual machine and Thunderbolt bridges. */
const virtualInterface = /^(bridge|docker|br-|veth|vmnet|vboxnet|virbr|cni|flannel|lxc|podman)/i;
/**
 * Tunnels: a work VPN hands out 10.x addresses too, and when it carries the default route its
 * address would otherwise come first, opening the door to the whole office network, where the phone
 * is not. A tunnel is only ever used for its Tailscale address.
 */
const tunnelInterface = /^(utun|tun|tap|ppp|ipsec|wg|gpd|zt|tailscale)/i;

/**
 * The addresses the door may use, best first: the default route's home address, other home
 * addresses, then Tailscale. Pure, so every platform's ordering is tested on every machine.
 */
export function doorAddresses(all: readonly NamedAddress[], defaultInterface: string | null): string[] {
  const usable = all.filter((entry) => !entry.internal && !virtualInterface.test(entry.name));
  const home = usable.filter((entry) => homeNetworkAddress(entry.address) && !tunnelInterface.test(entry.name));
  const first = home.filter((entry) => entry.name === defaultInterface);
  const rest = home.filter((entry) => entry.name !== defaultInterface);
  const tailnet = usable.filter((entry) => isTailnetAddress(entry.address));
  return [...new Set([...first, ...rest, ...tailnet].map((entry) => entry.address))];
}

export type Runner = (file: string, args: string[]) => Promise<string>;

export const runQuietly: Runner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 3000, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
});

/** The interface carrying the default route, read from what the system itself reports, or null. */
export async function defaultInterface(platform: NodeJS.Platform, run: Runner = runQuietly): Promise<string | null> {
  try {
    if (platform === "darwin") return /^\s*interface:\s*(\S+)/m.exec(await run("route", ["-n", "get", "default"]))?.[1] ?? null;
    if (platform === "linux") return /\bdev\s+(\S+)/.exec(await run("ip", ["route", "show", "default"]))?.[1] ?? null;
  } catch { /* no default route: the ordering falls back to interface order */ }
  return null;
}

/**
 * Filter 100.64/10 addresses by checking Tailscale: keep only the address that Tailscale
 * reports as this computer's own, while running. Other networks (VPNs, CGNAT) hand out
 * addresses in this range too, so range alone is not reliable.
 */
export async function filterTailnetAddresses(
  addresses: readonly string[], probe: ProbeTailscale = probeTailscale,
): Promise<string[]> {
  // Fast path: no 100.64 addresses, no need to probe
  const hasTailnet = addresses.some(isTailnetAddress);
  if (!hasTailnet) return addresses.slice();

  try {
    const status = await probe();
    if (!status.running || !status.address) return addresses.filter((a) => !isTailnetAddress(a));
    // Keep only the address Tailscale reports, drop other 100.64 addresses
    return addresses.filter((a) => !isTailnetAddress(a) || a === status.address);
  } catch {
    // Probe failed: drop all 100.64 addresses
    return addresses.filter((a) => !isTailnetAddress(a));
  }
}

/** Everything the door may listen on here, best first. */
export async function candidateAddresses(
  platform: NodeJS.Platform = process.platform, run: Runner = runQuietly, tailscale?: ProbeTailscale,
): Promise<string[]> {
  const candidates = doorAddresses(namedAddresses(), await defaultInterface(platform, run));
  return filterTailnetAddresses(candidates, tailscale);
}

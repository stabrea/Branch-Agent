import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";

/**
 * One network policy for everything the assistant reaches over HTTP: web reading, the browser and
 * MCP servers. Host rules match a host or its subdomains; path rules are "host/prefix" entries so a
 * single API path can be allowed or blocked without opening the whole site. Private and local
 * addresses are refused unless the owner allows them.
 */
const hostRule = z.string().min(1).max(253);
const pathRule = z.string().min(3).max(500).regex(/^[^/\s]+\/.*$/, "Path rules look like host/prefix, for example api.github.com/repos/");
export const NetworkPolicySchema = z.object({
  allowPrivateAddresses: z.boolean().default(false),
  allowedHosts: z.array(hostRule).max(200).optional(),
  blockedHosts: z.array(hostRule).max(200).default([]),
  /** When present, only addresses matching one of these host/prefix rules are reachable. */
  allowedPaths: z.array(pathRule).max(200).optional(),
  blockedPaths: z.array(pathRule).max(200).default([]),
});
export type NetworkPolicyConfig = z.infer<typeof NetworkPolicySchema>;

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224;
}
function privateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("::ffff:")) return privateV4(lower.slice(7));
  return /^(fc|fd|fe[89ab])/.test(lower);
}
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  return kind === 4 ? privateV4(ip) : kind === 6 ? privateV6(ip) : true;
}
const hostMatches = (host: string, pattern: string) => host === pattern.toLowerCase() || host.endsWith("." + pattern.toLowerCase());
/** "host/prefix" matches when the host rule matches and the path starts with the prefix. */
export function pathRuleMatches(host: string, pathname: string, rule: string): boolean {
  const slash = rule.indexOf("/");
  const ruleHost = rule.slice(0, slash).replace(/^\*\./, ""), prefix = rule.slice(slash);
  return hostMatches(host, ruleHost) && pathname.startsWith(prefix);
}

export class NetworkPolicy {
  private config: NetworkPolicyConfig;
  constructor(input: unknown = {}, private readonly resolve: (host: string) => Promise<string[]> = defaultResolve) {
    this.config = NetworkPolicySchema.parse(input);
  }
  configure(input: unknown): NetworkPolicyConfig { return (this.config = NetworkPolicySchema.parse(input)); }
  settings(): NetworkPolicyConfig { return this.config; }
  /** Throws a plain reason when an address may not be reached; call it for every hop of every request. */
  async assertAllowed(target: URL, what = "address"): Promise<void> {
    if (!["http:", "https:"].includes(target.protocol)) throw new Error(`Only http and https ${what}es can be reached`);
    if (target.username || target.password) throw new Error("Addresses with embedded credentials are refused");
    const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase(), pathname = target.pathname || "/";
    if (this.config.blockedHosts.some((p) => hostMatches(host, p))) throw new Error(`${host} is on the blocked list`);
    if (this.config.allowedHosts && !this.config.allowedHosts.some((p) => hostMatches(host, p))) throw new Error(`${host} is not on the allowed list`);
    if (this.config.blockedPaths.some((rule) => pathRuleMatches(host, pathname, rule))) throw new Error(`${host}${pathname} is on the blocked list`);
    if (this.config.allowedPaths && !this.config.allowedPaths.some((rule) => pathRuleMatches(host, pathname, rule))) throw new Error(`${host}${pathname} is not on the allowed list`);
    if (this.config.allowPrivateAddresses) return;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
      throw new Error(`${host} points at this computer or a private network, which the assistant may not reach`);
    const addresses = isIP(host) ? [host] : await this.resolve(host);
    if (!addresses.length) throw new Error(`${host} could not be resolved`);
    if (addresses.some(isPrivateAddress)) throw new Error(`${host} resolves to a private or local address, which the assistant may not reach`);
  }
  /** A fetch that checks the policy on every call, for clients (MCP, browser) that make their own requests. */
  guard(base: typeof fetch): typeof fetch {
    const policy = this;
    return async function guarded(input: string | URL | Request, init?: RequestInit) {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      await policy.assertAllowed(url);
      return base(input, { ...init, redirect: init?.redirect ?? "error" });
    } as typeof fetch;
  }
}
async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address);
}

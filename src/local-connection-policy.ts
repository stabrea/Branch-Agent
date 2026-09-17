import type { CatalogEntry } from "./provider-catalog.js";
import { NetworkPolicy } from "./network-policy.js";

/**
 * A program on this computer that Branch knows from the catalog (Ollama, LM Studio, vLLM and the
 * rest) listens on its own loopback port, which the default network rules refuse. This lets exactly
 * that one address through, for that one connection's own model calls: every other rule the owner
 * set (blocked hosts and paths, allowed lists) still applies, and every other private or local
 * address, including another port on this computer, stays refused.
 */
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The `http://127.0.0.1:port` origin a local catalog entry talks to, or null for anything else. */
export function ownLoopbackOrigin(entry: CatalogEntry | undefined, baseUrl: string): string | null {
  if (!entry || entry.kind !== "local") return null;
  const url = new URL(baseUrl);
  return loopbackHosts.has(url.hostname) ? url.origin : null;
}

export type ConnectionCheck = (target: URL, what?: string) => Promise<void>;

/** The policy check for one connection: the owner's rules, with only its own local address let through. */
export function connectionCheck(policy: NetworkPolicy, entry: CatalogEntry | undefined, baseUrl: string): ConnectionCheck {
  const own = ownLoopbackOrigin(entry, baseUrl);
  return async (target, what) => {
    if (own === null || target.origin !== own) return policy.assertAllowed(target, what);
    // Read the owner's rules at the moment of the call, so a later change still applies.
    const local = new NetworkPolicy({ ...policy.settings(), allowPrivateAddresses: true }, async () => []);
    return local.assertAllowed(target, what);
  };
}

/** A fetch that runs `check` on every call and never follows a redirect unless the caller asks. */
export function guardedFetch(check: ConnectionCheck, base: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    await check(url);
    return base(input, { ...init, redirect: init?.redirect ?? "error" });
  }) as typeof globalThis.fetch;
}

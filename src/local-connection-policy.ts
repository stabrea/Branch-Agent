import type { CatalogEntry } from "./provider-catalog.js";
import type { NetworkPolicy } from "./network-policy.js";
import { assertLocalRuntimeAllowed, localRuntimeFetch } from "./local-policy.js";

/**
 * A program on this computer that Branch knows from the catalog (Ollama, LM Studio, vLLM and the
 * rest) listens on its own loopback port, which the default network rules refuse. Such a connection
 * uses the same narrow allowance as one-click local models (src/local-policy.ts): exactly its own
 * address, with every other rule the owner set still applied. Any other entry, and any other
 * address, goes through the ordinary policy in full.
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
    if (own !== null && target.origin === own) return assertLocalRuntimeAllowed(policy, target);
    return policy.assertAllowed(target, what);
  };
}

/** The fetch one catalog connection makes its calls through. */
export function connectionFetch(
  policy: NetworkPolicy, entry: CatalogEntry, baseUrl: string, base: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const own = ownLoopbackOrigin(entry, baseUrl);
  return own === null ? policy.guard(base) : localRuntimeFetch(policy, base, own);
}

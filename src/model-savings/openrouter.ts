import type { Store } from "../store.js";
import { readSavings } from "./settings.js";

/**
 * R17-046: OpenRouter lets a request say which companies should serve a model, and in what order
 * (its documented `provider` object). Branch reaches OpenRouter through the ordinary OpenAI-shaped
 * connection, so the preference travels on the request and the connection itself only sends it
 * when its address really is openrouter.ai; no other service ever sees it.
 */
export interface OpenRouterRouting {
  sort?: "price" | "throughput" | "latency";
  order?: string[];
  only?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
  data_collection?: "deny";
}

/** True only for OpenRouter's own address (or a subdomain of it). */
export function isOpenRouterEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch { return false; }
}

/** The `provider` object to send, or null when the card is off or says nothing beyond the defaults. */
export function openRouterRouting(store: Pick<Store, "get">, owner: string): OpenRouterRouting | null {
  const saved = readSavings(store, owner, "openrouter");
  if (saved.mode !== "on") return null;
  const routing: OpenRouterRouting = {
    ...(saved.sort ? { sort: saved.sort } : {}),
    ...(saved.order.length ? { order: saved.order } : {}),
    ...(saved.only.length ? { only: saved.only } : {}),
    ...(saved.ignore.length ? { ignore: saved.ignore } : {}),
    ...(saved.allowFallbacks ? {} : { allow_fallbacks: false }),
    ...(saved.dataCollection === "deny" ? { data_collection: "deny" as const } : {}),
  };
  return Object.keys(routing).length ? routing : null;
}

/** What the OpenAI-shaped connection adds to its body: only for openrouter.ai, only when asked. */
export function openRouterBodyPart(endpoint: string, routing: OpenRouterRouting | undefined): { provider?: OpenRouterRouting } {
  return routing && isOpenRouterEndpoint(endpoint) ? { provider: routing } : {};
}

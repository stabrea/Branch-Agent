import type { Provider } from "./contracts.js";
import type { NetworkPolicy } from "./network-policy.js";
import {
  type CatalogEntry, type Capability,
  catalogEntry, missingExtras, resolveBaseUrl, supportsCapability,
} from "./provider-catalog.js";
import { AnthropicProvider, OpenAIProvider } from "./providers.js";
import { AzureOpenAIProvider } from "./providers/azure-openai.js";
import { BedrockProvider } from "./providers/bedrock.js";
import { CohereProvider } from "./providers/cohere.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenAIResponsesProvider } from "./providers/openai-responses.js";

/**
 * Turning one line of the catalog into a working connection. There is one adapter per wire shape,
 * not one per service, so a new service that speaks a shape Branch already knows is a few lines of
 * data and no code at all.
 */
export interface ConnectionInput {
  /** The catalog id, for example "azure-openai". */
  provider: string;
  /** The key, token or AWS secret the service wants. Local services may leave it empty. */
  key: string;
  /** The answers to whatever else the service asks for, such as a region or a deployment name. */
  extras?: Record<string, string>;
  model?: string;
  /** Every request made through this connection goes through the owner's network rules. */
  policy?: NetworkPolicy;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
}

export interface BuiltConnection {
  entry: CatalogEntry;
  provider: Provider;
  model: string;
  baseUrl: string;
}

/** The one place a key is turned into a live connection, so every shape is set up the same way. */
export function buildConnection(input: ConnectionInput): BuiltConnection {
  const entry = catalogEntry(input.provider);
  if (!entry) throw new Error(`Branch does not know a model service called "${input.provider}"`);
  const extras = input.extras ?? {};
  const missing = missingExtras(entry, extras);
  if (missing.length) throw new Error(`${entry.name} still needs: ${missing.join(", ")}`);
  if (entry.auth !== "none" && !input.key.trim())
    throw new Error(`${entry.name} needs a key before it can be used`);
  const baseUrl = resolveBaseUrl(entry, extras);
  assertAddressAllowed(baseUrl);
  const model = (input.model ?? entry.defaultModel).trim();
  if (!model) throw new Error(`${entry.name} needs the name of a model`);
  const call = input.policy ? input.policy.guard(input.fetchImpl ?? globalThis.fetch) : input.fetchImpl;
  return { entry, model, baseUrl, provider: adapterFor(entry, baseUrl, model, input.key, extras, call, input.now) };
}

/** The same rule every provider address follows: HTTPS, or plain HTTP only on this computer. */
export function assertAddressAllowed(address: string): URL {
  const url = new URL(address);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    throw new Error("A model service address must start with https://, or with http:// only on this computer");
  if (url.username || url.password || url.hash)
    throw new Error("A model service address must not carry a password or a #fragment");
  return url;
}

function adapterFor(
  entry: CatalogEntry, baseUrl: string, model: string, key: string,
  extras: Record<string, string>, fetchImpl: typeof globalThis.fetch | undefined, now?: () => Date,
): Provider {
  switch (entry.shape) {
    case "openai-chat":
      return new OpenAIProvider({ endpoint: baseUrl, model, apiKey: key || "local" });
    case "openai-responses":
      return new OpenAIResponsesProvider({ endpoint: baseUrl, model, apiKey: key, ...(fetchImpl ? { fetchImpl } : {}) });
    case "anthropic-messages":
      return new AnthropicProvider({ endpoint: baseUrl, model, apiKey: key });
    case "gemini":
      return new GeminiProvider({ endpoint: baseUrl, model, apiKey: key, ...(entry.auth === "bearer" ? { bearer: true } : {}) });
    case "azure-openai":
      return new AzureOpenAIProvider({
        endpoint: baseUrl, model, apiKey: key,
        apiVersion: extras.apiVersion?.trim() || defaultExtra(entry, "apiVersion") || "2024-10-01-preview",
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "bedrock-converse":
      return new BedrockProvider({
        endpoint: baseUrl, model, region: extras.region!.trim(), accessKeyId: extras.accessKeyId!.trim(),
        secretAccessKey: key, ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}),
      });
    case "cohere-chat-v2":
      return new CohereProvider({ endpoint: baseUrl, model, apiKey: key, ...(fetchImpl ? { fetchImpl } : {}) });
    case "ollama":
      return new OllamaProvider({ endpoint: baseUrl, model, ...(fetchImpl ? { fetchImpl } : {}) });
  }
}
function defaultExtra(entry: CatalogEntry, key: string): string | undefined {
  return (entry.extras ?? []).find((extra) => extra.key === key)?.default;
}

/**
 * Why a connection cannot do a piece of work, and which other one could, in words a person can act
 * on. Returns null when the connection is fine for the job.
 */
export function capabilityRefusal(
  providerId: string, needed: Capability, others: { id: string; providerId: string; name: string }[],
): string | null {
  const entry = catalogEntry(providerId);
  if (!entry || supportsCapability(entry, needed)) return null;
  const able = others.filter((other) => {
    const candidate = catalogEntry(other.providerId);
    return candidate ? supportsCapability(candidate, needed) : false;
  });
  const plain = plainCapability(needed);
  if (!able.length) return `${entry.name} cannot ${plain}, and no other connection you have set up can either.`;
  return `${entry.name} cannot ${plain}. ${able.map((other) => other.name).join(" or ")} can, so use one of those instead.`;
}
const plainWords: Record<Capability, string> = {
  chat: "hold a conversation",
  vision: "be shown a picture",
  tools: "use your tools",
  "json-mode": "reply in a fixed format",
  streaming: "reply as it goes",
  embeddings: "compare passages",
  audio: "handle speech",
  images: "make pictures",
};
export function plainCapability(capability: Capability): string {
  return plainWords[capability];
}

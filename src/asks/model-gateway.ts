/**
 * A1012: the model-gateway layer. Gateways such as the Vercel AI Gateway (what the AI SDK talks to)
 * and OpenRouter name a model as `vendor/model` ("anthropic/claude-sonnet-4"); a service reached
 * directly names it without the vendor ("claude-sonnet-4"). People type both, so a model name is
 * worked out for where it is going:
 *
 *   to a gateway           a bare name gets the vendor it belongs to, in that gateway's spelling
 *   to the vendor itself   a `vendor/` in front is taken off when it is that vendor's own
 *   anywhere else          the name is left exactly as typed
 *
 * Nothing is guessed beyond the families listed below; an unknown bare name goes to a gateway as
 * typed, and the gateway's own answer says whether it knows it.
 */
type Vendor = "openai" | "anthropic" | "google" | "mistral" | "xai" | "deepseek" | "meta" | "cohere" | "perplexity" | "moonshot" | "qwen";

const families: readonly [RegExp, Vendor][] = [
  [/^(gpt-|o\d|chatgpt-|text-embedding-)/, "openai"],
  [/^claude-/, "anthropic"],
  [/^(gemini-|gemma-)/, "google"],
  [/^(mistral-|codestral|magistral|devstral|pixtral|ministral)/, "mistral"],
  [/^grok-/, "xai"],
  [/^deepseek-/, "deepseek"],
  [/^llama-?\d/, "meta"],
  [/^command-/, "cohere"],
  [/^sonar/, "perplexity"],
  [/^(kimi-|moonshot-)/, "moonshot"],
  [/^(qwen|qwq)/, "qwen"],
];

/** How each gateway spells a vendor, where it differs from the plain name. */
const gatewaySpelling: Record<string, Partial<Record<Vendor, string>>> = {
  "vercel-ai-gateway": { meta: "meta", moonshot: "moonshotai", qwen: "alibaba" },
  openrouter: { meta: "meta-llama", moonshot: "moonshotai", qwen: "qwen", xai: "x-ai", mistral: "mistralai" },
};

/** The catalog services that are one vendor's own, and the vendor names that mean them. */
const directVendors: Record<string, readonly string[]> = {
  openai: ["openai"], "openai-responses": ["openai"], "azure-openai": ["openai"],
  anthropic: ["anthropic"], gemini: ["google", "gemini"], "vertex-ai": ["google"],
  mistral: ["mistral", "mistralai"], xai: ["xai", "x-ai"], deepseek: ["deepseek"],
  cohere: ["cohere"], perplexity: ["perplexity"], moonshot: ["moonshot", "moonshotai"],
};

export const gatewayServices = Object.keys(gatewaySpelling);

/** The vendor a bare model name belongs to, when it is one of the known families. */
export function vendorOf(model: string): Vendor | null {
  const name = model.trim().toLowerCase();
  return families.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

/** The model name to send to this catalog service. */
export function gatewayModel(catalogId: string, model: string): string {
  const typed = model.trim();
  const spelling = gatewaySpelling[catalogId];
  if (spelling) {
    if (typed.includes("/")) return typed;
    const vendor = vendorOf(typed);
    return vendor ? `${spelling[vendor] ?? vendor}/${typed}` : typed;
  }
  const own = directVendors[catalogId];
  const slash = typed.indexOf("/");
  if (own && slash > 0 && own.includes(typed.slice(0, slash).toLowerCase())) return typed.slice(slash + 1);
  return typed;
}

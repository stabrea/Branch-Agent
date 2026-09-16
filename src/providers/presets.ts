import { z } from "zod";

export const headerStyle = z.enum(["bearer", "x-api-key", "azure-key", "google-key"]);
export type HeaderStyle = z.infer<typeof headerStyle>;

export const providerKind = z.enum(["cloud", "local"]);
export type ProviderKind = z.infer<typeof providerKind>;

export const ProviderPresetSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i),
  displayName: z.string().min(1).max(100),
  baseUrl: z.string().url().max(2048),
  headerStyle,
  /** Well-known model identifiers for this provider; may not be exhaustive. */
  modelIds: z.array(z.string().min(1).max(256)).max(20),
  /** Plain-language help text: where to get an API key or how to set up the local service. */
  keyHelp: z.string().min(1).max(500),
  kind: providerKind,
}).strict();

export type ProviderPreset = z.infer<typeof ProviderPresetSchema>;

/**
 * Built-in named provider presets. Each preset includes the base URL,
 * a list of well-known model IDs, and plain-language guidance on where to get keys or set up local services.
 * The UI uses this catalog to populate a dropdown; users can pick a preset and enter an API key.
 */
export const builtInPresets: ProviderPreset[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    headerStyle: "bearer",
    modelIds: ["gpt-4o", "gpt-4-turbo", "gpt-4", "gpt-4o-mini", "gpt-3.5-turbo"],
    keyHelp:
      "Get an API key from https://platform.openai.com/account/api-keys. Keep your key private and regenerate it if compromised.",
    kind: "cloud",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    headerStyle: "x-api-key",
    modelIds: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-opus-4-1", "claude-3-sonnet"],
    keyHelp:
      "Get an API key from https://console.anthropic.com/. Keep your key private and regenerate it if compromised.",
    kind: "cloud",
  },
  {
    id: "groq",
    displayName: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    headerStyle: "bearer",
    modelIds: ["mixtral-8x7b-32768", "gemma-7b-it", "llama-3-70b-8192", "llama-3-8b-8192"],
    keyHelp: "Get an API key from https://console.groq.com/. Keep your key private.",
    kind: "cloud",
  },
  {
    id: "mistral",
    displayName: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    headerStyle: "bearer",
    modelIds: ["mistral-large-2", "mistral-medium", "mistral-small"],
    keyHelp: "Get an API key from https://console.mistral.ai/. Keep your key private.",
    kind: "cloud",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    headerStyle: "bearer",
    modelIds: ["deepseek-chat", "deepseek-coder"],
    keyHelp: "Get an API key from https://platform.deepseek.com/. Keep your key private.",
    kind: "cloud",
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    headerStyle: "bearer",
    modelIds: ["meta-llama/llama-3-70b-instruct", "mistralai/mistral-large", "openai/gpt-4-turbo"],
    keyHelp: "Get an API key from https://openrouter.ai/. Keep your key private.",
    kind: "cloud",
  },
  {
    id: "together",
    displayName: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    headerStyle: "bearer",
    modelIds: ["mistral-7b", "llama-2-70b-chat", "meta-llama/Llama-3-70b-chat-hf"],
    keyHelp: "Get an API key from https://together.ai/. Keep your key private.",
    kind: "cloud",
  },
  {
    id: "fireworks",
    displayName: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    headerStyle: "bearer",
    modelIds: ["accounts/fireworks/models/llama-v2-70b-chat", "accounts/fireworks/models/mistral-7b-instruct"],
    keyHelp: "Get an API key from https://fireworks.ai/. Keep your key private.",
    kind: "cloud",
  },
  {
    id: "perplexity",
    displayName: "Perplexity",
    baseUrl: "https://api.perplexity.ai",
    headerStyle: "bearer",
    modelIds: ["pplx-7b-online", "pplx-70b-online", "pplx-7b", "pplx-70b"],
    keyHelp: "Get an API key from https://www.perplexity.ai/. Keep your key private.",
    kind: "cloud",
  },
  {
    id: "xai",
    displayName: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    headerStyle: "bearer",
    modelIds: ["grok-beta"],
    keyHelp: "Get an API key from https://console.x.ai/. Keep your key private.",
    kind: "cloud",
  },
  {
    id: "cerebras",
    displayName: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    headerStyle: "bearer",
    modelIds: ["llama-3.3-70b"],
    keyHelp: "Get an API key from https://www.cerebras.ai/. Keep your key private.",
    kind: "cloud",
  },
  {
    id: "ollama",
    displayName: "Ollama (Local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    headerStyle: "bearer",
    modelIds: ["llama2", "mistral", "neural-chat", "starling-lm"],
    keyHelp:
      "Install Ollama from https://ollama.ai/ and run `ollama serve` in a terminal. Any placeholder API key works.",
    kind: "local",
  },
  {
    id: "lm-studio",
    displayName: "LM Studio (Local)",
    baseUrl: "http://127.0.0.1:1234/v1",
    headerStyle: "bearer",
    modelIds: ["local-model"],
    keyHelp:
      "Download LM Studio from https://lmstudio.ai/ and load a model. Any placeholder API key works.",
    kind: "local",
  },
];

/**
 * Returns a preset by id, or undefined if not found.
 */
export function findPreset(id: string): ProviderPreset | undefined {
  return builtInPresets.find((p) => p.id === id);
}

/**
 * Returns all built-in presets.
 */
export function allPresets(): ProviderPreset[] {
  return builtInPresets;
}

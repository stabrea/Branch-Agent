import type { ReasoningEffort } from "./models.js";

/**
 * Redesign phase 2 (accounts, critique #22): which thinking levels a connection's model really takes.
 *
 * Branch sends a thinking level in exactly three places, and nowhere else, so this map is those three:
 * - `reasoning_effort` (low / medium / high) from the OpenAI-shaped connection (src/providers.ts) and
 *   `reasoning.effort` from the Responses API connection (src/providers/openai-responses.ts, which
 *   Perplexity's agent connection extends) and the ChatGPT sign-in (src/chatgpt-provider.ts);
 * - an extended-thinking budget of 1,024 / 4,096 / 8,192 tokens from the Anthropic connection
 *   (src/providers.ts, `anthropicThinking`), which Claude on Vertex extends.
 * Every other connection (Gemini's own, Ollama, Cohere, Bedrock, Azure, the installed programs)
 * ignores the level, so the window offers none for it rather than a control that does nothing.
 *
 * Within those, only models that think take a level: sending one to a model that does not is refused
 * by the service or ignored. The families below are the ones their services document as reasoning
 * models; a model outside them is offered no level (the safe side: nothing breaks, nothing is faked).
 */
export type ThinkingHow = "effort" | "budget" | "none";
export interface ThinkingLevels {
  how: ThinkingHow;
  /** The levels this model takes, in order. Empty when it takes none. */
  levels: ReasoningEffort[];
}

const all: ReasoningEffort[] = ["low", "medium", "high"];
const effortProviders = new Set(["openai-compatible", "openai-responses", "perplexity-agent", "chatgpt"]);
const budgetProviders = new Set(["anthropic", "anthropic-vertex"]);
const none: ThinkingLevels = { how: "none", levels: [] };

/** The model's own name, without a router's vendor prefix ("openai/gpt-5" → "gpt-5"). */
const bare = (model: string): string => model.toLowerCase().split("/").pop() ?? "";

/** OpenAI-shaped reasoning models, and the two others that take the same field with fewer levels. */
function effortLevels(model: string): ReasoningEffort[] {
  const name = bare(model);
  // xAI documents only "low" and "high" for grok-3-mini's reasoning_effort.
  if (/^grok-3-mini/.test(name)) return ["low", "high"];
  if (/^(o[1-9]|gpt-5|gpt-oss|codex)/.test(name)) return all;
  // Gemini's OpenAI-shaped address maps reasoning_effort onto its thinking for 2.5 and later.
  if (/^gemini-(2\.5|[3-9])/.test(name)) return all;
  return [];
}
/** Claude models with extended thinking: 3.7 Sonnet and every Claude 4 and later. */
function takesBudget(model: string): boolean {
  const name = bare(model);
  return /claude-3-7/.test(name) || /claude-(opus|sonnet|haiku)-([4-9]|\d{2})/.test(name) || /claude-([4-9]|\d{2})-/.test(name);
}

/** What the window may offer for one connection: its provider's name and its model. */
export function thinkingLevels(provider: string, model: string): ThinkingLevels {
  if (effortProviders.has(provider)) {
    const levels = effortLevels(model);
    return levels.length ? { how: "effort", levels } : none;
  }
  if (budgetProviders.has(provider)) return takesBudget(model) ? { how: "budget", levels: all } : none;
  return none;
}

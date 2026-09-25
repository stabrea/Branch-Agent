import type { ModelPreset } from "./models.js";

/**
 * How many tokens one request to a model may hold: its context window. Branch used to give every
 * model the same 20,000. A model now gets its own window, but only from a source that can be named:
 *
 *   - a model on this computer that Branch loaded: the room for words it was loaded with (the
 *     `num_ctx` or `context_length` Branch asked the runtime for), never the most the model supports,
 *     because the runtime cuts off anything past what is loaded without saying so;
 *   - a line below: a figure the service itself reported, with where and when it said so.
 *
 * A model with neither keeps 20,000. No figure here is guessed from a model's name or family.
 * The owner's own figure (Settings, "Room in one request") comes before all of these.
 */
export const unknownContextWindow = 20000;

export type WindowSource = "loaded" | "service" | "unknown";
export interface ModelWindow { tokens: number; source: WindowSource }

/**
 * `route` is the provider a connection talks through (its `provider.name`), because the same model
 * may have another window on another route: through an API key rather than a plan, for one.
 */
interface WindowLine { route: string; model: string; tokens: number }
const windowLines: readonly WindowLine[] = [
  // The ChatGPT plan route (src/chatgpt-provider.ts). OpenAI's own model list for a ChatGPT plan, as
  // OpenAI's Codex CLI 0.153.4 received it on 2026-09-23, gives each of these `context_window: 272000`
  // and `effective_context_window_percent: 95`: 258,400 tokens of it usable by a request.
  { route: "chatgpt", model: "gpt-5.6-sol", tokens: 258_400 },
  { route: "chatgpt", model: "gpt-5.6-terra", tokens: 258_400 },
  { route: "chatgpt", model: "gpt-5.6-luna", tokens: 258_400 },
  { route: "chatgpt", model: "gpt-5.5", tokens: 258_400 },
];

/** The window a connection's model has and where that figure comes from. The owner's figure is not applied here. */
export function modelWindow(preset: Pick<ModelPreset, "provider" | "model" | "loadedContext">): ModelWindow {
  if (preset.loadedContext && preset.loadedContext > 0) return { tokens: preset.loadedContext, source: "loaded" };
  const line = windowLines.find((one) => one.route === preset.provider.name && one.model === preset.model);
  return line ? { tokens: line.tokens, source: "service" } : { tokens: unknownContextWindow, source: "unknown" };
}

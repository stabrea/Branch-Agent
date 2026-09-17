import { OpenAIResponsesProvider, type ResponsesOptions } from "./openai-responses.js";

/**
 * Perplexity's Agent API (`POST https://api.perplexity.ai/v1/agent`), which replaces its Sonar chat
 * route: Perplexity supports Sonar only until 27 September 2026
 * (https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview).
 *
 * The Agent API speaks the Responses shape Branch already knows, with three differences handled here:
 *   - the route is `/agent` rather than `/responses`;
 *   - a model is picked either by a preset (`fast`, `low`, `medium`, `high`, `xhigh`) or by a
 *     `provider/model` name, so a preset name goes in `preset` and anything else in `model`;
 *   - input text parts are `input_text` only, so an earlier reply is sent as plain words.
 */
export const perplexityPresets = ["fast", "low", "medium", "high", "xhigh"] as const;

/** Perplexity's own table of which preset replaces which Sonar model. */
export const sonarToPreset: Record<string, (typeof perplexityPresets)[number]> = {
  sonar: "fast",
  "sonar-pro": "low",
  "sonar-reasoning-pro": "medium",
  "sonar-deep-research": "high",
};

/** The model a saved Sonar connection should use now; anything else is left exactly as it was. */
export function agentModelFor(model: string): string {
  return sonarToPreset[model.trim()] ?? model;
}

function isPreset(model: string): boolean {
  return (perplexityPresets as readonly string[]).includes(model);
}

/** A reply Branch sent earlier becomes plain words, since the Agent API takes only input parts. */
function plainAssistant(item: unknown): unknown {
  const message = item as { type?: string; role?: string; content?: { type?: string; text?: string }[] };
  if (message.type !== "message" || message.role !== "assistant" || !Array.isArray(message.content)) return item;
  return { ...message, content: message.content.map((part) => part.text ?? "").join("\n") };
}

/**
 * A Sonar name Perplexity's migration guide gives no replacement for (for example `sonar-reasoning`)
 * is refused before anything is sent, rather than guessed at or sent to a route that will not know it.
 */
function assertNotRetiredSonar(model: string): void {
  if (/^sonar(\b|-)/.test(model))
    throw new Error(`Perplexity no longer offers "${model}". Pick one of its presets instead (${perplexityPresets.join(", ")}) under Settings → Models.`);
}

export function perplexityBody(body: Record<string, unknown>): Record<string, unknown> {
  const { model, input, ...rest } = body;
  const chosen = agentModelFor(String(model ?? ""));
  assertNotRetiredSonar(chosen);
  return {
    ...(isPreset(chosen) ? { preset: chosen } : { model: chosen }),
    ...rest,
    input: Array.isArray(input) ? input.map(plainAssistant) : input,
  };
}

export class PerplexityAgentProvider extends OpenAIResponsesProvider {
  override readonly name: string = "perplexity-agent";
  constructor(options: Omit<ResponsesOptions, "path" | "shapeBody">) {
    super({ ...options, path: "/agent", shapeBody: perplexityBody });
  }
  /** Perplexity has no speech, comparing or picture route at this address. */
  override audio(): null { return null; }
  override embeddings(): null { return null; }
  override images(): null { return null; }
  /** It publishes no list of models to check a key against. */
  modelsList(): null { return null; }
}

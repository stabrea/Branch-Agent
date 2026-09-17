import { AnthropicProvider } from "../providers.js";

/**
 * Claude through Google Cloud Vertex AI. Anthropic lists Vertex as a supported way to reach Claude
 * (https://code.claude.com/docs/en/legal-and-compliance); Google bills the owner's own project.
 *
 * Vertex takes the Anthropic Messages body with three changes, which this file makes on the way out
 * so the ordinary Anthropic adapter does everything else:
 *   - the address is `.../publishers/anthropic/models/{model}:rawPredict` (`:streamRawPredict` when
 *     streaming) instead of `/messages`;
 *   - the model is named in the address, so it leaves the body, and the body carries
 *     `anthropic_version: "vertex-2023-10-16"` instead of a header;
 *   - the owner's Google access token goes in `Authorization`, never in `x-api-key`.
 * Source: https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai
 */
export const vertexAnthropicVersion = "vertex-2023-10-16";

/**
 * Google serves the "global" location from the plain host and every other region from its own. The
 * catalog address is written `{location}-aiplatform…`, so the global one is put right here.
 */
export function vertexHost(hostname: string): string {
  return hostname === "global-aiplatform.googleapis.com" ? "aiplatform.googleapis.com" : hostname;
}

type Fetch = typeof globalThis.fetch;

/** A Vertex model name goes into the address, so only the characters Google's names use are let through. */
function vertexModel(model: string): string {
  if (!/^[A-Za-z0-9._@-]{1,120}$/.test(model)) throw new Error("A Claude model name on Vertex may only contain letters, digits, dots, dashes and @");
  return model;
}

/** Turns the Anthropic adapter's request into the Vertex one. Only the `/messages` route is changed. */
export function vertexFetch(model: string, token: string, next: Fetch): Fetch {
  return async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (!url.pathname.endsWith("/messages") || typeof init?.body !== "string") return next(input, init);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const { model: _named, ...rest } = body;
    const verb = rest.stream === true ? "streamRawPredict" : "rawPredict";
    url.hostname = vertexHost(url.hostname);
    url.pathname = url.pathname.replace(/\/messages$/, `/models/${vertexModel(model)}:${verb}`);
    const headers = new Headers(init.headers);
    headers.delete("x-api-key");
    headers.delete("anthropic-version");
    headers.set("authorization", `Bearer ${token}`);
    return next(url.toString(), {
      ...init, headers, body: JSON.stringify({ anthropic_version: vertexAnthropicVersion, ...rest }),
    });
  };
}

export interface AnthropicVertexOptions {
  endpoint: string;
  model: string;
  /** A Google access token for the owner's own project (for example from `gcloud auth print-access-token`). */
  token: string;
  fetchImpl?: Fetch;
}

export class AnthropicVertexProvider extends AnthropicProvider {
  override readonly name: string = "anthropic-vertex";
  constructor(options: AnthropicVertexOptions) {
    super({
      endpoint: options.endpoint, model: options.model, apiKey: options.token,
      fetchImpl: vertexFetch(options.model, options.token, options.fetchImpl ?? globalThis.fetch),
    });
  }
  /** Vertex has no Anthropic batch route at this address. */
  override batch(): null { return null; }
}

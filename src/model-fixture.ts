import type { CompletionRequest, Message } from "./contracts.js";
import type { ModelPreset } from "./models.js";
import { presetRunsLocally } from "./models.js";

/**
 * FQ-models.hosted-local: one conversation, run unchanged through whichever connections are
 * configured, so a hosted connection and a local one are proven against the same fixture rather
 * than two different ones that happen to both say "OK". The check is a whole round trip — the
 * connection is asked to call a tool, then handed that tool's own answer and asked to repeat it —
 * so a connection that can only produce plain text does not pass by accident.
 */
export const fixtureToolName = "fixture.echo";
const fixtureWord = "pingback";

function fixtureMessages(): Message[] {
  return [
    { role: "system", content: "You are Branch Agent, answering a connection check. Use the tool you are given." },
    { role: "user", content: `Call ${fixtureToolName} with word set to "${fixtureWord}", then tell me what it answered.` },
  ];
}
function fixtureRequest(signal: AbortSignal, messages: Message[] = fixtureMessages()): CompletionRequest {
  return {
    messages,
    tools: [{
      name: fixtureToolName,
      description: "Echoes a single word back, so a connection check can prove a full round trip.",
      parameters: { type: "object", properties: { word: { type: "string" } }, required: ["word"], additionalProperties: false },
    }],
    maxTokens: 200,
    signal,
  };
}

export interface FixtureResult {
  presetId: string;
  name: string;
  model: string;
  /** True when this connection runs on this computer, so the two sides of the fixture can be told apart. */
  local: boolean;
  passed: boolean;
  /** One sentence naming why it failed; null when it passed. */
  reason: string | null;
  ms: number;
}

/** Runs the fixture through one connection and reports whether the whole round trip held. */
export async function runFixture(preset: ModelPreset, signal: AbortSignal): Promise<FixtureResult> {
  const started = Date.now();
  const described = { presetId: preset.id, name: preset.name, model: preset.model, local: presetRunsLocally(preset) };
  try {
    const asked = fixtureMessages();
    const first = await preset.provider.complete(fixtureRequest(signal, asked));
    const call = first.toolCalls[0];
    if (!call || call.name !== fixtureToolName) throw new Error(`did not call ${fixtureToolName}`);
    let args: unknown;
    try { args = JSON.parse(call.arguments); } catch { throw new Error("sent tool arguments that do not parse as JSON"); }
    const word = (args as { word?: unknown }).word;
    if (typeof word !== "string" || !word) throw new Error("did not send a word for the tool to echo");
    const second = await preset.provider.complete(fixtureRequest(signal, [
      ...asked,
      { role: "assistant", content: first.content, toolCalls: first.toolCalls },
      { role: "tool", content: `echo: ${word}`, toolCallId: call.id },
    ]));
    if (!second.content.toLowerCase().includes(word.toLowerCase()))
      throw new Error("did not read the tool's answer back");
    return { ...described, passed: true, reason: null, ms: Date.now() - started };
  } catch (error) {
    return { ...described, passed: false, reason: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
  }
}

/** Runs the fixture through every named connection, one at a time, so one slow answer never races another. */
export async function runFixtureOn(presets: ModelPreset[], signal: AbortSignal): Promise<FixtureResult[]> {
  const results: FixtureResult[] = [];
  for (const preset of presets) results.push(await runFixture(preset, signal));
  return results;
}

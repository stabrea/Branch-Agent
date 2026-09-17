import { chatgptPresetPrefix } from "../chatgpt-presets.js";
import { ChatGPTProvider } from "../chatgpt-provider.js";
import type { ModelPreset } from "../models.js";
import { CliAgentProvider } from "../providers/cli-agent.js";
import { trunkSignInRefusal, unwrapProvider } from "./pool-provider.js";

export { trunkKeyRefusal, trunkSignInRefusal } from "./pool-provider.js";

/**
 * mac7/lockdown-fix (R17-005): a sign-in account is never used for a Trunk. A Trunk's conversation,
 * its seat in a room and its routines only ever answer through an API key: the one the owner picked
 * for that Trunk, or, with "copy from owner" on, the owner's own keys. A ChatGPT sign-in, an
 * installed program's sign-in (claude, codex, gemini, copilot) and Gemini signed in with Google are
 * left out wherever the connection comes from: the task's model list, a side job, or an account pool.
 */
/** True for a connection that answers through somebody's sign-in rather than an API key. */
export function isSignInConnection(preset: Pick<ModelPreset, "id" | "provider">): boolean {
  const provider = unwrapProvider(preset.provider);
  return provider instanceof ChatGPTProvider || provider instanceof CliAgentProvider
    || preset.id.startsWith(chatgptPresetPrefix) || preset.id === "google-gemini";
}

/** The connections a Trunk may use, in the same order; a refusal when none is left. */
export function trunkCandidates<T extends Pick<ModelPreset, "id" | "provider">>(candidates: readonly T[]): T[] {
  const usable = candidates.filter((preset) => !isSignInConnection(preset));
  if (!usable.length) throw new Error(trunkSignInRefusal);
  return usable;
}

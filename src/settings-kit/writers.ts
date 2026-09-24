import type { AskPart } from "../asks/settings.js";
import { reachKey, reachParts, type ReachPart } from "../reach/settings.js";
import type { Store } from "../store.js";
import { saveDictationSettings } from "../voice-dictation.js";
import { saveWakeWordSettings } from "../voice-wake.js";
import type { Writer } from "./changes.js";

/**
 * Settings whose save does more than write the record: a switch that adds or takes away a tool, or
 * starts or stops a listener. Every way of changing a setting — the window's presets and settings
 * file, and the assistant changing one because the owner asked — saves through these, so a tool never
 * lingers after its switch went off and a listener never keeps running (see ApplyChoice.writers).
 */
export interface WriterParts {
  store: Store;
  runtime: { owner: string };
  learningCore: { configure(input: unknown): unknown };
  learningLoop: { configure(input: unknown): unknown };
  security: { configure(input: unknown): unknown };
  wake: { refresh(): unknown };
  dictation: { refresh(): unknown };
  asks: { setMode(part: AskPart, input: unknown): unknown };
  reachParts: { setMode(part: ReachPart, input: unknown): Promise<unknown> };
}

export function settingsKitWriters(app: WriterParts): Record<string, Writer> {
  return {
    "fly-core": (patch) => { app.learningCore.configure(patch); },
    reflection: (patch) => { app.learningLoop.configure(patch); },
    // Integration review: each through its own save, so a tool or a helper comes and goes at once.
    "security-check": (patch) => { app.security.configure(patch); },
    // mac7/wake-mic: the switch reached this way starts and stops the listener exactly as the card's own switch does.
    "wake-word": (patch) => { saveWakeWordSettings(app.store, app.runtime.owner, patch); app.wake.refresh(); },
    // mac7/live-voice: the switch reached this way stops dictation exactly as the card's own switch does. It can
    // only ever stop it: nothing here opens a microphone without the owner pressing Dictate.
    "live-dictation": (patch) => { saveDictationSettings(app.store, app.runtime.owner, patch); app.dictation.refresh(); },
    ...Object.fromEntries((["analytics", "answer-engine", "runtimes", "nodes", "project-board"] as const)
      .map((part) => [`asks-${part}`, (patch: Record<string, unknown>) => { app.asks.setMode(part, patch); }])),
    // r17-i integration review: a reach switch saved through Reach, so its tools and the relay follow at once.
    ...Object.fromEntries(reachParts.map((part) => [reachKey(part), (patch: Record<string, unknown>) => {
      void app.reachParts.setMode(part, patch).catch(() => undefined); // the record is saved before the first await
    }])),
  };
}

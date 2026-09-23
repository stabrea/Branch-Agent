import { z } from "zod";
import type { Store } from "./store.js";
import { currentPerson } from "./people/context.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { lockdownActive } from "./lockdown.js";
import { clearSessionPlanAct, saveSessionPlanAct } from "./plan-act.js";
import { policyPresets, readPolicy } from "./policy.js";
import { conversationCarrier, outsideSourceOf } from "./outside-origin.js"; // mac7/outside-review
import {
  ConversationModeSchema, clearConversationMode, conversationModeSettings, modeChoices,
  readConversationMode, saveConversationMode, saveConversationModeSettings, type ConversationMode,
} from "./conversation-mode.js";

/**
 * Redesign phase 1: the mode chip in the message box.
 *
 *   GET  /api/conversation-mode?sessionId=…   this conversation's mode, what it follows, what may be picked
 *   POST /api/conversation-mode               { sessionId, mode } picks one; mode null follows the owner's setting again
 *
 * Nobody but the owner may pick a mode looser than the owner's setting, and while Lockdown is on
 * nobody may pick one looser than Ask first. The enforcement is in the runtime (src/runtime.ts
 * `conversationPolicy`); these refusals only keep the screen honest about it.
 */
export class ConversationModeError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
interface ModeApp {
  store: Store;
  runtime: { owner: string };
}
export const conversationModePath = "/api/conversation-mode";
export const conversationModeSettingsPath = "/api/conversation-mode/settings";
export const handlesConversationModePath = (path: string): boolean => path === conversationModePath || path === conversationModeSettingsPath;

const ChoiceSchema = z.object({
  sessionId: z.string().uuid(),
  mode: ConversationModeSchema.nullable(),
}).strict();

/** The owner, at this computer, in the app window: not a household profile and not a short-lived key. */
const ownerHere = (store: Store): boolean => !startedWithShortLivedKey() && !currentPerson() && !store.profiles.active();

function view(app: ModeApp, sessionId: string | null) {
  const policy = readPolicy(app.store, app.runtime.owner);
  const locked = lockdownActive(app.store, app.runtime.owner);
  const owner = ownerHere(app.store);
  const label = policyPresets().find((preset) => preset.id === policy.preset)?.label ?? "Your own rules";
  const choices = modeChoices(policy.preset, { locked, owner });
  const settings = conversationModeSettings(app.store, app.runtime.owner);
  /* The owner's default for a new conversation; when it cannot be picked here (Lockdown, somebody else
     in the house, a short-lived key) the conversation follows the owner's setting instead. */
  const wanted = settings.newConversation === "follow" ? null : settings.newConversation;
  const startable = wanted !== null && choices.some((choice) => choice.mode === wanted && choice.available);
  return {
    sessionId,
    mode: readConversationMode(app.store, app.runtime.owner, sessionId)?.mode ?? null,
    /* What a conversation started in the window is given; null when that would be looser than allowed here. */
    newConversation: startable ? wanted : null,
    following: { preset: policy.preset, label },
    locked, owner, choices, settings,
    /* mac7/outside-review: where the work this conversation carries on came from, when that was outside
       the window. It then asks before every change whatever is picked, and the chip says why. */
    outside: sessionId ? outsideSourceOf(app.store, conversationCarrier(app.store, sessionId) ?? undefined) : null,
  };
}

/** Why this mode cannot be picked here now (Lockdown, not the owner, a short-lived key), or null. */
export function modeRefusal(app: ModeApp, mode: ConversationMode): string | null {
  const preset = readPolicy(app.store, app.runtime.owner).preset;
  const choice = modeChoices(preset, { locked: lockdownActive(app.store, app.runtime.owner), owner: ownerHere(app.store) })
    .find((one) => one.mode === mode);
  return choice && !choice.available ? choice.why : null;
}

/** Picks a mode for one conversation. Plan also turns on "Show me the plan first"; leaving it turns that back. */
export function pickConversationMode(app: ModeApp, sessionId: string, mode: ConversationMode | null): void {
  const owner = app.runtime.owner, before = readConversationMode(app.store, owner, sessionId);
  if (before?.planSet && mode !== "plan") clearSessionPlanAct(app.store, owner, sessionId);
  if (mode === null) return clearConversationMode(app.store, owner, sessionId);
  const planSet = mode === "plan";
  if (mode === "plan" && !before?.planSet)
    saveSessionPlanAct(app.store, owner, sessionId, app.store.projects.active(owner).id, { planMode: "show-plan" });
  saveConversationMode(app.store, owner, sessionId, { mode, planSet });
}

export async function conversationModeApi(app: ModeApp, method: string, url: URL, readBody: () => Promise<unknown>): Promise<unknown> {
  if (url.pathname === conversationModeSettingsPath) {
    if (method === "POST") {
      if (!ownerHere(app.store)) throw new ConversationModeError(403, "Only the owner can choose what new conversations start on.");
      return { settings: saveConversationModeSettings(app.store, app.runtime.owner, await readBody()) };
    }
    return { settings: conversationModeSettings(app.store, app.runtime.owner) };
  }
  if (method === "GET") {
    const sessionId = url.searchParams.get("sessionId");
    return view(app, sessionId && z.string().uuid().safeParse(sessionId).success ? sessionId : null);
  }
  if (method !== "POST") throw new ConversationModeError(405, "Use GET or POST");
  const choice = ChoiceSchema.parse(await readBody());
  if (!app.store.ownsSession(app.store.profiles.scope(), choice.sessionId))
    throw new ConversationModeError(404, "That conversation was not found.");
  const refused = choice.mode ? modeRefusal(app, choice.mode) : null;
  if (refused) throw new ConversationModeError(403, refused);
  pickConversationMode(app, choice.sessionId, choice.mode);
  return view(app, choice.sessionId);
}

/** When the owner agrees a plan in a Plan conversation, it may now act: the conversation moves to Ask first. */
export function planAgreed(app: ModeApp, sessionId: string): void {
  if (readConversationMode(app.store, app.runtime.owner, sessionId)?.mode === "plan")
    pickConversationMode(app, sessionId, "ask");
}

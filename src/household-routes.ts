/**
 * profile-audit: what the app window may still change while it is switched to a household profile.
 *
 * Switching the window to somebody else's profile makes the window that person (src/profiles.ts).
 * The owner's own parts of Branch — settings of every kind, permissions, secrets and sign-ins, the
 * sandbox and network, chat apps and pairing, devices and the phone, integrations, add-ons and
 * skills, backups and restores, updates, the danger zone and the people here — are refused to them
 * in one sentence, at one place in src/server.ts, before any route's own code runs.
 *
 * The rule fails closed, like the short-lived key's (src/short-lived-keys.ts): anything a
 * short-lived key is refused is refused here too, unless it is listed below as something a person
 * does with their own things (their conversations, what is remembered for them, documents, notes,
 * lists), or is one of the two ways out of a profile. A route added later is the owner's until
 * somebody lists it here, and tests/household-profile.test.mjs fails until the table in
 * tests/short-lived-key-routes.mjs and this list agree.
 *
 * Out of the box this is separation on one computer, not a lock: going back to the owner's profile
 * needs no PIN. The owner may set one (src/profiles.ts, household-followups), and then it is a lock
 * against somebody at the keyboard — still not against somebody who can open the data folder.
 *
 * household-followups: clearing old conversations (/api/retention/prune), writing the usage file now,
 * sending the morning brief to the owner's chats, and putting back an older version of a file or a
 * whole snapshot in the owner's workspace (/api/history/restore, /api/history/snapshots/:id/restore)
 * are the owner's: each works on the owner's records or reaches the owner's chats. Importing
 * conversations and remembered facts stays a person's own, because both write only under the
 * profile switched on (profiles.scope()); taking a snapshot changes nothing and stays too.
 */
import type { TaskRoute } from "./short-lived-keys.js";

const id = "[a-f0-9-]{36}";
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** One of a person's own routes, written as the table writes it (":id" for any id). */
const own = (path: string, methods = "POST"): TaskRoute[] => methods.split(",").map((method) => ({
  method: method as TaskRoute["method"],
  pattern: new RegExp(`^${path.split(":id").map(escape).join(id)}$`),
  why: "a household person's own things",
}));

/**
 * The one sentence, the same one `Profiles.requireOwner` says. Two areas already promised to name
 * themselves in it (the chat apps and their Set up panel); everything else is "This".
 */
export const householdRefusal = "This belongs to the owner. Switch back to the owner's profile to use it.";
const areaWords: readonly [RegExp, string][] = [
  [/^\/api\/channels(\/|$)/, "Your chat apps"],
  [/^\/api\/channel-setup(\/|$)/, "Setting up chat apps"],
];
export function householdRefusalFor(path: string): string {
  const what = areaWords.find(([pattern]) => pattern.test(path))?.[1];
  return what ? householdRefusal.replace("This", what) : householdRefusal;
}

/** The routes a household person at the window may change something through, beyond a task's. */
export const householdOwnRoutes: readonly TaskRoute[] = [
  // The two ways out: switching back to the owner (or to somebody else), and locking the window.
  ...own("/api/profiles/switch"),
  ...own("/api/lock"),
  // The table's "other" rows: a person's own conversations, memory, documents, notes and lists.
  ...[
    own("/api/asks/analytics/event"),
    own("/api/asks/answer"),
    own("/api/asks/article"),
    own("/api/asks/blocks/run"),
    own("/api/asks/hindsight/recall"),
    own("/api/asks/intents/decide"),
    own("/api/asks/nodes/ask"),
    own("/api/asks/nodes/check"),
    own("/api/asks/pages"),
    own("/api/asks/pages/:id/remove"),
    own("/api/asks/sources/sync"),
    own("/api/asks/surfaces/:id/refresh"),
    own("/api/batch/run"),
    own("/api/coding/ci"),
    own("/api/conversation-mode"), // redesign phase 1: never looser than the owner's setting (src/conversation-mode-api.ts)
    own("/api/documents"),
    own("/api/documents/:id", "DELETE"),
    own("/api/documents/reindex"),
    own("/api/evaluation"),
    own("/api/evaluation/compare"),
    own("/api/evaluation/live"),
    own("/api/evaluation/run"),
    own("/api/evaluation/suites"),
    own("/api/evaluation/suites/from-run"),
    own("/api/evaluation/suites/remove"),
    own("/api/evaluation/tools"),
    own("/api/firewall/test"),
    own("/api/flows"),
    own("/api/flows/:id", "PUT,DELETE"),
    own("/api/flows/check"),
    own("/api/flows/yaml"),
    own("/api/history/snapshots"),
    own("/api/issues/context"),
    own("/api/knowledge"),
    own("/api/knowledge/:id", "DELETE"),
    own("/api/knowledge/attach"),
    own("/api/knowledge/export"),
    own("/api/knowledge/graph"),
    own("/api/knowledge/import"),
    own("/api/knowledge/manage"),
    own("/api/knowledge/map"),
    own("/api/knowledge/pictures"),
    own("/api/knowledge/refresh"),
    own("/api/knowledge/reindex"),
    own("/api/knowledge/retention/check"),
    own("/api/knowledge/source"),
    own("/api/knowledge/summarise"),
    own("/api/labels"),
    own("/api/labels/remove"),
    own("/api/learn/cost"),
    own("/api/learn/map"),
    own("/api/learn/tour"),
    own("/api/learning-more/blocks"),
    own("/api/learning-more/blocks/edit"),
    own("/api/learning-more/blocks/remove"),
    own("/api/learning-more/memory/label"),
    own("/api/local-models/details"),
    own("/api/local-models/offers"),
    own("/api/local-models/routing/preview"),
    own("/api/local-models/search"),
    own("/api/marks/forget"),
    own("/api/marks/undo"),
    own("/api/memory/checkpoints"),
    own("/api/memory/checkpoints/:id/restore"),
    own("/api/memory/consolidate"),
    own("/api/memory/forget"),
    own("/api/memory/forget/preview"),
    own("/api/memory/hygiene"),
    own("/api/memory/import"),
    own("/api/memory/index"),
    own("/api/memory/learned"),
    own("/api/memory/proposals/:id/accept"),
    own("/api/memory/proposals/:id/reject"),
    own("/api/memory/tidy"),
    own("/api/memory/tidy/all"),
    own("/api/memory/versions/restore"),
    own("/api/models/probe"),
    own("/api/models/profiles/preview"),
    own("/api/models/test"),
    own("/api/monitors"),
    own("/api/move-in/preview"),
    own("/api/obsidian/write"),
    own("/api/people/conversations"),
    own("/api/people/conversations/:id/message"),
    own("/api/people/me/passkeys/begin"),
    own("/api/people/me/passkeys/finish"),
    own("/api/people/me/passkeys/remove"),
    own("/api/people/me/pin"),
    own("/api/people/me/sign-out"),
    own("/api/personal/brief/play"),
    own("/api/personal/chat-files/send"),
    own("/api/personal/google/events"),
    own("/api/personal/home/states"),
    own("/api/personal/mail/search"),
    own("/api/personal/microsoft/events"),
    own("/api/personal/spotify/now"),
    own("/api/personal/x/search"),
    own("/api/projects/notes"),
    own("/api/projects/notes/:id/remove"),
    own("/api/qa/scenarios"),
    own("/api/qa/scenarios/:id/accept"),
    own("/api/qa/scenarios/:id/reject"),
    own("/api/reach/notes"),
    own("/api/reach/notes/remove"),
    own("/api/reach/notes/rewrite"),
    own("/api/reflection/batches/:id/accept"),
    own("/api/reflection/batches/:id/reject"),
    own("/api/reflection/learn"),
    own("/api/reflection/look-back"),
    own("/api/reflection/new-skills/reject"),
    own("/api/reflection/new-skills/try"),
    own("/api/reflection/retire"),
    own("/api/reports"),
    own("/api/request-cache/clear"),
    own("/api/retrieval/context"),
    own("/api/retrieval/pipelines"),
    own("/api/rules/test"),
    own("/api/runs/:id/recording/flow"),
    own("/api/safety-extras/wasm/run"),
    own("/api/schedules"),
    own("/api/schedules/:id/remove"),
    own("/api/sessions/:id/discard"),
    own("/api/sessions/:id/duplicate"),
    own("/api/sessions/:id/merge-note"),
    own("/api/sessions/:id/pins"),
    own("/api/sessions/:id/rewind"),
    own("/api/sessions/:id/skill"),
    own("/api/sessions/:id/unrevert"),
    own("/api/sessions/import"),
    own("/api/skill-revisions/reject"),
    own("/api/skill-revisions/try"),
    own("/api/skills/:id/benchmark"),
    own("/api/skills/:id/draft"),
    own("/api/skills/:id/pack"),
    own("/api/skills/:id/test"),
    own("/api/skills/draft-from-runs"),
    own("/api/studies"),
    own("/api/studies/compare"),
    own("/api/studies/run"),
    own("/api/teams"),
    own("/api/teams/:id/remove"),
    own("/api/templates/import"),
    own("/api/todos"),
    own("/api/todos/:id"),
    own("/api/todos/:id/done"),
    own("/api/todos/:id/remind"),
    own("/api/tools/forget"),
    own("/api/tools/notes/:id", "DELETE"),
    own("/api/trunks/:id/seen"),
    own("/api/webhooks/:id/preview"),
    own("/api/workflows"),
    own("/api/workflows/:id/remove"),
  ].flat(),
  { method: "POST", pattern: /^\/api\/channels\/deliveries\/[^/]{1,220}\/retry$/, why: "a household person's own things" },
  { method: "POST", pattern: /^\/api\/memory\/archive\/[^/]{1,200}\/restore$/, why: "a household person's own things" },
  { method: "POST", pattern: /^\/api\/memory\/[^/]{1,200}\/keep$/, why: "a household person's own things" },
];

/**
 * Reads a short-lived key is refused that answer a household person with their own thinned view
 * (the owner's word and the microphone stay out of it): the wake word card and the dictation card.
 */
const householdViews: readonly RegExp[] = [/^\/api\/voice\/wake$/, /^\/api\/voice\/dictation(\/|$)/];

/** True when a household person at the window may send this, whatever a short-lived key may. */
export function householdMaySend(method: string | undefined, path: string): boolean {
  const verb = method ?? "GET";
  if (verb === "GET") return householdViews.some((pattern) => pattern.test(path));
  return householdOwnRoutes.some((route) => route.method === verb && route.pattern.test(path));
}

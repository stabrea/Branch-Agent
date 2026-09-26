/* Two kinds of state. S is the window's own (what is open, what is typed); E is what the engine said (loaded, never
   invented). Only the few window choices worth keeping between visits are saved, in this browser. */

import { api } from "./api.js";
import { render } from "./dom.js";

const SAVED_KEY = "branch-window";
const SAVED = ["level", "placesShut", "theme", "sideW"];

export const S = {
  view: "chat",
  chat: null,
  tabs: { inbox: "needs", automations: "scheduled", library: "memory", customize: "trunks" },
  setPage: "general",
  level: "regular",
  drafts: {},
  placesShut: false,
  theme: null,
  sideW: null,
  signedIn: true,
};

export const E = {
  state: null,
  trunks: [],
  trunkModes: {},
  rooms: [],
  sessions: [],
  conversation: null,
  profiles: null,
  loaded: false,
};

export function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_KEY) || "{}");
    for (const key of SAVED) if (key in saved) S[key] = saved[key];
  } catch { /* a broken save is ignored */ }
}
export function save() {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(Object.fromEntries(SAVED.map((k) => [k, S[k]])))); } catch { /* storage refused */ }
}

/* The engine's picture of things: state, the Trunks and the conversation list. */
export async function refresh() {
  /* One request first: until the engine accepts the window, every refused request counts against sign-in. */
  const state = await api("state");
  const [trunks, sessions, profiles] = await Promise.all([
    api("trunks").catch(() => null),
    api("sessions?limit=50").catch(() => null),
    api("profiles").catch(() => null),
  ]);
  E.profiles = profiles;
  E.state = state;
  E.trunks = trunks?.trunks ?? (Array.isArray(trunks) ? trunks : []);
  E.trunkModes = trunks?.modes ?? {};
  E.rooms = Array.isArray(trunks?.rooms) ? trunks.rooms : [];
  E.sessions = sessions?.sessions ?? [];
  E.loaded = true;
  render();
}

/* Who is using Branch now: GET /api/profiles answers `active` as the person's profile ({ id, name, … }), or null for the
   owner, whose name is the engine's owner label. */
export const activeId = () => E.profiles?.active?.id ?? null;
export const personHere = () => E.profiles?.active?.name || E.profiles?.roleLabels?.owner?.label || "";
/* Whether the one at the window is the owner, as the engine says (GET /api/profiles isOwner). Owner-only controls are drawn
   only then: not while the answer is missing, and never for a household person (they are not theirs to use, not "coming soon"). */
export const ownerHere = () => E.profiles?.isOwner === true;

/* The level control: Regular 0, Advanced 1, Technical 2. */
export const LEVELS = { regular: 0, advanced: 1, technical: 2 };
export const level = () => LEVELS[S.level] ?? 0;

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
  sessions: [],
  conversation: null,
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
  const [state, trunks, sessions] = await Promise.all([
    api("state"),
    api("trunks").catch(() => null),
    api("sessions?limit=50").catch(() => null),
  ]);
  E.state = state;
  E.trunks = trunks?.trunks ?? (Array.isArray(trunks) ? trunks : []);
  E.sessions = sessions?.sessions ?? [];
  E.loaded = true;
  render();
}

/* The level control: Regular 0, Advanced 1, Technical 2. */
export const LEVELS = { regular: 0, advanced: 1, technical: 2 };
export const level = () => LEVELS[S.level] ?? 0;

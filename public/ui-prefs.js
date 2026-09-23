/* Q45: the window's own choices (which side list, the folded panes and groups, the side pane's tab,
   Focus view, the one-time lines already shown, and the side list's names, pins and hidden rows for
   conversations) are kept by Branch in its data folder, through
   /api/ui-preferences, and read here before the parts that use them draw. Browser storage belongs to
   the page's address, and the desktop app picks a new port each time it starts, so a choice kept only
   there came back as the default after an update.

   Browser storage is still written, as a copy, for the owner's window: an older version opened at this
   same address finds what was chosen, and a window the engine cannot answer (not signed in yet) still
   has something. What the engine holds always wins over the copy. The first time, whatever an older
   version left in this page's storage and the engine does not hold yet is handed to the engine, which
   only fills empty fields (src/ui-preferences.ts), so nothing already saved is ever overwritten.

   Signing in, or switching to another person, reads the engine again; the parts that use a choice hear
   "branch-ui-prefs" with the choices that changed and show them, without saving anything back. */
import { t } from "/i18n.js";

const IMPORT = "legacy-local-v1";
const root = document.documentElement;
const local = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* a private window forgets */ } },
};
const openClosed = { read: (s) => (s === "open" ? true : s === "closed" ? false : undefined), write: (v) => (v ? "open" : "closed") };
const seenOnce = { read: (s) => (s === "1" ? true : undefined), write: (v) => (v ? "1" : null) };
const stamp = { read: (s) => (typeof s === "string" && /^\d{1,16}$/.test(s) ? Number(s) : undefined), write: (v) => String(v) };
const list = (item) => ({
  list: true,
  read: (s) => {
    let parsed;
    try { parsed = JSON.parse(s ?? "null"); } catch { return undefined; }
    return Array.isArray(parsed) ? parsed.filter((one) => typeof one === "string" && item.test(one)).slice(-50) : undefined;
  },
  write: (v) => JSON.stringify(v),
});
/* The side list's groups were kept per workspace (branch-group-<name>::<workspace>), falling back to
   the name alone for a choice made before the workspace had one; the copy keeps that same key. */
const group = (name) => ({
  field: `${name}Open`, ...openClosed,
  copyKey: () => `branch-group-${name}` + (local.get("branch-owner") ? "::" + local.get("branch-owner") : ""),
});
/** Each choice: its field in the engine, and the browser-storage key and wording older versions used. */
const FIELDS = {
  "branch-rail-view": { field: "railView", read: (s) => (s === "trunks" || s === "conversations" ? s : undefined), write: (v) => v },
  "branch-rail": { field: "railOpen", ...openClosed },
  "branch-aside": { field: "asideOpen", ...openClosed },
  "branch-pane-tab": { field: "paneTab", read: (s) => (typeof s === "string" && /^[a-z0-9-]{1,40}$/.test(s) ? s : undefined), write: (v) => v },
  "branch-focus-view": { field: "focusView", read: (s) => (s === "1" ? true : s === "0" ? false : undefined), write: (v) => (v ? "1" : "0") },
  "branch-group-sections": group("sections"),
  "branch-group-projects": group("projects"),
  "branch-group-recents": group("recents"),
  "branch-inbox-seen": { field: "inboxSeenAt", ...stamp },
  "branch-calm-tip": { field: "calmTipSeen", ...seenOnce },
  "branch-first-run-next": { field: "firstRunNextSeen", ...seenOnce },
  "branch-pet-hint-at": { field: "petHintAt", ...stamp },
  "branch-pet-tips-seen": { field: "petTipsSeen", ...list(/^[A-Za-z0-9._-]{1,80}$/) },
  "branch-save-progress-asked": { field: "saveProgressAsked", ...list(/^[^\u0000-\u001f\u007f]{1,200}$/) },
};
const copyKey = (key) => FIELDS[key]?.copyKey?.() ?? key;
const copyOf = (key) => local.get(copyKey(key)) ?? (copyKey(key) === key ? null : local.get(key));
/* The side list's own labels for conversations (a name, a pin, taken off the list): the engine keeps
   them only for conversations the person owns (src/conversation-marks.ts); older versions kept these. */
const MARKS = "branch-conversations";
const MARK_COPIES = { names: "branch-names", pinned: "branch-pins", buried: "branch-buried" };
const noMarks = () => ({ names: {}, pinned: [], buried: [] });
function marksCopy() {
  const parse = (key) => { try { return JSON.parse(local.get(key) ?? "null"); } catch { return null; } };
  const names = parse(MARK_COPIES.names), pinned = parse(MARK_COPIES.pinned), buried = parse(MARK_COPIES.buried);
  return {
    names: names && typeof names === "object" && !Array.isArray(names) ? names : {},
    pinned: Array.isArray(pinned) ? pinned : [], buried: Array.isArray(buried) ? buried : [],
  };
}
const someMarks = (marks) => Boolean(Object.keys(marks.names).length || marks.pinned.length || marks.buried.length);

/** What the engine answered: { revision, values, conversations, imports, forOwner }, or null while it could not. */
let engine = null;
/** The page's copy stands in only before the engine answers, or for the owner before the import is written down. */
const copyCounts = () => !engine || (engine.forOwner && !engine.imports?.[IMPORT]);
const ownersWindow = () => (engine ? engine.forOwner !== false : root.dataset.household !== "on");
const fromSnapshot = (snapshot) => ({
  revision: snapshot.revision, values: { ...(snapshot.values ?? {}) }, conversations: snapshot.conversations ?? noMarks(),
  imports: snapshot.imports ?? {}, forOwner: snapshot.forOwner !== false,
});

async function call(path, body, wait = 4000) {
  const token = (() => { try { return sessionStorage.getItem("branch-token") || ""; } catch { return ""; } })();
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    /* A change still reaches the engine when the page is reloaded or closed right after it is made. */
    ...(path === "/api/ui-preferences" && body !== undefined ? { keepalive: true } : {}),
    signal: AbortSignal.timeout(wait),
  });
  if (!response.ok) throw Object.assign(new Error("The window's choices could not be reached"), { status: response.status });
  return response.json();
}

/** What an older version left in this page's storage that the engine does not hold yet. */
function unsaved(values) {
  const offered = {};
  for (const [key, { field, read }] of Object.entries(FIELDS)) {
    const value = read(copyOf(key));
    if (value !== undefined && values[field] === undefined) offered[field] = value;
  }
  return offered;
}

/** Why the last read of the engine failed: a refusal (signed out) has a status below 500. */
let lastFailure = null;
/**
 * The engine's record for whoever the window is for now, with the one-time import done unless `importing`
 * is false; null when it cannot answer. Until the import is written down the page's copy still counts,
 * so the window can draw before it returns.
 */
async function read({ importing = true } = {}) {
  let snapshot;
  try { snapshot = await call("/api/ui-preferences"); } catch (error) { lastFailure = error; return null; /* not signed in yet, or no engine: the copy here stands */ }
  /* Once only, and only for the owner: after the import is written down, this page's storage is only
     ever a copy, so what somebody else at this computer chose here later is never handed over. */
  if (!importing || snapshot.forOwner === false || snapshot.imports?.[IMPORT]) return snapshot;
  /* Written down even when there is nothing to bring, so what lands in this page's storage later never counts. */
  try {
    const values = unsaved(snapshot.values ?? {}), conversations = marksCopy();
    snapshot = { ...snapshot, ...(await call("/api/ui-preferences/import", { name: IMPORT, values, conversations }, 15000)) };
  } catch { /* tried again next start */ }
  return snapshot;
}
function keepMarkCopies(marks) {
  local.set(MARK_COPIES.names, JSON.stringify(marks.names));
  local.set(MARK_COPIES.pinned, JSON.stringify(marks.pinned));
  local.set(MARK_COPIES.buried, JSON.stringify(marks.buried));
}
function keepCopies() {
  if (!engine?.forOwner) return;
  for (const [key, { field, write }] of Object.entries(FIELDS))
    if (engine.values[field] !== undefined) local.set(copyKey(key), write(engine.values[field]));
  if (someMarks(engine.conversations)) keepMarkCopies(engine.conversations);
}

/** A choice, in the words older versions stored it in: the engine's if it holds one, else this page's copy while that still counts. */
export function choice(key) {
  const known = FIELDS[key];
  const value = known && engine ? engine.values[known.field] : undefined;
  if (value !== undefined) return known.write(value);
  return !known || copyCounts() ? copyOf(key) : null;
}
function marksNow() {
  if (engine && (someMarks(engine.conversations) || !copyCounts())) return engine.conversations;
  return copyCounts() ? marksCopy() : noMarks();
}
/** The side list's labels: { names: Map, pinned: Set, buried: Set }, the engine's, or this page's copy while that still counts. */
export function conversationMarks() {
  const marks = marksNow();
  return { names: new Map(Object.entries(marks.names)), pinned: new Set(marks.pinned), buried: new Set(marks.buried) };
}

const snapshotAt = await read({ importing: false });
if (snapshotAt) { engine = fromSnapshot(snapshotAt); keepCopies(); }

let queue = Promise.resolve();
let pending = 0;
const profileNow = () => root.dataset.profileGeneration || "0";
/** Fields changed here while a new read of the engine was on its way, so its late answer never undoes them. */
let changedDuringRead = null;
function unsavedNote(fields) {
  document.dispatchEvent(new CustomEvent("branch-ui-prefs-unsaved", { detail: { fields } }));
  const words = t("prefs.unsaved");
  globalThis.toast?.(words === "prefs.unsaved" ? "That choice could not be saved with your workspace. It stays in this window for now." : words);
}
async function send(change, profile, attempt = 0) {
  /* A change made for the person the window was on before a switch is never saved to the next one. */
  if (profile !== profileNow()) return;
  try {
    const answer = await call("/api/ui-preferences", change);
    if (engine) engine.revision = answer.revision;
  } catch (error) {
    /* A dropped connection or an engine error is tried again; a refusal (signed out, a key that may not change it) is not. */
    if ((!error.status || error.status >= 500) && attempt < 3) {
      await new Promise((done) => setTimeout(done, 1000 * (attempt + 1)));
      return send(change, profile, attempt + 1);
    }
    if (profile === profileNow())
      unsavedNote([...Object.keys(change.set ?? {}), ...Object.keys(change.add ?? {}), ...(change.mark ? ["conversation"] : [])]);
  }
}
/** Sends a change to the engine after every change made before it. */
function enqueue(change, field) {
  changedDuringRead?.add(field);
  pending++;
  const profile = profileNow();
  queue = queue.then(() => send(change, profile)).finally(() => { pending--; });
}
/** Keeps a choice: here at once, and in the engine in the order they were made. */
export function keepChoice(key, text) {
  const known = FIELDS[key];
  if (!known || ownersWindow()) local.set(copyKey(key), text);
  const value = known?.read(text ?? undefined) ?? (known && text === null ? null : undefined);
  if (!known || value === undefined) return;
  if (known.list) {
    const before = engine?.values[known.field] ?? known.read(copyOf(key)) ?? [];
    const added = (value ?? []).filter((one) => !before.includes(one));
    if (!added.length) return;
    if (engine) engine.values[known.field] = [...before.filter((one) => !added.includes(one)), ...added].slice(-50);
    return enqueue({ add: { [known.field]: added } }, known.field);
  }
  if (engine) { if (value === null) delete engine.values[known.field]; else engine.values[known.field] = value; }
  enqueue({ set: { [known.field]: value } }, known.field);
}
/** Labels one conversation in the side list: { name } (null for none), { pinned } or { buried }. */
export function markConversation(id, change) {
  const marks = structuredClone(marksNow());
  if ("name" in change) { delete marks.names[id]; if (change.name) marks.names[id] = change.name; }
  const put = (list, on) => [...list.filter((one) => one !== id), ...(on ? [id] : [])];
  if ("pinned" in change) marks.pinned = put(marks.pinned, change.pinned);
  if ("buried" in change) marks.buried = put(marks.buried, change.buried);
  if (engine) engine.conversations = marks;
  if (ownersWindow()) keepMarkCopies(marks);
  enqueue({ mark: { id, ...change } }, MARKS);
}
/** Settles once every choice made so far has been answered, for whatever waits before a restart. */
export function choicesSaved() { return pending ? queue : Promise.resolve(); }

/* Signing in (a plain browser tab answered 401 at start) or switching person: read the engine again and
   tell the parts that use a choice which ones changed. Only the newest read lands. */
let reads = 0;
const shownNow = () => ({ ...Object.fromEntries(Object.keys(FIELDS).map((key) => [key, choice(key)])), [MARKS]: JSON.stringify(marksNow()) });
async function reread() {
  const mine = ++reads;
  await choicesSaved();
  const shown = shownNow();
  changedDuringRead = new Set();
  const snapshot = await read();
  const kept = changedDuringRead;
  changedDuringRead = null;
  if (!snapshot || mine !== reads) return Boolean(engine);
  const next = fromSnapshot(snapshot);
  for (const field of kept) {
    if (field === MARKS) next.conversations = engine?.conversations ?? next.conversations;
    else if (engine?.values[field] === undefined) delete next.values[field];
    else next.values[field] = engine.values[field];
  }
  engine = next;
  keepCopies();
  const now = shownNow();
  const keys = Object.keys(now).filter((key) => now[key] !== shown[key]);
  if (keys.length) document.dispatchEvent(new CustomEvent("branch-ui-prefs", { detail: { keys } }));
  return true;
}
/* An engine slow to answer at start (busy, or still starting) is asked again a few times; a refusal waits for signing in. */
function askAgain(attempt = 1) {
  if (engine || attempt > 3 || (lastFailure?.status && lastFailure.status < 500)) return;
  setTimeout(() => void reread().then((answered) => { if (!answered) askAgain(attempt + 1); }), 1500 * attempt);
}
if (!snapshotAt) askAgain();
/* The one-time import runs once the window has drawn (from the engine and, until then, this page's copy). */
else if (engine.forOwner && !engine.imports[IMPORT]) void reread();
globalThis.branchUiPrefsReady = () => reread();
document.addEventListener("branch-profile", () => void reread());

/* Q45: the window's own choices (which side list, the folded panes, the side pane's tab, Focus view)
   are kept by Branch in its data folder, through /api/ui-preferences, and read here before the parts
   that use them draw. Browser storage belongs to the page's address, and the desktop app picks a new
   port each time it starts, so a choice kept only there came back as the default after an update.

   Browser storage is still written, as a copy: an older version opened at this same address finds
   what was chosen, and a window the engine cannot answer (not signed in yet) still has something.
   What the engine holds always wins over the copy. The first time, whatever an older version left
   in this page's storage and the engine does not hold yet is handed to the engine, which only fills
   empty fields (src/ui-preferences.ts), so nothing already saved is ever overwritten. */

const IMPORT = "legacy-local-v1";
const openClosed = { read: (s) => (s === "open" ? true : s === "closed" ? false : undefined), write: (v) => (v ? "open" : "closed") };
/** Each choice: its field in the engine, and the browser-storage key and wording older versions used. */
const FIELDS = {
  "branch-rail-view": { field: "railView", read: (s) => (s === "trunks" || s === "conversations" ? s : undefined), write: (v) => v },
  "branch-rail": { field: "railOpen", ...openClosed },
  "branch-aside": { field: "asideOpen", ...openClosed },
  "branch-pane-tab": { field: "paneTab", read: (s) => (typeof s === "string" && /^[a-z0-9-]{1,40}$/.test(s) ? s : undefined), write: (v) => v },
  "branch-focus-view": { field: "focusView", read: (s) => (s === "1" ? true : s === "0" ? false : undefined), write: (v) => (v ? "1" : "0") },
};

const local = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* a private window forgets */ } },
};
/** What the engine answered at start (and since): { revision, values }, or null when it could not. */
let engine = null;

async function call(path, body) {
  const token = (() => { try { return sessionStorage.getItem("branch-token") || ""; } catch { return ""; } })();
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw Object.assign(new Error("The window's choices could not be reached"), { status: response.status });
  return response.json();
}

/** What an older version left in this page's storage that the engine does not hold yet. */
function unsaved(values) {
  const offered = {};
  for (const [key, { field, read }] of Object.entries(FIELDS)) {
    const value = read(local.get(key));
    if (value !== undefined && values[field] === undefined) offered[field] = value;
  }
  return offered;
}

async function load() {
  let snapshot;
  try { snapshot = await call("/api/ui-preferences"); } catch { return; /* not signed in yet, or no engine: the copy here stands */ }
  const offered = unsaved(snapshot.values ?? {});
  if (Object.keys(offered).length)
    try { snapshot = await call("/api/ui-preferences/import", { name: IMPORT, values: offered }); } catch { /* tried again next start */ }
  engine = { revision: snapshot.revision, values: { ...(snapshot.values ?? {}) } };
  for (const [key, { field, write }] of Object.entries(FIELDS))
    if (engine.values[field] !== undefined) local.set(key, write(engine.values[field]));
}
await load();

/** A choice, in the words older versions stored it in: the engine's if it holds one, else this page's copy. */
export function choice(key) {
  const known = FIELDS[key];
  const value = known && engine ? engine.values[known.field] : undefined;
  return value !== undefined ? known.write(value) : local.get(key);
}

let queue = Promise.resolve();
let pending = 0;
async function send(set, attempt = 0) {
  try {
    const answer = await call("/api/ui-preferences", { set });
    if (engine) engine.revision = answer.revision;
  } catch (error) {
    /* A refusal (signed out, or a key that may not change it) is not tried again; a dropped connection is. */
    if (error.status && error.status < 500) return;
    if (attempt < 3) { await new Promise((done) => setTimeout(done, 1000 * (attempt + 1))); return send(set, attempt + 1); }
    document.dispatchEvent(new CustomEvent("branch-ui-prefs-unsaved", { detail: { fields: Object.keys(set) } }));
  }
}
/** Keeps a choice: here at once, and in the engine in the order they were made. */
export function keepChoice(key, text) {
  local.set(key, text);
  const known = FIELDS[key];
  const value = known?.read(text);
  if (!known || value === undefined) return;
  if (engine) engine.values[known.field] = value;
  pending++;
  queue = queue.then(() => send({ [known.field]: value })).finally(() => { pending--; });
}
/** Settles once every choice made so far has been answered, for whatever waits before a restart. */
export function choicesSaved() { return pending ? queue : Promise.resolve(); }

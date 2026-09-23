/* phase2/delight: your own background behind the glass (off unless switched on) — a picture, a video or
   an animation. The file is kept in this window's own storage on this computer (IndexedDB) and is never
   sent anywhere, not even to Branch's own server. A scrim in the theme's own ground colour lies over it
   so text stays readable in every theme; how strong it is can be changed. Small files only.
   mac7/residuals: switching it off keeps the file for next time; "Remove picture" (with a yes first)
   is what throws it away, removing the window's storage for it. */
import { el, notice, on, onDelight, say, state, still } from "/delight-kit.js";
import { acornModel, OAK_VIEW, oakModel, readGlb, view3d } from "/delight-3d.js";

const $ = (id) => document.getElementById(id);
export const LIMITS = { picture: 8, animation: 8, video: 25, "3d": 5 };
const BUILT_IN = { acorn: acornModel, oak: oakModel };
const DB = "branch-delight", STORE = "files", KEY = "background";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
/** One request in its own transaction. It is only done once the transaction is: a full disk shows up there. */
async function withStore(mode, work) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode), request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? request.error);
    });
  } finally { db.close(); }
}
/** Whether the window has storage for a background at all; asking never makes one for somebody who never chose a file. */
async function stored() {
  const names = await indexedDB.databases?.().catch(() => null);
  return !names || names.some((db) => db.name === DB);
}
export const savedBackground = async () =>
  (await stored()) ? withStore("readonly", (store) => store.get(KEY)).catch(() => undefined) : undefined;
/** Keeps the file, or says in plain words why the window's storage would not take it. */
async function keep(value) {
  try {
    await withStore("readwrite", (store) => store.put(value, KEY));
    return null;
  } catch (error) {
    return error?.name === "QuotaExceededError"
      ? say("delight.bg.full", "There is no room left in this window's storage for that file. Choose a smaller one.")
      : say("delight.bg.notKept", "That file could not be kept in this window. Nothing was changed.");
  }
}
/** "Remove picture": the file goes, and the window's storage for it with it. Switching off does not do this. */
export async function forgetBackground() {
  clear();
  if (await stored()) {
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(DB);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }
  await applyBackground();
}

/** A .glb the reader refused, in the window's language. */
const glbWords = (error) => (error?.key ? say(error.key, error.message, error.values) : say("delight.glb.unreadable", "That 3D model could not be read."));

/** Which kind a file is, from its type and, for WebP, whether it moves. Null when it can't go behind the glass. */
export async function kindOf(file) {
  const type = file.type || "", name = file.name.toLowerCase();
  if (name.endsWith(".glb") || type === "model/gltf-binary") return "3d";
  if (type.startsWith("video/")) return "video";
  if (type === "image/gif" || type === "image/apng" || name.endsWith(".apng")) return "animation";
  if (type === "image/webp") {
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    return new TextDecoder().decode(head).includes("ANIM") ? "animation" : "picture";
  }
  if (type.startsWith("image/") && !type.includes("svg")) return "picture";
  return null;
}
/** Keeps a chosen file, or says in plain words why it can't. */
export async function chooseBackground(file) {
  const kind = await kindOf(file);
  if (!kind) return { ok: false, why: say("delight.bg.wrongKind", "That kind of file can't go behind the glass. Choose a picture, a video, an animation (GIF, WebP or APNG) or a 3D model (.glb).") };
  const limit = LIMITS[kind];
  if (file.size > limit * 1024 * 1024)
    return { ok: false, why: say("delight.bg.tooBig", "That file is {size} MB. Keep it under {limit} MB for a {kind}.", { size: (file.size / 1048576).toFixed(1), limit, kind: say(`delight.bg.kind.${kind}`, kind) }) };
  if (kind === "3d") {
    try { readGlb(await file.arrayBuffer()); } catch (error) { return { ok: false, why: glbWords(error) }; }
  }
  const refused = await keep({ blob: file, kind, name: file.name.slice(0, 120), size: file.size, at: Date.now() });
  if (refused) return { ok: false, why: refused };
  /* Still switched off, the caller switches it on, and that shows it (switched off, nothing is kept). */
  if (on("background")) await applyBackground();
  void notice({ what: "background", kind });
  return { ok: true, kind };
}

/** One of Branch's own 3D objects, turning slowly behind the glass. */
export async function chooseBuiltIn(model) {
  if (!BUILT_IN[model]) return { ok: false, why: "" };
  const refused = await keep({ kind: "3d", model, name: say(`delight.bg.model.${model}`, model === "oak" ? "The oak, in 3D" : "The acorn, in 3D"), at: Date.now() });
  if (refused) return { ok: false, why: refused };
  if (on("background")) await applyBackground();
  void notice({ what: "background", kind: "3d" });
  return { ok: true, kind: "3d" };
}

/* ---------- behind the glass ---------- */
let shownUrl = "";
function layer() {
  let wall = $("delight-wall");
  if (!wall) {
    wall = el("div", "delight-wall");
    wall.id = "delight-wall";
    wall.setAttribute("aria-hidden", "true");
    const anchor = $("wall-fx") ?? $("wall");
    if (anchor) anchor.after(wall); else document.body.prepend(wall);
  }
  return wall;
}
let turning = null, shownKey = "", shownModel = "";
function clear() {
  turning?.stop();
  turning = null;
  shownKey = shownModel = "";
  $("delight-wall")?.remove();
  delete document.documentElement.dataset.ownBackground;
  if (shownUrl) URL.revokeObjectURL(shownUrl);
  shownUrl = "";
}
/** The 3D object on its own canvas; a file that cannot be read shows the acorn instead of nothing. */
async function object3d(saved) {
  const canvas = el("canvas", "delight-3d");
  let parts;
  try { parts = saved.model ? BUILT_IN[saved.model]() : readGlb(await saved.blob.arrayBuffer()); } catch { parts = acornModel(); }
  shownModel = saved.model ?? "";
  const framing = saved.model === "oak" ? OAK_VIEW : { distance: saved.model === "acorn" ? 3.8 : 4.4, spin: 0.00025 };
  requestAnimationFrame(() => { turning = view3d(canvas, parts, { ...framing, still }); });
  return canvas;
}
function media(saved, url, fit) {
  if (fit === "tile" && saved.kind !== "video") {
    const tile = el("div", "delight-tile");
    tile.style.setProperty("background-image", `url("${url}")`);
    return tile;
  }
  const node = el(saved.kind === "video" ? "video" : "img", `delight-media fit-${fit === "fit" ? "fit" : "fill"}`);
  node.src = url;
  if (saved.kind === "video") Object.assign(node, { muted: true, loop: true, playsInline: true, autoplay: !still() });
  else node.alt = "";
  return node;
}
export async function applyBackground() {
  // mac7/residuals: switched off, it is only taken down; the file stays for when it is switched on again.
  if (state.available && state.settings?.background?.on === false) return clear();
  const saved = on("background") ? await savedBackground() : undefined;
  if (!saved?.blob && !saved?.model) return clear();
  const wall = layer(), background = state.settings.background;
  const key = `${saved.at}:${background.fit}`;
  if (key !== shownKey) {
    turning?.stop();
    if (shownUrl) URL.revokeObjectURL(shownUrl);
    shownUrl = saved.kind === "3d" ? "" : URL.createObjectURL(saved.blob);
    const shown = saved.kind === "3d" ? await object3d(saved) : media(saved, shownUrl, background.fit);
    wall.replaceChildren(shown, el("div", "delight-scrim"));
    shownKey = key;
  }
  wall.querySelector(".delight-scrim")?.style.setProperty("--own-scrim", String(background.scrim / 100));
  document.documentElement.dataset.ownBackground = saved.kind;
  motion();
}
/** A video pauses for "Keep things still" and while the window is hidden. */
function motion() {
  if (turning) { if (still() || document.hidden) turning.stop(); else turning.start(); }
  const video = document.querySelector("#delight-wall video");
  if (!video) return;
  if (still() || document.hidden) video.pause(); else void video.play().catch(() => undefined);
}
document.addEventListener("visibilitychange", motion);
new MutationObserver(motion).observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
/* Branch's own 3D objects are lit by the theme and the oak dresses for the season, so a new theme or
   season draws them again. */
new MutationObserver(() => { if (turning && BUILT_IN[shownModel]) turning.setParts(BUILT_IN[shownModel]()); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ["data-palette", "data-theme", "data-season"] });
onDelight(() => void applyBackground());

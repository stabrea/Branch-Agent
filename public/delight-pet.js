/* phase2/delight: a pet in the acorn's corner (off unless switched on).
   A small forest creature drawn like the acorn: dithered pixels in the theme's own colours. It naps
   when nothing is happening, paces while a task works, hops when something needs your yes, jumps
   when a task finishes and shivers in Lockdown. It says one thing at a time (#55): every message goes
   through one queue, pops once, stays for its reading time, then goes; a status that stops being true
   goes at once. Tips are short, about what is on screen, each at most once, and get scarcer as your
   rank rises (#51): Bronze now and then, Silver at most hourly, Gold and up none. */
import { el, notice, on, onDelight, say, saveDelight, state, still } from "/delight-kit.js";

export const PET_ART = {
  squirrel: ["................", "..aa............", ".aaaa.......bb..", "aabbaa.....bbbb.", "aabbba....bbebbc", ".abbba...bbbbbb.", ".abbbaa.bbbbbb..", "..abbbaabbwwbb..", "..abbbbabbwwbb..", "...abbbbbbwwbb..", "....aabbbbbbbb..", "......bbb..bbb..", "................"],
  owl: ["................", "....a......a....", "....aa....aa....", "....abbbbbba....", "...abeebbeeba...", "...abeebbeeba...", "...abbbccbbba...", "...abwwwwwwba...", "...abwbwwbwba...", "...abwwwwwwba...", "....abbbbbba....", ".....cc..cc.....", "................"],
  hedgehog: ["................", "................", ".....a.a.a......", "...aaaaaaaa.....", "..aaaaaaaaaab...", ".aaaaaaaaabbbb..", ".aaaaaaaabbbebb.", ".aaaaaaaabbbbbbc", "..aaaaaaabbwbb..", "...bbbbbbbbbb...", "....b..b..b.b...", "................", "................"],
  fox: ["................", "..c.....c.......", "..cc...cc.......", "..cccccccc......", "..cecccceccc....", "...ccwwwwcc.....", "....cwwwwc......", "....ccccccc.....", "...cccccccccc..w", "...ccwwwwccccccw", "...ccwwwwcc.cccc", "....cc..cc......", "................"],
  robin: ["................", "................", "......aaaa......", ".....aaaaeaa....", ".....aaaaaaacc..", "....aacccccaa...", "...aaccccccaa...", "..aaacccccaaa...", ".aaaaacccaaa....", "......aaaa......", "......c..c......", "................", "................"],
  rabbit: ["................", ".....b..b.......", ".....b..b.......", ".....bb.bb......", "....bbbbbb......", "....bebbeb......", "....bbbcbb......", ".....bbbb.......", "....bbbbbbb.....", "...bbwwwwbbbw...", "...bbwwwwbbbb...", "....bb..bb......", "................"],
  snail: ["................", "................", "......aaaa......", ".....aabbaa.....", "....aabccbaa....", "....abcaacba..e.", "....abcaacba..b.", "....aabccbaa.bb.", ".....aabbaa.bbb.", "..bbbbbbbbbbbbb.", ".bbbbbbbbbbbbb..", "................", "................"],
  fawn: ["................", "..b....b........", "..bb..bb........", "...bbbbb........", "...bebbe........", "...bbbbbc.......", "....bbbbbbbbbb..", "....bbwbbwbbbbb.", "....bbbbbbwbbbb.", "....bbbbbbbbbb..", "....b.b....b.b..", "....b.b....b.b..", "................"],
};
export const PET_NAMES = { squirrel: "Squirrel", owl: "Owl", hedgehog: "Hedgehog", fox: "Fox", robin: "Robin", rabbit: "Rabbit", snail: "Snail", fawn: "Deer fawn" };
const BAY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const $ = (id) => document.getElementById(id);
const root = document.documentElement;

/* ---------- colour, from the theme's own tokens ---------- */
const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
function tone(name, fallback) {
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = fallback;
  probe.fillStyle = getComputedStyle(root).getPropertyValue(name).trim() || fallback;
  probe.fillRect(0, 0, 1, 1);
  return [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}
const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
function palette() {
  const text = tone("--text", "#1d2a21"), ground = tone("--ground", "#e9e3d5"), copper = tone("--copper", "#d8612a");
  const dark = root.dataset.theme !== "daylight", white = [255, 255, 255];
  return {
    a: dark ? mix(text, ground, 0.35) : mix(text, ground, 0.15), b: dark ? mix(text, ground, 0.05) : mix(text, ground, 0.45), c: copper,
    w: dark ? mix(text, white, 0.5) : mix(ground, white, 0.6), e: dark ? mix(ground, [0, 0, 0], 0.4) : mix(text, [0, 0, 0], 0.3),
    ok: tone("--ok", "#2e7d4f"),
  };
}

/* ---------- drawing ---------- */
/** One frame of a pet on a 20×18 canvas. `mood` moves it; `plain` leaves out the marks around it. */
export function drawPet(canvas, kind, mood = "nap", frame = 0, plain = false, hop = 0) {
  const W = 20, H = 18, P = palette(), art = PET_ART[kind] ?? PET_ART.squirrel;
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext("2d"), img = g.createImageData(W, H);
  const put = (x, y, col) => { if (x >= 0 && y >= 0 && x < W && y < H) img.data.set([...col, 255], (y * W + x) * 4); };
  const bob = (mood === "working" && frame % 2 ? -1 : 0) + (mood === "done" && frame % 2 ? -2 : 0) - hop;
  const jitter = mood === "shiver" ? (frame % 2 ? 1 : -1) : 0;
  art.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === ".") return;
    let col = P[ch] ?? P.a;
    if (ch === "e" && mood === "nap") col = P.a;
    if ((ch === "a" || ch === "b") && (y / art.length) * 0.5 > (BAY[(y & 3) * 4 + (x & 3)] + 0.5) / 16) col = ch === "b" ? P.a : col;
    put(x + 2 + jitter, y + 4 + bob, col);
  }));
  if (!plain) marks(put, P, mood, frame, W);
  g.putImageData(img, 0, 0);
}
function marks(put, P, mood, frame, W) {
  if (mood === "nap") { put(W - 3, 2 + (frame % 3), P.a); put(W - 2, 1 + (frame % 3), P.a); }
  if (mood === "needs") for (const y of [0, 1, 2, 4]) put(W - 3, y, P.c);
  if (mood === "done") for (let k = 0; k < 6; k++) put((frame * 3 + k * 5) % W, (k * 7 + frame) % 6, k % 2 ? P.c : P.ok);
}

/* ---------- what is going on, read from the window itself ---------- */
let doneAt = 0;
document.addEventListener("branch-run-finished", (event) => { if (event.detail?.status === "completed") doneAt = Date.now(); });
function mood() {
  if (document.body.classList.contains("lx-locked")) return "shiver";
  if (document.body.classList.contains("lx-inbox-waiting")) return "needs";
  if (Date.now() - doneAt < 2600) return "done";
  if ($("new-session")?.disabled) return "working";
  return "nap";
}
const moodWords = {
  needs: ["delight.pet.needs", "Something is waiting for your yes."], working: ["delight.pet.working", "Working on it…"],
  done: ["delight.pet.done", "Done!"], shiver: ["delight.pet.shiver", "Lockdown is on. Brr."],
};
const petName = () => state.settings?.pets?.name || "Hazel";
const kindName = () => say(`delight.pet.kind.${state.settings?.pets?.kind ?? "squirrel"}`, PET_NAMES[state.settings?.pets?.kind] ?? "Squirrel").toLowerCase();

/* ---------- one thing at a time ---------- */
const SAY = { q: [], cur: null, until: 0, tipCool: Date.now() + 20000, seen: new Set(), moodKey: "" };
const readMs = (text) => Math.max(3000, Math.min(8000, (text.split(/\s+/).length / 12) * 1000 + 1500));
function petSay(text, kind, key) {
  const talks = state.settings?.pets?.talks !== false;
  if (!talks || SAY.seen.has(key) || SAY.cur?.key === key || SAY.q.some((m) => m.key === key)) return;
  if (kind === "status") SAY.q = SAY.q.filter((m) => m.kind === "status");
  SAY.q.push({ text, kind, key });
  pump();
}
function paintSay(pop) {
  const bubble = $("pet-say");
  if (!bubble) return;
  bubble.hidden = !SAY.cur;
  if (!SAY.cur) return;
  if (bubble.textContent !== SAY.cur.text) bubble.textContent = SAY.cur.text;
  bubble.classList.toggle("tip", SAY.cur.kind !== "status");
  if (pop && !still()) { bubble.classList.remove("pop"); void bubble.offsetWidth; bubble.classList.add("pop"); }
  placeTail();
}
function pump() {
  const now = Date.now();
  const statusWaiting = SAY.q.some((m) => m.kind === "status");
  if (SAY.cur && (now >= SAY.until || (SAY.cur.kind !== "status" && statusWaiting))) {
    SAY.seen.add(SAY.cur.key);
    if (SAY.cur.kind !== "status") SAY.tipCool = now + tipGap();
    SAY.cur = null;
    paintSay(false);
  }
  if (SAY.cur || !SAY.q.length) return;
  SAY.cur = SAY.q.shift();
  SAY.until = now + readMs(SAY.cur.text);
  paintSay(true);
}
/** A status that is no longer true goes at once; a new one is said once while it lasts. */
function watchMood() {
  const now = mood();
  if (SAY.cur?.kind === "status" && SAY.cur.key !== `status:${now}`) { SAY.cur = null; paintSay(false); }
  SAY.q = SAY.q.filter((m) => m.kind !== "status" || m.key === `status:${now}`);
  if (now !== SAY.moodKey) {
    SAY.moodKey = now;
    SAY.seen = new Set([...SAY.seen].filter((key) => !key.startsWith("status:")));
    const words = moodWords[now];
    if (words) petSay(say(words[0], words[1]), "status", `status:${now}`);
  }
  pump();
}

/* ---------- tips and hints, scarcer as the rank rises ---------- */
/** Bronze: a tip every few minutes at most. Silver: at most one an hour. Gold and up: none. */
function tipGap() {
  return state.rank === "Bronze" ? 3 * 60000 : state.rank === "Silver" ? 60 * 60000 : Infinity;
}
const TIPS = [
  ["chat", "delight.tip.palette", "Ctrl K finds any place, setting or conversation."],
  ["chat", "delight.tip.mode", "The button beside Send says when Branch checks with you. Press it to change that for this conversation."],
  ["calm", "delight.tip.more", "More, at the top right, holds everything the calm window keeps out of sight."],
  ["chat", "delight.tip.lockdown", "Lockdown keeps its own rules, whatever a conversation is set to."],
  ["settings", "delight.tip.search", "The search at the top of Settings finds a setting by what it says."],
  ["appearance", "delight.tip.themes", "There are 44 themes, each by daylight and by moonlight."],
  ["appearance", "delight.tip.still", "Keep things still stops every animation, me included."],
  ["any", "delight.tip.menu", "Right-click me for my own little menu."],
  ["acorn", "delight.tip.acorn", "Drag the acorn to turn it."],
  ["achievements", "delight.tip.private", "Achievements are only for you. They never leave this computer."],
];
function tipFits(where) {
  const settingsOpen = $("settings-window")?.hidden === false;
  if (where === "settings") return settingsOpen;
  if (where === "appearance") return settingsOpen && $("lx-page-appearance")?.hidden === false;
  if (where === "calm") return !settingsOpen && root.dataset.everything !== "on";
  if (where === "chat") return !settingsOpen;
  if (where === "acorn") return root.dataset.acorn === "on";
  if (where === "achievements") return on("achievements");
  return true;
}
const TIP_SEEN = "branch-pet-tips-seen", HINT_AT = "branch-pet-hint-at";
const readSeen = () => { try { return JSON.parse(localStorage.getItem(TIP_SEEN) ?? "[]"); } catch { return []; } };
function maybeTip() {
  const pets = state.settings?.pets;
  if (!pets?.talks || !pets?.tips || mood() !== "nap" || SAY.cur || Date.now() < SAY.tipCool) return;
  const seen = readSeen(), tip = TIPS.find(([where, key]) => !seen.includes(key) && tipFits(where));
  if (tip) {
    try { localStorage.setItem(TIP_SEEN, JSON.stringify([...seen, tip[1]])); } catch { /* a private window forgets */ }
    return petSay(say(tip[1], tip[2]), "tip", `tip:${tip[1]}`);
  }
  maybeHint();
}
/** Now and then a hint at a Bronze or Silver achievement, never a Gold one or higher, at most hourly. */
function maybeHint() {
  const at = Number(localStorage.getItem(HINT_AT) ?? 0);
  if (!on("achievements") || !["Bronze", "Silver"].includes(state.rank) || Date.now() - at < 3600000) return;
  const hint = (state.hints ?? []).find((a) => (a.tier === "Bronze" || a.tier === "Silver") && a.desc && a.desc !== "???");
  if (!hint) return;
  try { localStorage.setItem(HINT_AT, String(Date.now())); } catch { /* a private window forgets */ }
  const text = hint.desc.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase());
  petSay(say("delight.pet.hint", "Psst: {what}, sometime?", { what: text }), "hint", `hint:${hint.id}`);
}

/* ---------- the pet in its corner ---------- */
const walk = { x: 0, dir: 1, target: null, frame: 0, hopUntil: 0, strollAt: Date.now() + 25000 };
let tick = 0, talk = 0;
function build() {
  const lane = $("pet-lane");
  if (!lane || $("pet")) return;
  const pet = el("div", "pet");
  pet.id = "pet";
  pet.tabIndex = 0;
  pet.setAttribute("role", "button");
  const art = el("canvas", "pet-art");
  art.setAttribute("aria-hidden", "true");
  pet.append(art);
  const bubble = el("span", "pet-say");
  bubble.id = "pet-say";
  bubble.hidden = true;
  bubble.setAttribute("role", "status");
  bubble.addEventListener("click", () => { SAY.until = 0; pump(); });
  lane.append(bubble, pet);
  pet.addEventListener("click", pat);
  pet.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pat(); } });
  pet.addEventListener("contextmenu", openMenu);
}
function label() {
  const pet = $("pet");
  if (!pet) return;
  const words = say("delight.pet.label", "{name} the {kind}. Press to pat.", { name: petName(), kind: kindName() });
  pet.setAttribute("aria-label", words);
  pet.title = words;
}
function pat() {
  walk.hopUntil = Date.now() + 500;
  void notice({ what: "pat" });
  if (mood() === "needs") document.querySelector('.lx-place-link[data-place="inbox"]')?.click();
}
function step() {
  const pet = $("pet"), lane = $("pet-lane");
  if (!pet || !lane) return;
  const now = mood(), room = Math.max(0, lane.clientWidth - pet.offsetWidth);
  if (!still()) {
    walk.frame += 1;
    if (now === "working") walk.target = walk.x <= 0 ? room : walk.x >= room ? 0 : walk.target ?? room;
    else if (now === "nap" && Date.now() > walk.strollAt) { walk.target = Math.round(Math.random() * room); walk.strollAt = Date.now() + 25000 + Math.random() * 20000; }
    if (walk.target !== null) {
      const gap = walk.target - walk.x;
      walk.dir = gap < 0 ? -1 : gap > 0 ? 1 : walk.dir;
      walk.x += Math.sign(gap) * Math.min(Math.abs(gap), 2);
      if (walk.x === walk.target && now !== "working") walk.target = null;
    }
  }
  walk.x = Math.min(walk.x, room);
  pet.style.setProperty("--pet-x", `${walk.x}px`);
  pet.classList.toggle("left", walk.dir < 0);
  const hop = Date.now() < walk.hopUntil && !still() ? 2 : 0;
  drawPet(pet.querySelector("canvas"), state.settings.pets.kind, now, still() ? 0 : walk.frame, false, hop);
  placeTail();
}
/** The bubble keeps inside the corner, so it is never cut off; its little tail points at the pet. */
function placeTail() {
  const pet = $("pet"), bubble = $("pet-say");
  if (!pet || !bubble || bubble.hidden) return;
  bubble.style.setProperty("--tail-x", `${walk.x + pet.offsetWidth / 2}px`);
}
function start() {
  if (!tick) tick = setInterval(step, 160);
  if (!talk) talk = setInterval(() => { watchMood(); maybeTip(); }, 500);
}
function stop() {
  clearInterval(tick); clearInterval(talk);
  tick = talk = 0;
}
export function applyPet() {
  const show = on("pets"), corner = $("delight-corner");
  corner?.classList.toggle("has-pet", show);
  if (!show) { stop(); $("pet")?.remove(); $("pet-say")?.remove(); return; }
  build();
  label();
  if (state.settings.pets.talks === false) { SAY.cur = null; SAY.q = []; paintSay(false); }
  step();
  if (document.hidden) stop(); else start();
}
document.addEventListener("visibilitychange", () => { if (on("pets") && !document.hidden) start(); else stop(); });
onDelight(applyPet);

/* ---------- its own menu: right-click it ---------- */
function closeMenu() { $("pet-menu")?.remove(); }
function openMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  closeMenu();
  const menu = el("div", "menu pet-menu");
  menu.id = "pet-menu";
  menu.setAttribute("role", "menu");
  const pets = state.settings.pets;
  const items = [
    ["delight.pet.menu.pat", "Pat", pat],
    [pets.tips ? "delight.pet.menu.noTips" : "delight.pet.menu.tips", pets.tips ? "No more tips" : "Tips again", () => saveDelight({ pets: { tips: !pets.tips } })],
    ["delight.pet.menu.settings", "Pet settings", () => globalThis.branchDelight?.openSettings()],
    ["delight.pet.menu.hide", "Hide the pet", () => saveDelight({ pets: { on: false } })],
  ];
  for (const [key, english, act] of items) {
    const item = el("button", "", say(key, english));
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.addEventListener("click", () => { closeMenu(); void act(); });
    menu.append(item);
  }
  $("delight-corner").append(menu);
  menu.querySelector("button")?.focus();
}
document.addEventListener("pointerdown", (event) => { if (!event.target.closest?.("#pet-menu")) closeMenu(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeMenu(); });

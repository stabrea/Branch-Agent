/* DG-199: Settings shows each setting's row at the level the approved sample gives it (public/settings-row-levels.js,
   measured from design/Branch-Grown-Up.html), not only whole cards. A row is the smallest part of its card that
   holds the control and its words, with the note right under it; it carries data-level like a card, so the same
   rule hides it (public/settings-grown.css) and search still shows everything. A setting the sample does not draw
   as a row follows its card, as before. */
import { SETTINGS_INDEX } from "/settings-index.js";
import { ROW_LEVELS } from "/settings-row-levels.js";

export const RANK = { regular: 0, advanced: 1, technical: 2 };
const WORD = { R: "regular", A: "advanced", T: "technical" };
const NOTE = ":is(p, small, span, div):is(.subtle, .field-note, .note, .hint, .meta, .studio-note, .check-note)";

/**
 * The sample's rows of each card: [setting id, selector, level]. A setting the sample does not draw as a row (it
 * draws some as a control of its own, at Regular) follows its card, and makes the card partial.
 */
const BY_CARD = new Map();
/* Cards never raised above their section by their rows, whatever the sample's rows say: pressing the emergency stop
   (coordinator, 2026-09-23; the sample puts only the stop's setup at Technical), and the rest of "Regular never hides
   a safety control" (S15 in tests/settings-grown.test.mjs): what Branch may do, approvals, desktop control,
   background work, how Branch runs, and updates. */
export const ALWAYS = {
  "safety-stop-card": "#safety-stop-press", "policy-card": "#policy-preset", "approval-reviewer-card": "#approval-reviewer-mode",
  "desktop-card": null, "reach-background-card": null, "deployment-card": null, "updates-card": null, "comfort-updates-card": null,
};
for (const card of Object.keys(ALWAYS)) BY_CARD.set(card, { rows: [], partial: true });
/* DG-183: rows the sample draws as a pointer to a setting kept in another section ("Set in Theme ›"), at the level the
   sample shows the pointer. They are not settings of their own, so public/settings-index.js does not list them, but
   the sample counts them in its section's "N more with Advanced". [card, [row id, selector, level], ...]. */
const POINTERS = [
  ["settings-form", ["appearance-contrast-link", null, "advanced"]],
];
for (const [card, ...rows] of POINTERS) BY_CARD.set(card, { rows: [...rows], partial: false });
for (const [id, , card, , , selector] of SETTINGS_INDEX) {
  if (!card) continue;
  const entry = BY_CARD.get(card) ?? { rows: [], partial: false };
  const level = WORD[ROW_LEVELS[id]];
  if (level) entry.rows.push([id, selector, level]);
  else entry.partial = true;
  BY_CARD.set(card, entry);
}

const shared = (a, b) => { let node = a; while (node && !node.contains(b)) node = node.parentElement; return node; };
const childOf = (box, node) => { while (node && node.parentElement !== box) node = node.parentElement; return node; };
const labelFor = (control, card) => control.labels?.[0] ?? control.closest("label")
  ?? (control.id ? card.querySelector(`[for="${CSS.escape(control.id)}"]`) : null);
/** DG-183: the words naming a control by aria-labelledby (a group of choice buttons), never a heading. */
const namedBy = (control, card) => (control.getAttribute("aria-labelledby") ?? "").split(/\s+/)
  .map((id) => (id ? document.getElementById(id) : null))
  .find((node) => node && node !== control && card.contains(node) && !node.matches("h1, h2, h3, h4, h5, h6")) ?? null;

/**
 * The pieces of the row holding one control: the lowest box with the control and its words when that box holds
 * nothing else; else, in a card that lays its rows out flat, the words, the control and the note right under it.
 * Never the card, its title, or a box holding another setting; null when the row cannot be told apart.
 */
export function rowOf(control, card, others = []) {
  const label = labelFor(control, card);
  const named = label ? null : namedBy(control, card);
  /* Words named by aria-labelledby that make no clean row leave the control as its own row, as before. */
  return rowWith(label ?? named, control, card, others) ?? (named ? rowWith(null, control, card, others) : null);
}
function rowWith(label, control, card, others) {
  const box = label ? shared(label, control) : control;
  if (!box || !card.contains(box)) return null;
  const clean = (node) => node !== card && !node.matches("h2, h3") && !node.querySelector("h2, h3") && !others.some((other) => node.contains(other));
  if (clean(box)) return [box];
  if (!label || label.contains(control) || !clean(label)) return null;
  const pieces = [childOf(box, label), childOf(box, control)];
  if (!pieces.every((piece) => piece && clean(piece))) return null;
  return pieces;
}
const controlOf = (card, id, selector) => {
  const node = document.getElementById(id) ?? (selector ? card.querySelector(selector) : null);
  return node && card.contains(node) ? node : null;
};

/** Every setting of the card the sample levels, with the pieces of its row found now (modules redraw theirs), or none. */
export function rowsIn(card) {
  const entry = BY_CARD.get(card.id);
  if (!entry) return { rows: [], partial: false };
  /* One control is one setting's: two index rows that name the same control (a shared selector) leave the second to its card. */
  const claimed = new Set();
  const found = entry.rows.map(([id, selector, level]) => {
    const control = controlOf(card, id, selector);
    if (control && claimed.has(control)) return { id, level, control: null };
    if (control) claimed.add(control);
    return { id, level, control };
  });
  const controls = found.map((one) => one.control).filter(Boolean);
  const rows = found.map(({ id, level, control }) => {
    const pieces = control && rowOf(control, card, controls.filter((other) => other !== control));
    const note = pieces?.at(-1).nextElementSibling;
    return { id, level, pieces: pieces ? [...pieces, ...(note?.matches(NOTE) && !note.querySelector("input, select, textarea") ? [note] : [])] : [] };
  });
  return { rows, partial: entry.partial };
}

/**
 * Marks the card's rows with their level (writing only what changed) and returns the level the card itself shows
 * at, as the sample decides it: the lowest level among its leveled settings, so a card is on show exactly when one
 * of its rows is (coordinator, 2026-09-23). A card with none keeps the level its section gives it, and a card that
 * also holds a setting the sample does not level is never raised above its section by the others.
 */
export function levelRows(card, sectionLevel, mark) {
  const { rows, partial } = rowsIn(card);
  for (const { id, pieces, level } of rows) for (const node of pieces) {
    if (level === "regular") { if (node.dataset.sgRow) { delete node.dataset.level; delete node.dataset.sgRow; } continue; }
    mark(node, "level", level);
    mark(node, "sgRow", id); // which setting the piece belongs to: a row can be its words, its control and its note
  }
  /* shown: the rows found, which hide and show one by one; every: each leveled setting, found or not, for the count. */
  const found = { shown: rows.filter((one) => one.pieces.length), every: rows };
  if (!rows.length) return { level: sectionLevel, ...found };
  const lowest = rows.reduce((low, one) => (RANK[one.level] < RANK[low] ? one.level : low), "technical");
  return { level: partial && RANK[lowest] > RANK[sectionLevel] ? sectionLevel : lowest, ...found };
}

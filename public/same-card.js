/**
 * Q207: cards drawn again on a timer or a refresh (devices, people signing in, days off) swap the new card in only
 * when something changed, so an unchanged window stays quiet. A card is kept only when all three hold:
 *   - it was drawn from the same data (`drawnFrom`), so its buttons and saves act on what is saved now, never on an
 *     older copy;
 *   - its words, as drawn and before Settings adds its own marks to a placed card ("Applies to everything"), are the
 *     same, so a time drawn as "seen 3 minutes ago" still changes with the clock;
 *   - every box, choice and field shows the same value, so a box the owner clicked whose save was refused is drawn
 *     again from what is saved (NAS 11bf954).
 */
const drawn = new WeakMap();

/** Notes what a card was drawn from (any JSON-able value, the language included) and its words, for `swapCard`. */
export function drawnFrom(card, data) {
  drawn.set(card, JSON.stringify([data, typeof document === "undefined" ? "" : document.documentElement.lang, card.textContent]));
  return card;
}

const controls = (card) => [...card.querySelectorAll("input, select, textarea")];
const shown = (control) => (control.type === "checkbox" || control.type === "radio" ? String(control.checked) : control.value);

export function sameCard(old, next) {
  if (!old || !next || !drawn.has(old) || drawn.get(old) !== drawn.get(next)) return false;
  const before = controls(old), after = controls(next);
  return before.length === after.length && before.every((control, at) => shown(control) === shown(after[at]));
}

/** Puts `next` where `old` is (or at the end of `parent`), unless it is the same card. True when it was swapped in. */
export function swapCard(old, next, parent = document.body) {
  if (sameCard(old, next)) return false;
  if (old) old.replaceWith(next); else parent.append(next);
  return true;
}
